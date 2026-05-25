const axios = require('axios');

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

let token = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (token && Date.now() < tokenExpiry) return token;
  const res = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: APP_ID, app_secret: APP_SECRET },
    { headers: { 'Content-Type': 'application/json' } }
  );
  token = res.data.tenant_access_token;
  tokenExpiry = Date.now() + (res.data.expire - 300) * 1000;
  return token;
}

async function sendTextMessage(chatId, text) {
  try {
    const t = await getAccessToken();
    const content = JSON.stringify({ text: String(text).substring(0, 5000) });
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'text', content },
      { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendTextMessage error:', err.message);
  }
}

async function sendCardMessage(chatId, header, bodyElements) {
  try {
    const t = await getAccessToken();
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: header }, template: 'blue' },
      elements: bodyElements,
    };
    const content = JSON.stringify(card);
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content },
      { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendCardMessage error:', err.message);
    const fallback = bodyElements.map(e => e.content || e.tag === 'hr' ? '---' : '').filter(Boolean).join('\n');
    await sendTextMessage(chatId, `[${header}]\n${fallback}`);
  }
}

async function sendDangerConfirmationCard(chatId, roleName, command) {
  const cardElements = [
    {
      tag: 'markdown',
      content: `⚠️ **${roleName}** 想执行以下操作：\n\`\`\`\n${command}\n\`\`\`\n请确认是否允许执行。`,
    },
    { tag: 'hr' },
  ];
  await sendCardMessage(chatId, '危险操作确认', cardElements);
}

async function replyToMessage(chatId, _messageId, text, roleName) {
  const prefix = roleName ? `[${roleName}] ` : '';
  await sendTextMessage(chatId, `${prefix}${text}`);
}

module.exports = {
  getAccessToken, sendTextMessage, sendCardMessage,
  sendDangerConfirmationCard, replyToMessage,
};
