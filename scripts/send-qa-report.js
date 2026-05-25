/**
 * 将 QA 测试报告转发到飞书群聊
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require(path.join(__dirname, '..', 'src', 'db'));
const models = require(path.join(__dirname, '..', 'src', 'models-wp1'));
const { sendTextMessage } = require(path.join(__dirname, '..', 'src', 'feishu'));

db.init();
models.initModels(db.getDb());

const CHAT_ID = process.env.FEISHU_CHAT_ID || '';

async function main() {
  if (!CHAT_ID) {
    console.error('FEISHU_CHAT_ID 未配置，无法转发');
    process.exit(1);
  }

  // 分块发送（每条消息 < 5000 字符）
  const messages = [];

  // Message 1: 标题 + 概览
  messages.push(`📊 **Phase 2 QA 测试报告**

**日期**: 2026-05-25
**总用例**: 136 | **通过**: 136 | **失败**: 0
**API 端点**: 11/11 正常
**健康评分**: 100/100

✅ **Phase 2 系统质量验证通过！**`);

  // Message 2: 各模块结果
  messages.push(`📋 **测试结果明细**

1️⃣ 角色系统 (19/19 ✅) — 8 角色完整定义
2️⃣ 消息路由 (16/16 ✅) — @提及/关键词分类
3️⃣ 安全层 (10/10 ✅) — 危险命令/密钥脱敏
4️⃣ 心跳检测 (1/1 ✅) — 生命周期正常
5️⃣ 数据库 (4/4 ✅) — CRUD 正常
6️⃣ 上下文管理 (5/5 ✅) — Hot/Warm/Cold`);

  // Message 3: WP1 模块
  messages.push(`📋 **WP1 模块测试结果**

7️⃣ 任务系统 (6/6 ✅) — 命令解析/看板
8️⃣ 进程管理 (7/7 ✅) — Session/Prompt 构建
9️⃣ 调度引擎 (11/11 ✅) — FIFO/优先级/公平策略
🔟 资源池/节点/GPU (12/12 ✅) — CRUD + 心跳
1️⃣1️⃣ 调度任务 (13/13 ✅) — 状态流转/Spec/事件
1️⃣2️⃣ 审计日志+费用 (14/14 ✅) — Hash Chain/计费`);

  // Message 4: 改进项 + 存档位置
  messages.push(`📁 **报告存档**: \`docs/qa-report-phase2-2026-05-25.md\`
🛠️ **改进项**:
- 🟢 Express 404 建议加统一处理器
- ✅ scheduler 排序函数已导出 (已修复)
- ✅ buildFullPrompt 已导出 (已修复)

🚀 **结论**: 系统可进入 Phase 3 开发`);

  // 逐条发送
  for (const msg of messages) {
    await sendTextMessage(CHAT_ID, msg);
    console.log(`Sent: ${msg.substring(0, 60)}...`);
    // 避免飞书 API 限流
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('✅ 全部消息已发送到飞书群');
}

main().catch(err => {
  console.error('发送失败:', err.message);
  process.exit(1);
});
