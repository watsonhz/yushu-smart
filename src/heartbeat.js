const { sendTextMessage } = require('./feishu');

class HeartbeatTracker {
  constructor() {
    this.tasks = new Map();
  }

  startTask(taskId, chatId) {
    this.tasks.set(taskId, {
      chatId,
      startedAt: Date.now(),
      sequence: 0,
      lastHeartbeat: 0,
      done: false,
    });
  }

  tick(taskId, stdoutLine) {
    const t = this.tasks.get(taskId);
    if (!t || t.done) return;

    const elapsed = (Date.now() - t.startedAt) / 1000;
    let interval;

    if (elapsed <= 15) return;
    else if (elapsed <= 60) interval = 15;
    else if (elapsed <= 300) interval = 30;
    else {
      this.sendHeartbeat(taskId, '⚠️ 任务耗时较长，可能需要人工介入');
      if (Date.now() - t.lastHeartbeat < 60000) return;
    }

    if (Date.now() - t.lastHeartbeat >= interval * 1000) {
      t.sequence++;
      const preview = stdoutLine
        ? `[#${t.sequence}] ${stdoutLine.substring(0, 200)}`
        : `[#${t.sequence}] 任务进行中...`;
      this.sendHeartbeat(taskId, preview);
      t.lastHeartbeat = Date.now();
    }
  }

  sendHeartbeat(taskId, message) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    sendTextMessage(t.chatId, message).catch(err => console.error('Heartbeat send failed:', err.message));
  }

  markDone(taskId, finalMessage) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.done = true;
    sendTextMessage(t.chatId, `[#${t.sequence + 1} 完成] ${finalMessage}`).catch(err => console.error('Heartbeat send failed:', err.message));
  }

  removeTask(taskId) {
    this.tasks.delete(taskId);
  }
}

const heartbeatTracker = new HeartbeatTracker();

module.exports = { heartbeatTracker };
