const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '.data', 'logs');
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

let logStream = null;

function ensureStream() {
  if (logStream) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  logStream = fs.createWriteStream(path.join(LOG_DIR, `app-${date}.log`), { flags: 'a' });
}

function format(level, message, data) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level}] ${message}`;
  if (data !== undefined) {
    try {
      return base + ' ' + JSON.stringify(data);
    } catch {
      return base + ' ' + String(data);
    }
  }
  return base;
}

function write(level, message, data) {
  if (LEVELS[level] < currentLevel) return;
  ensureStream();
  const line = format(level, message, data);
  logStream.write(line + '\n');
  if (LEVELS[level] >= LEVELS.warn) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = {
  debug: (msg, data) => write('debug', msg, data),
  info: (msg, data) => write('info', msg, data),
  warn: (msg, data) => write('warn', msg, data),
  error: (msg, data) => write('error', msg, data),
};
