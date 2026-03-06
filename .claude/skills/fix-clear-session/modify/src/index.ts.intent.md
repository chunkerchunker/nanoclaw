# Intent: src/index.ts modifications

## What changed
Added the `clear_session` feature: an IPC-driven tool that lets agents clear their own (or other groups') conversation sessions, with optional resume prompts and race condition mitigations.

## Why
Agents need the ability to reset their conversation context when stuck, confused, or when instructed to start fresh. The session clear must handle concurrent container lifecycle events without losing resume prompts.

## Key sections

### Imports
- Added: `DATA_DIR` from `./config.js`
- Added: `deleteSession` from `./db.js`

### loadState() — stale session pruning
- Added block after `registeredGroups = getAllRegisteredGroups()` that iterates `sessions`, checks if `DATA_DIR/sessions/{folder}/.claude/projects/` exists, and deletes stale entries via `deleteSession()` + in-memory removal.
- Prevents agents from repeatedly failing to `--resume` a deleted session after host restart.

### processGroupMessages() — system message trigger bypass
- Changed trigger check: added `m.sender === 'system' ||` so system messages (clear_session resume prompts) bypass trigger-word requirements on non-main groups.

### processGroupMessages() — delivery logging
- Added structured logging fields (`length`, `deliverable`) to agent output log line.
- Added separate log lines for delivered vs empty-after-internal-strip output.

### runAgent() — stale session pruning at container start
- Changed `const sessionId` to `let sessionId: string | undefined`
- Added block that checks if the projects directory exists for the session; if not, prunes the stale session from DB and memory before starting the container.
- Prevents race where dying container writes stale session ID back after clearSession deleted it.

### startMessageLoop() — system message trigger bypass
- Same `m.sender === 'system' ||` change in the message loop's trigger check (mirrors processGroupMessages).

### startMessageLoop() — recoverPendingMessages safety net
- Added `recoverPendingMessages()` call at end of each message loop iteration.
- Safety net: if the drain path misses a resume prompt due to timing races, the next poll cycle catches it.

### IPC deps — clearSession handler
- Added `clearSession` property to the `startIpcWatcher` deps object.
- Implementation: (1) delete session from DB, (2) remove in-memory session, (3) archive JSONL logs to `log-archive/`, (4) delete projects dir, (5) close active container via `closeStdin`, (6) if resume prompt provided, store as system message and rewind cursor to trigger processing.

## Invariants
- All exported interfaces unchanged: `getAvailableGroups`, `_setRegisteredGroups`, `escapeXml`, `formatMessages`
- Message loop behavior unchanged for non-system messages
- Session management for normal (non-clear) operations unchanged
- Scheduler and channel initialization unchanged
