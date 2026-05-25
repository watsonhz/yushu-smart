#!/bin/bash
# Auto-start script for Feishu Multi-Agent Team
# Launched by ~/Library/LaunchAgents/com.feishu-claude-bot.plist on login

PROJECT_DIR="/Users/hziotdev/Desktop/feishu-claude-bot"
LOG_DIR="$PROJECT_DIR/.data/logs"
mkdir -p "$LOG_DIR"

# 1. Kill any old processes
lsof -ti:3032 2>/dev/null | xargs kill -9 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# 2. Start Node.js server
cd "$PROJECT_DIR"
node index.js >> "$LOG_DIR/server.log" 2>&1 &
sleep 2

# 3. Start Cloudflare tunnel and capture URL
cloudflared tunnel --url http://localhost:3032 > "$LOG_DIR/tunnel.log" 2>&1 &
sleep 6

# 4. Extract tunnel hostname
TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$LOG_DIR/tunnel.log" | tail -1)
echo "$TUNNEL_URL" > "$PROJECT_DIR/.data/current-tunnel-url.txt"

# 5. Log startup
echo "[$(date)] Server started on :3032, tunnel: $TUNNEL_URL" >> "$LOG_DIR/startup.log"

# 6. Notify: save URL + send to Feishu group
if [ -n "$TUNNEL_URL" ]; then
  echo "Tunnel ready: $TUNNEL_URL"
  echo "Update Feishu callback URL to: $TUNNEL_URL/feishu/event"

  # Auto-send new callback URL to Feishu group
  CALLBACK_URL="$TUNNEL_URL/feishu/event"
  node -e "
    require('dotenv').config({path:'$PROJECT_DIR/.env'});
    const axios = require('axios');
    (async () => {
      try {
        const t = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          {app_id:process.env.APP_ID, app_secret:process.env.APP_SECRET},
          {headers:{'Content-Type':'application/json'}});
        const token = t.data.tenant_access_token;
        const text = JSON.stringify({text: '🔄 系统已重启\n新的回调地址: $CALLBACK_URL\n请在飞书开放平台更新事件回调地址。'});
        await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
          {receive_id: process.env.FEISHU_CHAT_ID, msg_type:'text', content:text},
          {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
      } catch(e) { console.error('Auto-notify failed:', e.message); }
    })();
  " >> "$LOG_DIR/startup.log" 2>&1
fi
