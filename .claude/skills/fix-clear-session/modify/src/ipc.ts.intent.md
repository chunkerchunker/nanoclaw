# Intent: src/ipc.ts modifications

## What changed
Added clear_session IPC task type so container agents can request session clears from the host.

## Key sections

### IpcDeps interface
- Added: `clearSession: (targetFolder: string, prompt?: string) => Promise<void>`

### processTaskIpc data type
- Added: `targetFolder?: string` field (used by clear_session)

### processTaskIpc switch — clear_session case
- Authorization: non-main groups can only clear their own session. Main group can clear any group by specifying targetFolder.
- Validates targetFolder with `isValidGroupFolder()`.
- Delegates to `deps.clearSession(targetFolder, data.prompt)`.

## Invariants
- All existing IPC task types unchanged
- No new imports required beyond what's already in the file
- IPC file processing loop unchanged
- Message handling unchanged
