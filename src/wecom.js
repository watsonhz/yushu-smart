const axios = require('axios');
const crypto = require('crypto');

const WECOM_BOT_TOKEN = process.env.WECOM_BOT_TOKEN || '';
const WECOM_BOT_ENCODING_AES_KEY = process.env.WECOM_BOT_ENCODING_AES_KEY || '';

function verifySignature(timestamp, nonce, echostr, msgSignature) {
  if (!WECOM_BOT_TOKEN) return null;
  const arr = [WECOM_BOT_TOKEN, timestamp, nonce, echostr].sort();
  const sign = crypto.createHash('sha1').update(arr.join('')).digest('hex');
  return sign === msgSignature;
}

function decryptMessage(encrypted) {
  if (!WECOM_BOT_ENCODING_AES_KEY) return null;
  try {
    const aesKey = Buffer.from(WECOM_BOT_ENCODING_AES_KEY + '=', 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
    // Remove PKCS7 padding
    const padLen = decrypted[decrypted.length - 1];
    decrypted = decrypted.subarray(0, decrypted.length - padLen);
    // Skip 16 bytes random + 4 bytes msg_len
    const content = decrypted.subarray(20).toString('utf8');
    // Remove trailing chars after the receiveid
    const receiveid = process.env.WECOM_CORP_ID || '';
    const idx = content.lastIndexOf(receiveid);
    return idx > -1 ? content.substring(0, idx) : content;
  } catch {
    return null;
  }
}

async function sendTextMessage(webhookUrl, text) {
  try {
    const content = String(text).substring(0, 5000);
    await axios.post(webhookUrl, {
      msgtype: 'text',
      text: { content },
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  } catch (err) {
    console.error('WeCom sendTextMessage error:', err.message);
  }
}

async function sendMarkdownMessage(webhookUrl, content) {
  try {
    await axios.post(webhookUrl, {
      msgtype: 'markdown',
      markdown: { content: String(content).substring(0, 4096) },
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
  } catch (err) {
    console.error('WeCom sendMarkdownMessage error:', err.message);
  }
}

function parseMessage(body) {
  if (body.msgtype === 'text' && body.text?.content) {
    return {
      chatId: body.chatid || body.chatId || '',
      messageId: body.msgid || body.msgId || `wecom-${Date.now()}`,
      content: body.text.content.trim(),
      fromUser: body.from?.userid || body.from?.userId || '',
    };
  }
  return null;
}

module.exports = {
  verifySignature, decryptMessage,
  sendTextMessage, sendMarkdownMessage,
  parseMessage,
};
