# Feishu Multi-Agent Team — Design Spec

## Overview

A Feishu group chat populated by 8 AI roles (CEO, PM, Architect, Backend, Frontend, QA, Reviewer, Tester). The team autonomously discusses, plans, executes tasks, and self-reviews — all through a single local Express server dispatching to Claude Code CLI processes. Persistence survives machine restarts.

**Model:** DeepSeek v4 pro via Anthropic-compatible API, inherited from local Claude Code config. No extra model config needed.

---

## Architecture

```
Feishu Group Chat → Webhook → Express Server (localhost:3000)
                                   │
                         ┌─────────┼─────────┐
                         │   Message Router   │
                         │  - @mention parse  │
                         │  - intent classify │
                         └─────────┼─────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
              │ CEO spawn  │ │ PM spawn  │ │ Arch ...  │  ← lazy-start
              │ (claude    │ │ (claude   │ │           │    idle recycle
              │  --print)  │ │  --print) │ │           │    10min
              └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                    │              │              │
              ┌─────▼──────────────▼──────────────▼─────┐
              │              SQLite (bot.db)             │
              │  messages / tasks / sessions / locks     │
              └────────────────┬────────────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  quality-reports/YYYY-MM-DD/     │
              │  (tester writes .md reports)     │
              └─────────────────────────────────┘
```

## 8 Roles

| Role | Key | Responsibility | Special Capability |
|------|-----|---------------|-------------------|
| CEO | `ceo` | Strategic decisions, final approval, deadlock break | Assign any task to any role |
| PM | `pm` | Requirement breakdown, scheduling, risk tracking | Split large tasks into sub-tasks |
| Architect | `architect` | System design, tech selection, design review | Read project files, output architecture |
| Backend | `backend` | Backend code, API, database | Write code, run commands |
| Frontend | `frontend` | Frontend UI, pages | Write frontend code |
| QA | `qa` | Test strategy, test case design | Review quality, does NOT execute |
| Reviewer | `reviewer` | Code review, security scan, quality gate | Audit code output |
| Tester | `tester` | Execute tests, register quality, archive reports | Write `quality-reports/YYYY-MM-DD/<task>.md` |

## Event-Driven Workflow

### Four Event Types

| Event | Trigger | Behavior |
|-------|---------|----------|
| **Discussion** | Message contains no execution intent | Single role replies, no task board entry |
| **Task** | Message contains build/implement/develop verbs | PM subscribes → splits → roles execute |
| **Review** | Any role publishes completed output | Reviewer auto-reviews → Tester checks |
| **System** | Deadlock, error, manual `/summary` | CEO intervenes |

### Self-Rule (Three Rules)

1. **Auto-claim** — Unclaimed tasks on the board matching own skills → automatically picked up
2. **Block awareness** — Before executing, check dependency completion. If blocked, post "Waiting for @role X to finish Y"
3. **Escalation** — Same task rejected by Tester 2 times → auto-escalated to CEO for reassignment

### Three User Actions

1. Assign tasks — "Build user login for me"
2. Join discussions — Interject anytime
3. Accept results — Tester report passes → user confirms, done

## Message Router

1. Parse `@role-name` mentions → force-route to that role
2. No @mention → lightweight intent classifier determines best match.
   - Uses a single ~200 token Claude API call with a classification prompt listing all 8 roles and their domains
   - Returns the best-matching role key (e.g. `architect`) or `null` for general discussion
   - Classification is cached per message_id to avoid re-classification on retry
3. Dedup by `message_id` (stored in SQLite, skip if already processed)
4. Feishu 3s timeout: always return 200 immediately, process async
5. Event type determination:
   - Message contains explicit task verbs (做/实现/开发/搭建/build/implement/create) → **Task** event
   - Message is a reply to danger confirmation card → **System** event (approve/reject)
   - Manual `/summary` or `/status` → **System** event
   - Everything else → **Discussion** event

## Process Management

### Lazy Start + Idle Recycle

- Role process spawned only when addressed/matched
- Idle 10 minutes → process exits, context summary saved to DB
- On re-spawn: load context summary + recent history from SQLite

### Health Monitor

- Every 10s checks each active process
- PID gone → mark dead, trigger recovery
- No stdout for X seconds:
  - Discussion or single-step task: 120s → stuck
  - Multi-step task (has sub-tasks in task board): 300s → stuck
  - Task size determined by: presence in task board + PM-assigned sub-task count
- Stuck → kill, restart, notify group
- 3 consecutive stuck on same role → notify group, stop auto-restart
- 5+ roles stuck within 5 minutes → global alert (likely API outage), don't cascade-degrade

### Crash Recovery

