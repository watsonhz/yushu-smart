const db = require('./db');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

const DANGER_PATTERNS = [
  { pattern: /\brm\s+-rf\b/, risk: '高风险删除' },
  { pattern: /\bgit\s+push\s+--force\b/, risk: '强制推送' },
  { pattern: /\bDROP\s+TABLE\b/i, risk: '数据库操作' },
  { pattern: /\bchmod\s+.*777\b/, risk: '权限修改' },
  { pattern: /\bgit\s+reset\s+--hard\b/, risk: '硬重置' },
  { pattern: /\bDD\s+if=/i, risk: '磁盘操作' },
  { pattern: /\bmkfs\./i, risk: '格式化操作' },
  { pattern: /\b>\/dev\/sd/, risk: '设备写入' },
];

const SAFE_COMMANDS = [
  'npm test', 'npm run', 'npm install', 'node -e', 'node --version',
  'git status', 'git diff', 'git log', 'git add', 'git commit', 'git branch',
  'ls ', 'cat ', 'echo ', 'pwd', 'which ', 'mkdir ', 'touch ', 'cp ', 'mv ',
];

const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED-API-KEY]' },
  { pattern: /APP_SECRET\s*=\s*["']?[^"'\n]{8,}["']?/gi, replacement: 'APP_SECRET=[REDACTED]' },
  { pattern: /ANTHROPIC_API_KEY\s*=\s*["']?[^"'\n]{8,}["']?/gi, replacement: 'ANTHROPIC_API_KEY=[REDACTED]' },
  { pattern: /Bearer\s+[a-zA-Z0-9\-_.]{20,}/gi, replacement: 'Bearer [REDACTED]' },
];

function isDangerous(command) {
  for (const { pattern } of DANGER_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

function isWhiteListed(command) {
  return SAFE_COMMANDS.some(safe => command.trim().toLowerCase().startsWith(safe));
}

function confirmDangerousAction(message) {
  for (const { pattern, risk } of DANGER_PATTERNS) {
    if (pattern.test(message)) {
      return { isDangerous: true, risk };
    }
  }
  return { isDangerous: false };
}

function redactSecrets(text) {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function filterSensitive(text) {
  const envKeys = ['APP_SECRET', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
  let result = text;
  for (const key of envKeys) {
    const envVal = process.env[key];
    if (envVal && envVal.length > 4) {
      const escaped = envVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), `[${key}_REDACTED]`);
    }
  }
  return redactSecrets(result);
}

function isInProjectDir(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(PROJECT_ROOT);
}

function acquireFileLock(filePath, holder) {
  const absPath = path.resolve(filePath);
  if (!isInProjectDir(absPath)) return false;
  return db.acquireLock(absPath, holder, 30000);
}

function releaseFileLock(filePath, holder) {
  const absPath = path.resolve(filePath);
  db.releaseLock(absPath);
}

function releaseAllLocks(holder) {
  db.cleanupExpiredLocks();
}

function acquireChatLock(chatId, holder, ttlMs = 30000) {
  return db.acquireLock(`chat:${chatId}`, holder, ttlMs);
}

function releaseChatLock(chatId) {
  return db.releaseLock(`chat:${chatId}`);
}

function generateHeartbeat(agentRole) {
  return {
    role: agentRole,
    timestamp: Date.now(),
    pid: process.pid,
    memory: process.memoryUsage().rss,
  };
}

module.exports = {
  isDangerous, isWhiteListed, confirmDangerousAction,
  redactSecrets, filterSensitive,
  isInProjectDir, acquireFileLock, releaseFileLock, releaseAllLocks,
  acquireChatLock, releaseChatLock, generateHeartbeat,
};
