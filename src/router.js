const Anthropic = require('@anthropic-ai/sdk').default;
const { getRole, getAllRoles, ROLES } = require('./roles');
const { redactSecrets } = require('./security');

let anthropic = null;
try {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic',
  });
} catch (e) {
  console.warn('Anthropic SDK init failed, intent classification will use keywords only:', e.message);
}

const TASK_VERBS = [
  '做', '实现', '开发', '搭建', '写', '创建', '修改', '改', '加', '添加',
  'build', 'implement', 'create', 'develop', 'make', 'add', 'fix', 'change',
];

function parseAtMentions(text) {
  const roleMap = {
    'ceo': 'ceo', 'CEO': 'ceo', '@ceo': 'ceo', '@CEO': 'ceo',
    'pm': 'pm', 'PM': 'pm', '@pm': 'pm', '@PM': 'pm',
    '架构师': 'architect', 'architect': 'architect',
    '后端': 'backend', 'backend': 'backend', '前端': 'frontend', 'frontend': 'frontend',
    'qa': 'qa', 'QA': 'qa',
    '审查': 'reviewer', 'reviewer': 'reviewer', 'review': 'reviewer',
    '测试': 'tester', 'tester': 'tester', '测试工程师': 'tester',
    '助手': 'assistant',
  };

  const match = text.match(/@(\S+)/g);
  if (!match) return [];
  return match.map(m => {
    const name = m.slice(1);
    return roleMap[name] || roleMap[name.toLowerCase()] || null;
  }).filter(Boolean);
}

function hasTaskIntent(text) {
  const lower = text.toLowerCase();
  return TASK_VERBS.some(v => lower.includes(v));
}

function isSystemCommand(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('/summary') || trimmed.startsWith('/status');
}

function determineEventType(text, isDangerReply) {
  if (isDangerReply) return 'system';
  if (isSystemCommand(text)) return 'system';
  if (hasTaskIntent(text)) return 'task';
  return 'discussion';
}

function classifyByKeywords(message) {
  const lowerMsg = message.toLowerCase();
  for (const id of ['ceo', 'pm', 'architect', 'backend', 'frontend', 'qa', 'reviewer', 'tester']) {
    const role = ROLES[id];
    if (role.triggers?.some(t => lowerMsg.includes(t.toLowerCase()))) {
      return id;
    }
  }
  return null;
}

async function classifyIntent(message) {
  if (!anthropic) return classifyByKeywords(message);

  try {
    const roleList = getAllRoles().map(r => `${r.id}(${r.name})`).join(', ');
    const msg = await anthropic.messages.create({
      model: 'deepseek-v4-flash',
      max_tokens: 20,
      temperature: 0,
      system: `你是一个消息分类器。分析用户消息，判断最适合回复的团队成员角色。可选角色：${roleList}。如果消息是闲聊或简单提问，返回 null。只返回角色ID或null。`,
      messages: [{ role: 'user', content: message.substring(0, 2000) }],
    });
    const result = (msg.content[0].text || '').trim().toLowerCase();
    if (result === 'null' || !ROLES[result]) return null;
    return result;
  } catch {
    return classifyByKeywords(message);
  }
}

async function routeMessage(message, chatId) {
  const mentionedRoles = parseAtMentions(message);

  if (mentionedRoles.includes('assistant')) {
    return {
      role: 'assistant',
      systemPrompt: null,
      routingReason: '@助手 被显式提及',
      eventType: determineEventType(message, false),
    };
  }

  if (mentionedRoles.length === 1) {
    const role = getRole(mentionedRoles[0]);
    return {
      role: mentionedRoles[0],
      systemPrompt: role?.systemPrompt || null,
      routingReason: `@${mentionedRoles[0]} 被显式提及`,
      eventType: determineEventType(message, false),
    };
  }

  if (mentionedRoles.length > 1) {
    const role = getRole(mentionedRoles[0]);
    return {
      role: mentionedRoles[0],
      systemPrompt: role?.systemPrompt || null,
      routingReason: `多@提及，默认路由到 ${mentionedRoles[0]}`,
      eventType: determineEventType(message, false),
    };
  }

  // Try API-based intent classification first, fall back to keywords
  const apiMatch = await classifyIntent(message);
  if (apiMatch) {
    const role = getRole(apiMatch);
    return {
      role: apiMatch,
      systemPrompt: role?.systemPrompt || null,
      routingReason: `意图分类 → ${role?.name || apiMatch}`,
      eventType: determineEventType(message, false),
    };
  }

  const keywordMatch = classifyByKeywords(message);
  if (keywordMatch) {
    const role = getRole(keywordMatch);
    return {
      role: keywordMatch,
      systemPrompt: role?.systemPrompt || null,
      routingReason: `关键词匹配触发 ${role?.name || keywordMatch}`,
      eventType: determineEventType(message, false),
    };
  }

  return {
    role: 'assistant',
    systemPrompt: null,
    routingReason: '未匹配特定角色，回退到通用助手',
    eventType: determineEventType(message, false),
  };
}

function getDefaultSystemPrompt() {
  return `你是禹枢大模型管理平台 (yushu smart) 的 AI 助手，同时也是一个自治开发团队的管理者。

你的团队包含以下8个专业角色，你可以通过以下方式调用：

👔 **CEO** - 统筹协调与决策 (@CEO)
📋 **PM** - 需求分析与任务拆解 (@PM)
🏗️ **Architect** - 系统架构与技术选型 (@架构师 / @architect)
⚙️ **Backend Developer** - 后端开发与 API (@后端 / @backend)
🎨 **Frontend Developer** - 前端开发与 UI (@前端 / @frontend)
🔍 **QA Engineer** - 质量保障与测试 (@QA)
👁️ **Code Reviewer** - 代码审查与安全审计 (@审查 / @review)
🧪 **Test Engineer** - 自动化测试 (@测试工程师 / @tester)

用户可以通过 @角色名 直接与对应角色对话。
当用户提出的任务需要其他角色参与时，你可以建议调用相应的专家。

当前处于 **Phase 4 多角色自治团队** 阶段。
请用简洁、友好、专业的方式回答问题。如果问题涉及代码，请给出清晰可用的代码示例。回答使用中文。`;
}

module.exports = {
  routeMessage, getDefaultSystemPrompt,
  parseAtMentions, hasTaskIntent, isSystemCommand, determineEventType,
  classifyIntent, classifyByKeywords,
};
