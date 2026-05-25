const db = require('./db');

function buildContext(chatId, agentRole) {
  const allMessages = db.getRecentMessages(chatId, 50);
  if (allMessages.length === 0) return { hot: '', warm: '', cold: '' };

  const segments = { hot: [], warm: [], cold: [] };

  let roleChangeCount = 0;
  let topicSwitchCount = 0;
  let prevRole = null;
  let prevTopic = null;

  function guessTopic(msg) {
    const lowers = msg.toLowerCase();
    if (lowers.includes('task') || lowers.includes('任务')) return 'task';
    if (lowers.includes('bug') || lowers.includes('fix')) return 'bug';
    if (lowers.includes('review') || lowers.includes('审查')) return 'review';
    if (lowers.includes('design') || lowers.includes('设计')) return 'design';
    if (lowers.includes('architecture') || lowers.includes('架构')) return 'architecture';
    return 'general';
  }

  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    const topic = guessTopic(msg.content);

    if (prevRole && msg.role !== prevRole) roleChangeCount++;
    if (prevTopic && topic !== prevTopic) topicSwitchCount++;

    let tier;
    if (segments.hot.length < 8) {
      tier = 'hot';
    } else if (roleChangeCount < 3 && topicSwitchCount < 2 && segments.warm.length < 16) {
      tier = 'warm';
    } else {
      tier = 'cold';
    }

    segments[tier].unshift(msg);

    prevRole = msg.role;
    prevTopic = topic;
  }

  function format(msgs) {
    return msgs.map(m => `[${m.role === 'assistant' ? agentRole : '用户'}]: ${m.content}`).join('\n');
  }

  return {
    hot: format(segments.hot),
    warm: format(segments.warm),
    cold: format(segments.cold),
  };
}

function summarizeWarm(warmContext) {
  if (!warmContext || warmContext.length < 100) return warmContext;
  return `[摘要-近期讨论]\n${warmContext.substring(0, 1000)}${warmContext.length > 1000 ? '\n...(已截断)' : ''}`;
}

function summarizeCold(coldContext) {
  if (!coldContext || coldContext.length < 100) return coldContext;
  return `[摘要-更早的讨论: ${coldContext.split('\n').length}条消息]`;
}

module.exports = { buildContext, summarizeWarm, summarizeCold };
