---
name: fix-clear-session
description: Add clear_session IPC tool so agents can reset their conversation session with optional resume prompt. Includes race condition fixes for reliable restart. Triggers on "clear session", "session reset", "fix session", "agent stuck".
---

# Fix Clear Session

This skill adds a `clear_session` MCP tool that container agents can call to reset their conversation session. It includes multiple layers of race condition mitigation to ensure the agent reliably restarts with the resume prompt.

**What this adds:**
- `clear_session` MCP tool in the container agent (clears session, optionally sends a resume prompt)
- `clear_session` IPC handler on the host (processes the request from the container)
- `clearSession` implementation in index.ts (session cleanup, log archival, container restart)
- `deleteSession()` and `deleteRegisteredGroup()` DB functions
- Stale session pruning at startup and at container start
- System message exclusion from message loop (prevents cursor advancement races)
- System message trigger bypass (resume prompts work on non-main groups)
- `recoverPendingMessages()` safety net in message loop (catches missed resume prompts)

**What stays the same:**
- All existing MCP tools, IPC tasks, and message handling
- Normal session management (create, resume)
- Database schema
- Container lifecycle

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `fix-clear-session` is in `applied_skills`, skip to Phase 3 (Verify).

### Check current state

```bash
grep "clearSession" src/ipc.ts
grep "deleteSession" src/db.ts
grep "clear_session" container/agent-runner/src/ipc-mcp-stdio.ts
```

If all three match, the changes are already present. Skip to Phase 3.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/fix-clear-session
```

This applies via three-way merge:
- `src/db.ts`: adds `sender != 'system'` filter, `deleteSession()`, `deleteRegisteredGroup()`
- `src/index.ts`: adds stale session pruning, system message bypass, clearSession handler, recovery safety net
- `src/ipc.ts`: adds `clearSession` to IpcDeps, `clear_session` case in processTaskIpc
- `container/agent-runner/src/ipc-mcp-stdio.ts`: adds `clear_session` MCP tool

If merge conflicts occur, read the intent files:
- `modify/src/db.ts.intent.md`
- `modify/src/index.ts.intent.md`
- `modify/src/ipc.ts.intent.md`
- `modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md`

### Validate

```bash
npm run build
npm test
```

## Phase 3: Verify

### Rebuild container

The container agent code changed (new MCP tool), so rebuild:

```bash
./container/build.sh
```

### Restart service

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw

# Manual
npm run dev
```

### Test clear_session

Send a message to your main group asking the agent to clear its own session with a resume prompt. The agent should:
1. Call the `clear_session` tool
2. Exit gracefully
3. Restart automatically with the resume prompt
4. Respond without requiring additional user input

## How It Works

### Session clear flow
1. Agent calls `clear_session` MCP tool → writes IPC task file
2. Host IPC watcher picks up the file → calls `clearSession()`
3. `clearSession` deletes session from DB/memory, archives JSONL logs, deletes projects dir
4. Sends `_close` sentinel to the running container
5. If resume prompt provided: stores as system message, rewinds cursor, enqueues message check
6. Old container exits → drain path picks up the pending message check
7. New container starts fresh, processes the resume prompt

### Race condition mitigations
- **Stale session write-back**: Dying container may write its session ID back via streaming callback after clearSession deleted it. Fix: prune stale sessions (missing projects dir) at container start.
- **Cursor advancement**: Message loop could advance cursor past the resume message by piping to the dying container. Fix: `getNewMessages` excludes `sender='system'` messages so the loop never sees them.
- **Drain path miss**: Various timing races could cause the drain path to miss the resume message. Fix: `recoverPendingMessages()` runs every poll cycle as a safety net.
- **Trigger bypass**: Resume prompts on non-main groups would be blocked by trigger-word requirements. Fix: `sender === 'system'` bypasses trigger checks.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/db.ts` | Add system message filter, deleteSession(), deleteRegisteredGroup() |
| `src/index.ts` | Add stale session pruning, clearSession handler, system message bypass, recovery loop |
| `src/ipc.ts` | Add clearSession to IpcDeps interface, clear_session IPC case |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add clear_session MCP tool |
