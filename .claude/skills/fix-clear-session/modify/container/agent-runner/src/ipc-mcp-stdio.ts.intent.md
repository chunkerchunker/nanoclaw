# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
Added clear_session MCP tool that container agents can call to request a session clear from the host.

## Key sections

### clear_session tool registration
- Added `server.tool('clear_session', ...)` before the stdio transport startup.
- Parameters: `target_group_folder` (optional, main-only), `prompt` (optional resume message).
- Authorization: non-main agents cannot specify a different target folder.
- Writes IPC task file with type `clear_session`, targetFolder, groupFolder, prompt, and timestamp.
- Returns confirmation message indicating whether a follow-up prompt was included.

## Invariants
- All existing MCP tools unchanged
- IPC file format follows existing writeIpcFile pattern
- Tool is registered with the same server instance as other tools
- No new imports required
