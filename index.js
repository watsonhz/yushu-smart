require('dotenv').config();

const express = require('express');
const log = require('./src/logger');
const db = require('./src/db');
const models = require('./src/models-wp1');
const models4 = require('./src/models-wp4');
const wp1Routes = require('./src/routes-wp1');
const wp4Routes = require('./src/routes-wp4');
const scheduler = require('./src/scheduler');
const { sendTextMessage } = require('./src/feishu');
const { routeMessage, getDefaultSystemPrompt } = require('./src/router');
const { getOrSpawnAgent, startIdleReclaimer, killAllProcesses, getActiveProcessCount, recoverFromCrash } = require('./src/process-manager');
const { getAllRoles, getRole } = require('./src/roles');
const { processTaskCommand, formatTaskBoard, formatMyTasks } = require('./src/tasks');
const { acquireChatLock, releaseChatLock } = require('./src/security');

db.init();
// 初始化 WP1 数据模型（调度引擎 + 审计日志）
models.initModels(db.getDb());
// 初始化 WP4 数据模型（交付与部署）
models4.initModels(db.getDb());

const app = express();
app.use(express.json());

// 全局 JSON 解析错误处理 — 返回 JSON 而非 HTML 栈信息
app.use((err, req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON', code: 'BAD_REQUEST' });
  }
  _next(err);
});

const CHAT_ID = process.env.FEISHU_CHAT_ID || '';

// ── Special Commands ──

async function handleSpecialCommands(chatId, message) {
  const lower = message.trim().toLowerCase();

  if (lower.startsWith('/task:') || lower.startsWith('/task：')) {
    const tasks = processTaskCommand(chatId, message, 'pm');
    if (tasks && tasks.length > 0) {
      const summary = tasks.map(t =>
        `✅ 已创建任务: **${t.title}** [${t.priority}]${t.assignedRole ? ` → @${t.assignedRole}` : ''}`
      ).join('\n');
      await sendTextMessage(chatId, `[PM] ${summary}\n\n${formatTaskBoard(chatId)}`);
    }
    return true;
  }

  if (lower === '/board' || lower === '/看板') {
    const board = formatTaskBoard(chatId);
    await sendTextMessage(chatId, `[PM] ${board}`);
    return true;
  }

  if (lower === '/mytasks' || lower === '/我的任务') {
    const board = formatMyTasks(chatId, 'all');
    await sendTextMessage(chatId, board || '当前没有分配给任何角色的任务。');
    return true;
  }

  if (lower === '/roles' || lower === '/团队' || lower === '/team') {
    const roles = getAllRoles();
    const lines = ['**自治开发团队** (Phase 2)\n'];
    for (const r of roles) {
      lines.push(`${r.emoji} **${r.name}** - ${r.description}`);
      lines.push(`  触发: ${r.triggers?.slice(0, 3).join(', ') || '@' + r.name}`);
    }
    lines.push('\n使用 @角色名 直接对话，或用 /board 查看任务看板。');
    await sendTextMessage(chatId, lines.join('\n'));
    return true;
  }

  if (lower === '/status' || lower === '/状态') {
    const count = getActiveProcessCount();
    const up = Math.floor(process.uptime());
    await sendTextMessage(chatId,
      `**系统状态**\n` +
      `阶段: Phase 4\n` +
      `活跃进程: ${count}\n` +
      `运行时间: ${Math.floor(up / 60)}分${up % 60}秒\n` +
      `任务看板: /board`
    );
    return true;
  }

  return false;
}

// ── Webhook Endpoint ──

app.post('/feishu/event', async (req, res) => {
  try {
    const body = req.body;

    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    res.json({ code: 0 });

    if (body.header?.event_type === 'im.message.receive_v1') {
      const event = body.event;
      const message = event.message;

      if (message.message_type !== 'text') return;

      let userMessage = '';
      try {
        userMessage = JSON.parse(message.content).text || '';
      } catch {
        userMessage = message.content || '';
      }

      if (!userMessage.trim()) return;

      const chatId = message.chat_id;
      const messageId = message.message_id;

      if (db.messageExists(messageId)) return;

      db.insertMessage(messageId, chatId, 'user', userMessage);
      log.info(`Message received`, { chatId, messageId });

      const isSpecial = await handleSpecialCommands(chatId, userMessage);
      if (isSpecial) return;

      if (!acquireChatLock(chatId, 'event-handler', 30000)) {
        log.warn(`Chat locked, message queued`, { chatId });
        return;
      }

      try {
        const { role, systemPrompt, routingReason } = await routeMessage(userMessage, chatId);
        const effectivePrompt = systemPrompt || getDefaultSystemPrompt();

        log.info(`Routing decision`, { chatId, routingReason, role });

        getOrSpawnAgent(chatId, role, effectivePrompt, userMessage, messageId)
          .then((reply) => {
            if (reply) {
              db.insertMessage(`reply-${messageId}`, chatId, role, reply);
            }
          })
          .catch((err) => {
            log.error(`Agent error`, { role, error: err.message });
            sendTextMessage(chatId, `[${role}] 处理消息时出错：${err.message}`).catch(e => log.error('sendTextMessage failed', { error: e.message }));
          });
      } finally {
        releaseChatLock(chatId);
      }
    }
  } catch (err) {
    log.error('Event processing error', { error: err.message, stack: err.stack });
  }
});

// ── WP1 API Routes ──

app.use('/api/v1', wp1Routes);

// ── WP4 API Routes ──

app.use('/api/v1', wp4Routes);

// ── Health Endpoints ──

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    phase: 4,
    version: '4.0.0',
    activeProcesses: getActiveProcessCount(),
    uptime: process.uptime(),
    model: 'deepseek-v4-flash',
    wp4: { environments: true },
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/roles', (req, res) => {
  res.json({
    roles: getAllRoles().map(r => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      description: r.description,
    })),
  });
});

// ── Global Error Handler ──

app.use((err, req, res, next) => {
  log.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ──

startIdleReclaimer();
scheduler.startScheduler();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  log.info(`Server started`, { port: PORT, phase: 4 });
  console.log(`禹枢大模型管理平台 (yushu smart): http://localhost:${PORT}/health`);

  if (CHAT_ID) {
    setTimeout(() => recoverFromCrash(CHAT_ID), 2000);
  }
});

// ── Graceful Shutdown ──

process.on('SIGTERM', () => {
  log.info('Shutting down...');
  killAllProcesses();
  scheduler.stopScheduler();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log.info('Shutting down...');
  killAllProcesses();
  scheduler.stopScheduler();
  server.close(() => process.exit(0));
});
