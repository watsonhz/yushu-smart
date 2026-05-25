const db = require('./db');
const { sendTextMessage } = require('./feishu');

function parseTaskCommand(message) {
  const lines = message.split('\n');
  const tasks = [];

  for (const line of lines) {
    const match = line.match(/\/task:\s*(.+?)\s*\|\s*优先级:\s*(high|medium|low)\s*(?:\|\s*依赖:\s*(.+?))?\s*(?:\|\s*负责人:\s*(.+?))?\s*$/i);
    if (match) {
      tasks.push({
        title: match[1].trim(),
        priority: match[2].trim().toLowerCase(),
        dependsOn: match[3] ? match[3].trim() : null,
        assignedRole: match[4] ? match[4].trim() : null,
      });
    }
  }

  return tasks;
}

function processTaskCommand(chatId, message, creatorRole) {
  const tasks = parseTaskCommand(message);

  if (tasks.length === 0) return null;

  const created = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const taskId = `task-${chatId}-${Date.now()}-${i}`;
    db.createTask(taskId, chatId, t.title, null, t.priority, t.dependsOn, creatorRole);

    if (t.assignedRole) {
      db.assignTask(taskId, t.assignedRole);
    }

    created.push({ id: taskId, ...t });
  }

  return created;
}

function formatTaskBoard(chatId) {
  const tasks = db.getTasks(chatId);

  if (tasks.length === 0) return '当前没有任务。';

  const statusEmoji = { pending: '⏳', in_progress: '🔄', completed: '✅', blocked: '🚫' };
  const priorityMark = { high: '🔴', medium: '🟡', low: '🟢' };

  const lines = ['📋 **任务看板**\n'];
  for (const t of tasks) {
    const emoji = statusEmoji[t.status] || '❓';
    const prio = priorityMark[t.priority] || '';
    const assignee = t.assigned_role ? ` → @${t.assigned_role}` : '';
    const dep = t.depends_on ? ` (依赖: ${t.depends_on})` : '';
    lines.push(`${emoji} ${prio} **${t.title}**${assignee}${dep}`);
  }

  return lines.join('\n');
}

function formatMyTasks(chatId, roleName) {
  const allTasks = db.getTasks(chatId);
  const myTasks = allTasks.filter(t => t.assigned_role === roleName);

  if (myTasks.length === 0) return `当前没有分配给 ${roleName} 的任务。`;

  const lines = [`📋 **${roleName} 的任务**\n`];
  for (const t of myTasks) {
    const emoji = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳';
    lines.push(`${emoji} **${t.title}**`);
  }

  return lines.join('\n');
}

function autoClaimTask(chatId, roleName) {
  const ready = db.getReadyTasks(chatId);
  const yours = ready.filter(t => t.assigned_role === roleName);

  if (yours.length > 0) return yours;

  const unassigned = ready.filter(t => !t.assigned_role);
  if (unassigned.length > 0) {
    const task = unassigned[0];
    db.assignTask(task.id, roleName);
    return [task];
  }

  return [];
}

module.exports = {
  processTaskCommand, formatTaskBoard, formatMyTasks, autoClaimTask,
};
