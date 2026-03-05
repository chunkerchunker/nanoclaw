/**
 * View agent interaction transcript for a group.
 * Usage: npx tsx scripts/agent-log.ts <group-folder> [--tail N] [--follow] [--history [session-id]]
 *
 * Examples:
 *   npx tsx scripts/agent-log.ts whatsapp_main
 *   npx tsx scripts/agent-log.ts whatsapp_datestamp --tail 20
 *   npx tsx scripts/agent-log.ts whatsapp_main --follow
 *   npx tsx scripts/agent-log.ts whatsapp_main --history          # list all past sessions
 *   npx tsx scripts/agent-log.ts whatsapp_main --history abc123   # view specific archived session
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const SESSIONS_DIR = path.join(PROJECT_ROOT, 'data', 'sessions');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const FG_GREEN = '\x1b[32m';
const FG_YELLOW = '\x1b[33m';
const FG_CYAN = '\x1b[36m';
const FG_GRAY = '\x1b[90m';
const FG_RED = '\x1b[31m';
const FG_MAGENTA = '\x1b[35m';

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

const folder = positional[0];
if (!folder) {
  // List available groups
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const groups = db
      .prepare('SELECT folder, name, is_main FROM registered_groups ORDER BY is_main DESC, name')
      .all() as { folder: string; name: string; is_main: number }[];
    db.close();
    console.log(`${BOLD}Available groups:${RESET}`);
    for (const g of groups) {
      const tag = g.is_main ? ` ${FG_MAGENTA}(main)${RESET}` : '';
      console.log(`  ${FG_CYAN}${g.folder}${RESET} — ${g.name}${tag}`);
    }
  } catch {
    console.error('Could not read database.');
  }
  console.log(`\nUsage: npx tsx scripts/agent-log.ts <group-folder> [--tail N] [--follow] [--messages] [--history [session-id]]`);
  process.exit(1);
}

const follow = flags.has('--follow') || flags.has('-f');
const messagesMode = flags.has('--messages') || flags.has('-m');
const historyMode = flags.has('--history') || flags.has('-h');
let tailCount = 50; // default
const tailIdx = args.indexOf('--tail');
if (tailIdx >= 0 && args[tailIdx + 1]) {
  tailCount = parseInt(args[tailIdx + 1], 10) || 50;
}
// --history <session-id> to view a specific archived session
const historyIdx = args.indexOf('--history');
const historySessionId = historyIdx >= 0 ? args[historyIdx + 1] : undefined;

// ─── Session lookup ──────────────────────────────────────────────────────────

function getSessionId(): string | null {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
      .get(folder) as { session_id: string } | undefined;
    db.close();
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

function getJsonlPath(sessionId: string): string {
  // Check active session dir first, then archived logs
  const activePath = path.join(
    SESSIONS_DIR, folder, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`,
  );
  if (fs.existsSync(activePath)) return activePath;
  const archivePath = path.join(SESSIONS_DIR, folder, 'log-archive', `${sessionId}.jsonl`);
  if (fs.existsSync(archivePath)) return archivePath;
  return activePath; // fallback to active path for error messages
}

function getArchiveDir(): string {
  return path.join(SESSIONS_DIR, folder, 'log-archive');
}

// ─── Transcript parsing ─────────────────────────────────────────────────────

interface Turn {
  timestamp: string;
  role: string;
  text: string;
  toolName?: string;
  model?: string;
  tokens?: { input: number; output: number };
}

function parseJsonl(filePath: string, maxTurns: number): Turn[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const turns: Turn[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type as string;
    if (type === 'queue-operation') continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const timestamp = (entry.timestamp as string) || '';
    const role = msg.role as string;
    const content = msg.content;
    const model = msg.model as string | undefined;
    const usage = msg.usage as Record<string, number> | undefined;

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      const blockType = b.type as string;

      if (blockType === 'text') {
        const text = (b.text as string) || '';
        if (!text.trim()) continue;

        if (role === 'user') {
          const msgMatch = text.match(/<message[^>]*sender="([^"]*)"[^>]*>([^<]+)<\/message>/);
          if (msgMatch) {
            turns.push({ timestamp, role: 'user', text: `${msgMatch[1]}: ${msgMatch[2].trim()}` });
          } else {
            turns.push({ timestamp, role: 'user', text: text.slice(0, 500) });
          }
        } else if (role === 'assistant') {
          turns.push({
            timestamp, role: 'assistant', text, model,
            tokens: usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } : undefined,
          });
        }
      } else if (blockType === 'tool_use' && role === 'assistant') {
        const name = b.name as string;
        const input = b.input as Record<string, unknown>;
        let summary: string;

        if (name === 'Bash' || name === 'bash') {
          summary = (input?.command as string)?.slice(0, 200) || '';
        } else if (name === 'Read' || name === 'read') {
          summary = (input?.file_path as string) || '';
        } else if (name === 'Write' || name === 'write' || name === 'Edit' || name === 'edit') {
          summary = (input?.file_path as string) || '';
        } else if (name?.startsWith('mcp__nanoclaw__')) {
          const short = name.replace('mcp__nanoclaw__', '');
          summary = JSON.stringify(input).slice(0, 200);
          turns.push({ timestamp, role: 'tool', text: summary, toolName: short });
          continue;
        } else {
          summary = JSON.stringify(input).slice(0, 200);
        }
        turns.push({ timestamp, role: 'tool', text: summary, toolName: name });
      } else if (blockType === 'tool_result') {
        const rc = b.content;
        let text = '';
        if (Array.isArray(rc)) {
          for (const r of rc) {
            if ((r as Record<string, unknown>).type === 'text') {
              text += ((r as Record<string, unknown>).text as string) || '';
            }
          }
        } else if (typeof rc === 'string') {
          text = rc;
        }
        if (text) {
          turns.push({ timestamp, role: 'result', text: text.slice(0, 300) });
        }
      }
    }
  }

  return maxTurns > 0 ? turns.slice(-maxTurns) : turns;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatTimestamp(ts: string): string {
  if (!ts) return '         ';
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return ts.slice(11, 19);
  }
}

function printTurn(turn: Turn): void {
  const ts = `${FG_GRAY}${formatTimestamp(turn.timestamp)}${RESET}`;

  switch (turn.role) {
    case 'user':
      console.log(`${ts} ${FG_GREEN}◀ ${turn.text}${RESET}`);
      break;
    case 'assistant': {
      const lines = turn.text.split('\n');
      const tokenInfo = turn.tokens
        ? ` ${FG_GRAY}(${turn.tokens.input}→${turn.tokens.output} tok)${RESET}`
        : '';
      console.log(`${ts} ${FG_CYAN}▶${RESET} ${lines[0]}${tokenInfo}`);
      for (let i = 1; i < lines.length; i++) {
        console.log(`           ${FG_CYAN}│${RESET} ${lines[i]}`);
      }
      break;
    }
    case 'tool':
      console.log(`${ts} ${FG_YELLOW}⚡ ${turn.toolName}${RESET} ${DIM}${turn.text}${RESET}`);
      break;
    case 'result':
      console.log(`           ${FG_GRAY}⮑ ${turn.text.replace(/\n/g, ' ').slice(0, 120)}${RESET}`);
      break;
  }
}

// ─── DB Messages ─────────────────────────────────────────────────────────────

function getGroupInfo(): { jid: string; isMain: boolean } | null {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT jid, is_main FROM registered_groups WHERE folder = ?')
      .get(folder) as { jid: string; is_main: number } | undefined;
    db.close();
    return row ? { jid: row.jid, isMain: row.is_main === 1 } : null;
  } catch {
    return null;
  }
}

function printMessages(): void {
  const info = getGroupInfo();
  if (!info) {
    console.error(`${FG_RED}No registered group with folder '${folder}'.${RESET}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT sender, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages WHERE chat_jid = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(info.jid, tailCount)
    .reverse() as {
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
    is_bot_message: number;
  }[];
  db.close();

  console.log(`${BOLD}Messages: ${folder}${RESET} ${FG_GRAY}(${rows.length} messages, jid: ${info.jid.slice(0, 20)}…)${RESET}`);
  console.log(`${FG_GRAY}${'─'.repeat(60)}${RESET}`);

  for (const row of rows) {
    const ts = `${FG_GRAY}${formatTimestamp(row.timestamp)}${RESET}`;
    const text = (row.content || '').replace(/\n/g, ' ').slice(0, 200);

    // In self-chat (main), is_from_me distinguishes user vs bot.
    // In group chats, is_from_me is true for the user's own messages too,
    // so use is_bot_message and sender to distinguish.
    const isBot = info.isMain
      ? !!(row.is_from_me || row.is_bot_message)
      : !!(row.is_bot_message || row.sender === 'system');

    if (row.sender === 'system') {
      console.log(`${ts} ${FG_MAGENTA}system${RESET} ${FG_MAGENTA}▶${RESET} ${text}`);
    } else if (isBot) {
      console.log(`${ts} ${FG_CYAN}bot${RESET}    ${FG_CYAN}▶${RESET} ${text}`);
    } else {
      console.log(`${ts} ${FG_GREEN}${row.sender_name || 'user'}${RESET} ${FG_GREEN}◀${RESET} ${text}`);
    }
  }
}

// ─── History ────────────────────────────────────────────────────────────────

function printHistory(): void {
  const archiveDir = getArchiveDir();
  const activeDir = path.join(SESSIONS_DIR, folder, '.claude', 'projects', '-workspace-group');

  // Collect all JSONL files from both active and archive dirs
  const sessions: { id: string; mtime: Date; source: string }[] = [];

  for (const [dir, source] of [[activeDir, 'active'], [archiveDir, 'archived']] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.replace('.jsonl', '');
      const stat = fs.statSync(path.join(dir, file));
      sessions.push({ id, mtime: stat.mtime, source });
    }
  }

  // Deduplicate (active wins over archived)
  const seen = new Set<string>();
  const unique = sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  unique.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  if (unique.length === 0) {
    console.error(`${FG_RED}No session logs found for '${folder}'.${RESET}`);
    process.exit(1);
  }

  // If a specific session ID was provided, show it
  if (historySessionId) {
    const jsonlPath = getJsonlPath(historySessionId);
    if (!fs.existsSync(jsonlPath)) {
      console.error(`${FG_RED}Session '${historySessionId}' not found.${RESET}`);
      process.exit(1);
    }
    console.log(`${BOLD}Agent log: ${folder}${RESET} ${FG_GRAY}(session: ${historySessionId.slice(0, 8)}…)${RESET}`);
    console.log(`${FG_GRAY}${'─'.repeat(60)}${RESET}`);
    const turns = parseJsonl(jsonlPath, tailCount);
    for (const turn of turns) printTurn(turn);
    return;
  }

  // Otherwise list all sessions
  const currentSessionId = getSessionId();
  console.log(`${BOLD}Session history: ${folder}${RESET} ${FG_GRAY}(${unique.length} sessions)${RESET}`);
  console.log(`${FG_GRAY}${'─'.repeat(60)}${RESET}`);
  for (const s of unique) {
    const isCurrent = s.id === currentSessionId;
    const tag = isCurrent ? ` ${FG_MAGENTA}(current)${RESET}` : ` ${FG_GRAY}(${s.source})${RESET}`;
    const date = s.mtime.toLocaleString();
    console.log(`  ${FG_CYAN}${s.id.slice(0, 8)}…${RESET} ${FG_GRAY}${date}${RESET}${tag}`);
  }
  console.log(`\nView a session: npx tsx scripts/agent-log.ts ${folder} --history <session-id>`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  if (messagesMode) {
    printMessages();
    return;
  }

  if (historyMode) {
    printHistory();
    return;
  }

  const sessionId = getSessionId();
  if (!sessionId) {
    console.error(`${FG_RED}No active session for '${folder}'. Use --messages to view DB message history, or --history to browse past sessions.${RESET}`);
    process.exit(1);
  }

  const jsonlPath = getJsonlPath(sessionId);
  if (!fs.existsSync(jsonlPath)) {
    console.error(`${FG_RED}Transcript not found. Use --messages to view DB message history.${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}Agent log: ${folder}${RESET} ${FG_GRAY}(session: ${sessionId.slice(0, 8)}…)${RESET}`);
  console.log(`${FG_GRAY}${'─'.repeat(60)}${RESET}`);

  const turns = parseJsonl(jsonlPath, tailCount);
  for (const turn of turns) {
    printTurn(turn);
  }

  if (!follow) return;

  // Follow mode: watch for changes and print new turns
  console.log(`${FG_GRAY}${'─'.repeat(60)}${RESET}`);
  console.log(`${DIM}Following… (Ctrl+C to stop)${RESET}`);

  let lastSize = fs.statSync(jsonlPath).size;

  const watcher = setInterval(() => {
    try {
      const stat = fs.statSync(jsonlPath);
      if (stat.size <= lastSize) return;

      // Read only the new bytes
      const fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;

      const newLines = buf.toString('utf-8').split('\n');
      for (const line of newLines) {
        if (!line.trim()) continue;
        // Re-parse just this line
        const newTurns = parseJsonlLine(line);
        for (const turn of newTurns) {
          printTurn(turn);
        }
      }
    } catch {
      // File might be temporarily unavailable
    }
  }, 1000);

  process.on('SIGINT', () => {
    clearInterval(watcher);
    process.exit(0);
  });
}

function parseJsonlLine(line: string): Turn[] {
  const turns: Turn[] = [];
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return turns;
  }

  const type = entry.type as string;
  if (type === 'queue-operation') return turns;

  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return turns;

  const timestamp = (entry.timestamp as string) || '';
  const role = msg.role as string;
  const content = msg.content;
  const model = msg.model as string | undefined;
  const usage = msg.usage as Record<string, number> | undefined;

  if (!Array.isArray(content)) return turns;

  for (const block of content) {
    const b = block as Record<string, unknown>;
    const blockType = b.type as string;

    if (blockType === 'text') {
      const text = (b.text as string) || '';
      if (!text.trim()) continue;
      if (role === 'user') {
        const msgMatch = text.match(/<message[^>]*sender="([^"]*)"[^>]*>([^<]+)<\/message>/);
        turns.push({
          timestamp, role: 'user',
          text: msgMatch ? `${msgMatch[1]}: ${msgMatch[2].trim()}` : text.slice(0, 500),
        });
      } else if (role === 'assistant') {
        turns.push({
          timestamp, role: 'assistant', text, model,
          tokens: usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } : undefined,
        });
      }
    } else if (blockType === 'tool_use' && role === 'assistant') {
      const name = b.name as string;
      const input = b.input as Record<string, unknown>;
      let summary: string;
      if (name === 'Bash' || name === 'bash') {
        summary = (input?.command as string)?.slice(0, 200) || '';
      } else if (name?.startsWith('mcp__nanoclaw__')) {
        const short = name.replace('mcp__nanoclaw__', '');
        summary = JSON.stringify(input).slice(0, 200);
        turns.push({ timestamp, role: 'tool', text: summary, toolName: short });
        continue;
      } else if (['Read', 'read', 'Write', 'write', 'Edit', 'edit'].includes(name)) {
        summary = (input?.file_path as string) || '';
      } else {
        summary = JSON.stringify(input).slice(0, 200);
      }
      turns.push({ timestamp, role: 'tool', text: summary, toolName: name });
    } else if (blockType === 'tool_result') {
      const rc = b.content;
      let text = '';
      if (Array.isArray(rc)) {
        for (const r of rc) {
          if ((r as Record<string, unknown>).type === 'text') text += ((r as Record<string, unknown>).text as string) || '';
        }
      } else if (typeof rc === 'string') {
        text = rc;
      }
      if (text) turns.push({ timestamp, role: 'result', text: text.slice(0, 300) });
    }
  }
  return turns;
}

main();
