# Intent: src/db.ts modifications

## What changed
Three additions to support the clear_session feature.

## Key sections

### getNewMessages() — exclude system messages
- Added `AND sender != 'system'` to the WHERE clause in the message query.
- System messages (e.g. clear_session resume prompts) are internal and handled by the drain path in processGroupMessages, not the message loop. Without this filter, the message loop could pipe resume prompts to a dying container and advance the cursor past them.

### deleteSession() — new function
- Added after `setSession()`.
- `DELETE FROM sessions WHERE group_folder = ?`
- Used by clearSession in index.ts and by stale session pruning in loadState/runAgent.

### deleteRegisteredGroup() — new function
- Added after `setRegisteredGroup()`.
- `DELETE FROM registered_groups WHERE jid = ?`
- Provides symmetry with setRegisteredGroup for group management.

## Invariants
- All existing exported functions unchanged
- Database schema unchanged
- getMessagesSince() intentionally NOT modified (it must include system messages so processGroupMessages can find resume prompts)
