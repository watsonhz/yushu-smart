const { spawn } = require('child_process');
const log = require('./logger');
const db = require('./db');
const { sendTextMessage } = require('./feishu');
const { buildContext, summarizeWarm, summarizeCold } = require('./context');
const { filterSensitive, confirmDangerousAction, releaseAllLocks } = require('./security');
const { heartbeatTracker } = require('./heartbeat');

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;
const STUCK_TIMEOUT_S = 120;

const activeProcesses = new Map();

function buildFullPrompt(chatId, roleName, roleSystemPrompt, userMessage) {
  const rolePrompt = roleSystemPrompt
    || require('./router').getDefaultSystemPrompt();

  const ctx = buildContext(chatId, roleName);
  const parts = [rolePrompt];

  if (ctx.cold) {
    parts.push(`\n---\n历史背景: ${summarizeCold(ctx.cold)}\n---`);
  }
  if (ctx.warm) {
    parts.push(`\n---\n近期讨论: ${summarizeWarm(ctx.warm)}\n---`);
  }
  if (ctx.hot) {
    parts.push(`\n---\n最近的对话:\n${ctx.hot}\n---`);
  }

  parts.push(`\n当前用户消息: ${userMessage}`);
  parts.push('\n请简洁、直接地回答。尽量在2000字以内。');

  return parts.join('\n');
}

function spawnAgent(chatId, roleName, roleSystemPrompt, userMessage, messageId) {
  return new Promise((resolve) => {
    const sessionId = `${chatId}:${roleName}`;
    db.touchSession(sessionId);
    db.updateSessionStatus(sessionId, 'running');

    const prompt = buildFullPrompt(chatId, roleName, roleSystemPrompt, userMessage);
    const filtered = filterSensitive(prompt);

    heartbeatTracker.startTask(sessionId, chatId);

    const model = process.env.CLAUDE_MODEL || 'sonnet';
    const child = spawn('claude', [
      '--print',
      '--model', model,
    ], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt via stdin (prevents argument injection)
    child.stdin.write(filtered);
    child.stdin.end();

    activeProcesses.set(sessionId, child);

    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      activeProcesses.delete(sessionId);
      db.updateSessionStatus(sessionId, 'idle');
      heartbeatTracker.removeTask(sessionId);
      sendTextMessage(chatId, `[${roleName}] 任务执行超时（5分钟），请重试或简化任务。`).catch(err => log.error('sendTextMessage failed', { error: err.message }));
      resolve(null);
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      const line = data.toString();
      output += line;
      heartbeatTracker.tick(sessionId, line);
    });

    child.stderr.on('data', (data) => {
      console.error(`[${roleName} stderr]`, data.toString());
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      activeProcesses.delete(sessionId);
      db.updateSessionStatus(sessionId, 'idle');

      const result = filterSensitive(output.trim());
      if (result) {
        heartbeatTracker.markDone(sessionId, result.substring(0, 300));
        sendTextMessage(chatId, `[${roleName}] ${result}`).catch(err => log.error('sendTextMessage failed', { error: err.message }));
      } else {
        heartbeatTracker.removeTask(sessionId);
        sendTextMessage(chatId, `[${roleName}] 抱歉，处理过程中出现问题，请稍后重试。`).catch(err => log.error('sendTextMessage failed', { error: err.message }));
      }
      resolve(result);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      activeProcesses.delete(sessionId);
      db.updateSessionStatus(sessionId, 'crashed');
      heartbeatTracker.removeTask(sessionId);
      releaseAllLocks(sessionId);
      console.error(`[${roleName} spawn error]`, err.message);
      sendTextMessage(chatId, `[${roleName}] 进程启动失败：${err.message}`).catch(err => log.error('sendTextMessage failed', { error: err.message }));
      resolve(null);
    });
  });
}

function ensureSession(chatId, roleName) {
  const sessionId = `${chatId}:${roleName}`;
  const existing = db.getSession(sessionId);
  if (!existing) {
    db.createSession(sessionId, chatId, roleName);
  } else {
    db.touchSession(sessionId);
  }
  return sessionId;
}

function getOrSpawnAgent(chatId, roleName, roleSystemPrompt, userMessage, messageId) {
  ensureSession(chatId, roleName);

  const dangerous = confirmDangerousAction(userMessage);
  if (dangerous.isDangerous) {
    sendTextMessage(chatId,
      `⚠️ 检测到${dangerous.risk}操作：\n` +
      '为安全考虑，此操作需要你在群聊中回复 **确认执行** 来继续。'
    ).catch(err => log.error('sendTextMessage failed', { error: err.message }));
    return Promise.resolve(null);
  }

  return spawnAgent(chatId, roleName, roleSystemPrompt, userMessage, messageId);
}

function startIdleReclaimer() {
  setInterval(() => {
    const idleSessions = db.getIdleSessions(IDLE_TIMEOUT_MS);
    for (const s of idleSessions) {
      const child = activeProcesses.get(s.id);
      if (child) {
        child.kill('SIGTERM');
        activeProcesses.delete(s.id);
      }
      db.updateSessionStatus(s.id, 'recycled');
      releaseAllLocks(s.id);
      console.log(`[reclaimer] Recycled idle session: ${s.id}`);
    }
    db.cleanupExpiredLocks();
  }, HEALTH_CHECK_INTERVAL_MS);
}

function healthCheck() {
  for (const [sessionId, child] of activeProcesses) {
    try {
      if (child.exitCode !== null) {
        activeProcesses.delete(sessionId);
        db.updateSessionStatus(sessionId, 'crashed');
        releaseAllLocks(sessionId);
        console.log(`[health] Dead process cleaned: ${sessionId}`);
      }
    } catch {}
  }
}

function recoverFromCrash(chatId) {
  const activeSessions = db.getActiveSessions(chatId);
  const pendingTasks = db.getTasks(chatId, 'pending');

  for (const s of activeSessions) {
    const child = activeProcesses.get(s.id);
    if (child) {
      child.kill('SIGTERM');
      activeProcesses.delete(s.id);
    }
    db.updateSessionStatus(s.id, 'inactive');
    releaseAllLocks(s.id);
  }

  if (activeSessions.length > 0 || pendingTasks.length > 0) {
    const inProgress = pendingTasks.filter(t => t.status === 'in_progress').length;
    sendTextMessage(chatId,
      `🔄 团队已恢复启动。待处理任务：${pendingTasks.length}个，其中${inProgress}个进行中。`
    ).catch(err => log.error('sendTextMessage failed', { error: err.message }));
  }
}

function getActiveProcessCount() {
  return activeProcesses.size;
}

function killAllProcesses() {
  for (const [id, child] of activeProcesses) {
    child.kill('SIGTERM');
    releaseAllLocks(id);
    console.log(`[shutdown] Killed process: ${id}`);
  }
  activeProcesses.clear();
}

module.exports = {
  getOrSpawnAgent, ensureSession, startIdleReclaimer,
  getActiveProcessCount, killAllProcesses,
  healthCheck, recoverFromCrash,
  buildFullPrompt,
};