On server start:
1. Read `sessions` table, find all `status=active` rows
2. Kill old PIDs (likely zombie from previous run)
3. Spawn fresh Claude Code per role with merged hot + warm context
4. Try `--resume <last_session_id>`, fallback to new session if fail
5. Read `task-board`, notify group: "Team back. X tasks, Y in progress."

## Persistence (SQLite)

### Schema

```sql
messages (id TEXT PK, chat_id TEXT, role TEXT, content TEXT,
          tool_use TEXT, created_at TEXT)

tasks (id TEXT PK, chat_id TEXT, title TEXT, status TEXT,
       assignee TEXT, depends_on TEXT, retry_count INTEGER DEFAULT 0,
       result TEXT, created_at TEXT, done_at TEXT)

sessions (id TEXT PK, chat_id TEXT, role TEXT,
          claude_session_id TEXT, pid INTEGER, status TEXT,
          last_active_at TEXT, context_summary TEXT)

locks (file_path TEXT PK, holder TEXT, acquired_at TEXT)
```

### Smart Context

| Tier | Range | Storage |
|------|-------|---------|
| Hot | Last 20 turns | Full text |
| Warm | 20–50 turns | Per-role summary (key decisions, outputs) |
| Cold | 50+ turns | Milestones only ("login feature done", "DB tables created") |

- On restore: hot + warm → initial context
- Context budget: hard cap 50K tokens per role, trim oldest messages first
- Summary snapshots every 10 turns, non-cumulative (latest snapshot + recent raw messages, not summary-of-summary)

### Atomicity

- All writes through SQLite WAL mode (crash-safe by design)
- PM task creation wrapped in `BEGIN...COMMIT` transaction
- No partial task boards

### Backup

- Daily backup: `cp bot.db .data/backups/bot-YYYY-MM-DD.db`
- Startup check: `PRAGMA integrity_check`, auto-switch to backup if corrupt

## Safeguards

### File Write Locks

- Acquire lock on file path before writing
- 30s timeout, auto-release + group alert on deadlock
- Process exit (normal or crash) → cleanup all held locks
- Only write-locked; reads never blocked

### Progress Heartbeat

| Duration | Action |
|----------|--------|
| 0–15s | No heartbeat |
| 15–60s | Every 15s: "Reading project structure..." |
| 1–5min | Every 30s: with partial output ("3/5 endpoints done") |
| >5min | Alert: "Task taking longer than expected, may need attention" |

- Heartbeat messages carry sequence numbers `[#N]`
- Final result carries `[#N done]`; client ignores stale heartbeats after done

### Danger Confirmation Gate

Dangerous operations (rm -rf, git push --force, .env modification, DROP TABLE, chmod -R 777, etc.):
- Pause execution
- Send Feishu **card message** with confirm/reject buttons (not plain text, won't scroll away)
- Wait for user response, 5min timeout auto-rejects
- Default-deny: only allow writes within project directory + known safe commands
- All other commands go through confirmation flow

### Secret Redaction

Before routing to Claude Code, filter message content and context for:
- `ANTHROPIC_API_KEY`, `APP_SECRET`, patterns like `sk-...`
- Replace with `[REDACTED]`

### Deadlock Prevention

- Lock timeout 30s → auto-release + alert
- Circular dependency detected in task depends_on → CEO intervenes

---

## Project Structure

```
feishu-claude-bot/
├── index.js                    # Local Express server (entry point)
├── src/
│   ├── router.js               # Message dedup + role routing
│   ├── roles.js                # 8 role definitions + system prompts
│   ├── process-manager.js      # Spawn/kill/monitor Claude Code processes
│   ├── db.js                   # SQLite operations (better-sqlite3)
│   ├── task-board.js           # Task lifecycle + dependency resolution
│   ├── heartbeat.js            # Progress reporting
│   ├── safeguards.js           # Danger gate + secret redaction + file locks
│   ├── feishu.js               # Feishu API helpers (token, send message, card)
│   └── context.js              # Hot/warm/cold context management
├── .data/
│   ├── bot.db
│   └── backups/
├── quality-reports/
│   └── YYYY-MM-DD/
│       └── <task-name>.md
├── package.json
├── .env
└── docs/superpowers/specs/
    └── 2026-05-24-feishu-multi-agent-team-design.md
```

## Dependencies

- `express` — HTTP server for Feishu webhooks
- `better-sqlite3` — SQLite driver
- `axios` — HTTP client for Feishu API
- `dotenv` — Environment variables
- `@anthropic-ai/sdk` — (already present, may be used for intent classification)
- Claude Code CLI — spawned as child process (already installed, configured for DeepSeek v4 pro)

## Non-Goals

- Vercel deployment (local-only per user decision)
- Image/voice message handling
- Multi-group support (single group is fine; architecture allows extension)
