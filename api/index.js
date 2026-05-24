// ============================================
//  飞书机器人 + Claude AI 集成服务
//  功能：接收飞书消息，调用Claude API，返回回复
// ============================================

// 1. 加载环境变量
require('dotenv').config();

// 2. 引入依赖
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk').default;

// 3. 初始化
const app = express();
app.use(express.json());  // 解析JSON请求体

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://api.deepseek.com/anthropic',
});

// 飞书应用凭证
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// ═══════════════════════════════════════
// 工具函数：获取飞书访问令牌
// ═══════════════════════════════════════
let tenantAccessToken = null;
let tokenExpireTime = 0;

async function getTenantAccessToken() {
  // 如果缓存的token还没过期，直接返回
  if (tenantAccessToken && Date.now() < tokenExpireTime) {
    return tenantAccessToken;
  }

  try {
    const response = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: APP_ID,
        app_secret: APP_SECRET,
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    tenantAccessToken = response.data.tenant_access_token;
    // 提前5分钟过期，确保不会用到过期的token
    tokenExpireTime = Date.now() + (response.data.expire - 300) * 1000;
    return tenantAccessToken;
  } catch (error) {
    console.error('获取飞书token失败:', error.response?.data || error.message);
    throw error;
  }
}

// ═══════════════════════════════════════
// 工具函数：调用Claude API
// ═══════════════════════════════════════
async function askClaude(userMessage) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',  // 可以换成 claude-haiku-4-5 节省费用
      max_tokens: 4000,
      system: '你是一个飞书群聊中的AI助手，名字叫Claude助手。请用简洁、友好、专业的方式回答问题。如果问题涉及代码，请给出清晰可用的代码示例。回答使用中文。',
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    return msg.content[0].text;
  } catch (error) {
    console.error('Claude API调用失败:', error.message);
    return '抱歉，AI服务暂时不可用，请稍后重试。错误信息：' + error.message;
  }
}

// ═══════════════════════════════════════
// 核心：处理飞书消息（发给机器人）
// ═══════════════════════════════════════
async function sendMessageToChat(chatId, messageId, replyContent) {
  try {
    const token = await getTenantAccessToken();

    // 构造飞书消息卡片
    const cardContent = JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Claude 助手' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: replyContent,
        },
        {
          tag: 'hr',
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: 'Powered by Claude AI | 回复消息可继续追问' },
          ],
        },
      ],
    });

    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      {
        receive_id: chatId,
        msg_type: 'interactive',
        content: cardContent,
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('消息发送成功');
  } catch (error) {
    // 如果卡片发送失败，尝试发送纯文本
    console.error('卡片消息发送失败，尝试纯文本:', error.response?.data || error.message);
    try {
      const token = await getTenantAccessToken();
      const textContent = JSON.stringify({
        text: replyContent.substring(0, 5000), // 飞书文本消息限制5000字
      });
      await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/messages',
        {
          receive_id: chatId,
          msg_type: 'text',
          content: textContent,
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (textError) {
      console.error('纯文本消息也发送失败:', textError.response?.data || textError.message);
    }
  }
}

// ═══════════════════════════════════════
// 飞书事件回调接口
// ═══════════════════════════════════════
app.post('/feishu/event', async (req, res) => {
  try {
    const body = req.body;

    // ---- URL验证（飞书配置事件地址时的校验） ----
    if (body.type === 'url_verification') {
      console.log('收到URL验证请求');
      return res.json({ challenge: body.challenge });
    }

    // ---- 处理消息事件 ----
    if (body.header?.event_type === 'im.message.receive_v1') {
      const event = body.event;
      const message = event.message;

      // 只处理文本消息（忽略图片、文件等消息类型）
      if (message.message_type !== 'text') {
        console.log('忽略非文本消息:', message.message_type);
        return res.json({ code: 0 });
      }

      // 提取消息文本（飞书的文本消息内容是JSON格式）
      let userMessage = '';
      try {
        const content = JSON.parse(message.content);
        userMessage = content.text || '';
      } catch {
        userMessage = message.content || '';
      }

      console.log('收到用户消息:', userMessage);

      // 获取发送者信息和群聊ID
      const chatId = message.chat_id;
      const messageId = message.message_id;

      if (!userMessage.trim()) {
        console.log('消息为空，不处理');
        return res.json({ code: 0 });
      }

      // 调用Claude获取回复
      console.log('正在调用Claude API...');
      const reply = await askClaude(userMessage);

      // 将Claude的回复发送到飞书
      console.log('正在发送回复...');
      await sendMessageToChat(chatId, messageId, reply);
    }

    // 快速返回200，避免飞书重复发送（必须3秒内返回）
    res.json({ code: 0 });
  } catch (error) {
    console.error('处理事件时出错:', error);
    res.json({ code: 0 }); // 即使出错也返回200，防止飞书无限重试
  }
});

// ═══════════════════════════════════════
// 健康检查接口
// ═══════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    claude: 'connected',
  });
});

// Vercel Serverless 导出格式
module.exports = app;
