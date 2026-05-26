const db = require('./db');

function buildContext(chatId, agentRole) {
  const allMessages = db.getRecentMessages(chatId, 50);
  if (allMessages.length === 0) return { hot: '', warm: '', cold: '' };

  // Split by recency: newest 8 → hot, next 16 → warm, rest → cold
  const hotMsgs = allMessages.slice(-8);
  const warmMsgs = allMessages.slice(-24, -8);
  const coldMsgs = allMessages.slice(0, -24);

  function format(msgs) {
    return msgs.map(m => `[${m.role === 'assistant' ? agentRole : '用户'}]: ${m.content}`).join('\n');
  }

  return {
    hot: format(hotMsgs),
    warm: format(warmMsgs),
    cold: format(coldMsgs),
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
