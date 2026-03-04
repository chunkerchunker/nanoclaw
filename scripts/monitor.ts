/**
 * NanoClaw TUI Monitor
 * Real-time dashboard for watching agent activity, groups, scheduled tasks, and logs.
 * Usage: npx tsx scripts/monitor.ts
 */
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ─── ANSI Constants ──────────────────────────────────────────────────────────

const ESC = '\x1b';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;

const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const FG_GREEN = `${ESC}[32m`;
const FG_YELLOW = `${ESC}[33m`;
const FG_RED = `${ESC}[31m`;
const FG_CYAN = `${ESC}[36m`;
const FG_MAGENTA = `${ESC}[35m`;
const FG_WHITE = `${ESC}[37m`;
const FG_GRAY = `${ESC}[90m`;
const BG_BLUE = `${ESC}[44m`;
const BG_GRAY = `${ESC}[100m`;

// Box drawing
const TL = '╔', TR = '╗', BL = '╚', BR = '╝';
const H = '═', V = '║';
const TJ = '╤', BJ = '╧', LJ = '╠', RJ = '╣';
const CROSS = '╪';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentInfo {
  name: string;
  folder: string;
  startTime: number;
  status: string;
}

interface GroupInfo {
  jid: string;
  name: string;
  folder: string;
  isMain: boolean;
  hasActiveAgent: boolean;
  lastActivity?: string;
}

interface TaskInfo {
  id: string;
  groupFolder: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  nextRun: string | null;
  lastRun: string | null;
  status: string;
}

interface LogEntry {
  time: string;
  level: string;
  msg: string;
  group?: string;
}

interface TranscriptTurn {
  timestamp: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'progress';
  text: string;
  toolName?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

// ─── State ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const LOG_PATH = path.join(PROJECT_ROOT, 'logs', 'nanoclaw.log');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const SESSIONS_DIR = path.join(PROJECT_ROOT, 'data', 'sessions');
const REFRESH_INTERVAL = 2000;

let selectedGroupIndex = -1; // -1 = no selection
let detailView = false;
let detailScrollOffset = 0;
let groups: GroupInfo[] = [];
let agents: AgentInfo[] = [];
let tasks: TaskInfo[] = [];
let logEntries: LogEntry[] = [];
let detailTranscript: TranscriptTurn[] = [];
let detailTokens = { input: 0, output: 0, cacheRead: 0 };
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ─── Data Collection ─────────────────────────────────────────────────────────

function getDb(): Database.Database | null {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function fetchAgents(): AgentInfo[] {
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    return containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => {
        const id = c.configuration.id;
        // Pattern: nanoclaw-{safeName}-{timestamp}
        // safeName is folder with non-alphanumeric chars replaced by '-'
        // timestamp is Date.now() (13-digit number) at the end
        const withoutPrefix = id.replace('nanoclaw-', '');
        const lastDash = withoutPrefix.lastIndexOf('-');
        const timestamp = lastDash >= 0 ? parseInt(withoutPrefix.slice(lastDash + 1), 10) : NaN;
        const folder = lastDash >= 0 ? withoutPrefix.slice(0, lastDash) : withoutPrefix;
        return {
          name: id,
          folder,
          startTime: isNaN(timestamp) ? Date.now() : timestamp,
          status: c.status,
        };
      });
  } catch {
    return [];
  }
}

function fetchGroups(db: Database.Database | null): GroupInfo[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        'SELECT jid, name, folder, is_main FROM registered_groups ORDER BY is_main DESC, name',
      )
      .all() as {
      jid: string;
      name: string;
      folder: string;
      is_main: number;
    }[];
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      folder: r.folder,
      isMain: r.is_main === 1,
      hasActiveAgent: agents.some(
        (a) => a.folder === r.folder.replace(/[^a-zA-Z0-9-]/g, '-'),
      ),
    }));
  } catch {
    return [];
  }
}

function fetchTasks(db: Database.Database | null): TaskInfo[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, group_folder, prompt, schedule_type, schedule_value, next_run, last_run, status
         FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run`,
      )
      .all() as {
      id: string;
      group_folder: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      next_run: string | null;
      last_run: string | null;
      status: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      groupFolder: r.group_folder,
      prompt: r.prompt,
      scheduleType: r.schedule_type,
      scheduleValue: r.schedule_value,
      nextRun: r.next_run,
      lastRun: r.last_run,
      status: r.status,
    }));
  } catch {
    return [];
  }
}

function fetchLogs(): LogEntry[] {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const stat = fs.statSync(LOG_PATH);
    const readSize = Math.min(stat.size, 32768);
    const fd = fs.openSync(LOG_PATH, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    // Strip ANSI escape codes
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = clean.split('\n');
    const entries: LogEntry[] = [];

    // Parse pino-pretty format: [HH:MM:SS.mmm] LEVEL (pid): message
    const logLineRegex = /^\[(\d{2}:\d{2}:\d{2})\.\d{3}\]\s+(\w+)\s+\(\d+\):\s+(.+)$/;
    // Continuation lines with group info
    const groupRegex = /^\s+group:\s+"(.+)"$/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(logLineRegex);
      if (match) {
        const entry: LogEntry = {
          time: match[1],
          level: match[2],
          msg: match[3],
        };
        // Look ahead for group field
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const gm = lines[j].match(groupRegex);
          if (gm) {
            entry.group = gm[1];
            break;
          }
          // Stop at next log line
          if (logLineRegex.test(lines[j])) break;
        }
        entries.push(entry);
      }
    }
    return entries.slice(-100); // Keep last 100 entries
  } catch {
    return [];
  }
}

function fetchSessionId(db: Database.Database | null, folder: string): string | null {
  if (!db) return null;
  try {
    const row = db
      .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
      .get(folder) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

function fetchTranscript(folder: string, sessionId: string): { turns: TranscriptTurn[]; tokens: typeof detailTokens } {
  const tokens = { input: 0, output: 0, cacheRead: 0 };
  const turns: TranscriptTurn[] = [];

  try {
    const jsonlPath = path.join(
      SESSIONS_DIR, folder, '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`,
    );
    if (!fs.existsSync(jsonlPath)) return { turns, tokens };

    // Tail last 64KB
    const stat = fs.statSync(jsonlPath);
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    // If we started mid-file, skip the first partial line
    const startIdx = stat.size > readSize ? text.indexOf('\n') + 1 : 0;
    const lines = text.slice(startIdx).split('\n');

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

      if (usage) {
        tokens.input += usage.input_tokens || 0;
        tokens.output += usage.output_tokens || 0;
        tokens.cacheRead += usage.cache_read_input_tokens || 0;
      }

      if (!Array.isArray(content)) continue;

      for (const block of content) {
        const blockType = (block as Record<string, unknown>).type as string;
        if (blockType === 'text') {
          const text = ((block as Record<string, unknown>).text as string) || '';
          if (!text.trim()) continue;
          if (role === 'user') {
            // Extract human message from XML wrapper if present
            const msgMatch = text.match(/<message[^>]*>([^<]+)<\/message>/);
            turns.push({
              timestamp,
              role: 'user',
              text: msgMatch ? msgMatch[1].trim() : text.slice(0, 200),
            });
          } else if (role === 'assistant') {
            turns.push({ timestamp, role: 'assistant', text, model });
          }
        } else if (blockType === 'tool_use' && role === 'assistant') {
          const name = (block as Record<string, unknown>).name as string;
          const input = (block as Record<string, unknown>).input as Record<string, unknown>;
          let summary = '';
          if (name === 'Bash' || name === 'bash') {
            summary = (input?.command as string)?.slice(0, 120) || '';
          } else if (name === 'Read' || name === 'read') {
            summary = (input?.file_path as string) || '';
          } else if (name === 'Write' || name === 'write') {
            summary = (input?.file_path as string) || '';
          } else if (name === 'Edit' || name === 'edit') {
            summary = (input?.file_path as string) || '';
          } else if (name?.startsWith('mcp__nanoclaw__')) {
            const toolShort = name.replace('mcp__nanoclaw__', '');
            summary = `${JSON.stringify(input).slice(0, 100)}`;
            turns.push({ timestamp, role: 'tool_use', text: summary, toolName: toolShort });
            continue;
          } else {
            summary = JSON.stringify(input).slice(0, 100);
          }
          turns.push({ timestamp, role: 'tool_use', text: summary, toolName: name });
        } else if (blockType === 'tool_result') {
          const resultContent = (block as Record<string, unknown>).content;
          let text = '';
          if (Array.isArray(resultContent)) {
            for (const rc of resultContent) {
              if ((rc as Record<string, unknown>).type === 'text') {
                text += ((rc as Record<string, unknown>).text as string) || '';
              }
            }
          } else if (typeof resultContent === 'string') {
            text = resultContent;
          }
          if (text) {
            turns.push({ timestamp, role: 'tool_result', text: text.slice(0, 200) });
          }
        }
      }
    }
  } catch {
    // Fail silently
  }

  return { turns, tokens };
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${String(remSecs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${String(remMins).padStart(2, '0')}m`;
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return '--';
  const date = new Date(iso);
  const localTime = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });
  const diff = Date.now() - date.getTime();
  if (diff < 0) {
    // Future time
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return `${localTime} (in <1m)`;
    if (absDiff < 3600000) return `${localTime} (in ${Math.floor(absDiff / 60000)}m)`;
    if (absDiff < 86400000) return `${localTime} (in ${Math.floor(absDiff / 3600000)}h)`;
    return `${localTime} (in ${Math.floor(absDiff / 86400000)}d)`;
  }
  if (diff < 60000) return `${localTime} (<1m ago)`;
  if (diff < 3600000) return `${localTime} (${Math.floor(diff / 60000)}m ago)`;
  if (diff < 86400000) return `${localTime} (${Math.floor(diff / 3600000)}h ago)`;
  return `${localTime} (${Math.floor(diff / 86400000)}d ago)`;
}

function levelColor(level: string): string {
  switch (level.toUpperCase()) {
    case 'ERROR':
    case 'FATAL':
      return FG_RED;
    case 'WARN':
      return FG_YELLOW;
    case 'INFO':
      return FG_GREEN;
    case 'DEBUG':
      return FG_CYAN;
    default:
      return FG_GRAY;
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function pad(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

// Visible length (strips ANSI)
function visLen(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function padStyled(str: string, len: number): string {
  const vis = visLen(str).length;
  if (vis >= len) return str;
  return str + ' '.repeat(len - vis);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function horizontalLine(width: number, left: string, right: string, fill: string, mid?: { pos: number; char: string }): string {
  if (mid) {
    return left + fill.repeat(mid.pos) + mid.char + fill.repeat(width - 2 - mid.pos) + right;
  }
  return left + fill.repeat(width - 2) + right;
}

function renderDashboard(): string {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const width = Math.max(60, cols);
  const leftW = Math.floor((width - 3) / 2); // inside left pane width
  const rightW = width - 3 - leftW; // inside right pane width
  const midCol = leftW + 1; // position of middle divider

  const out: string[] = [];

  // Title bar
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  const title = ' NanoClaw Monitor';
  const titleLine = V + BG_BLUE + FG_WHITE + BOLD +
    pad(title, width - 2 - timeStr.length) + timeStr + RESET + V;

  out.push(horizontalLine(width, TL, TR, H));
  out.push(titleLine);
  out.push(horizontalLine(width, LJ, RJ, H, { pos: midCol, char: TJ }));

  // Calculate pane heights
  const availRows = rows - 6; // title(2) + dividers(2) + footer(2)
  const topH = Math.max(4, Math.floor(availRows / 2));
  const bottomH = Math.max(4, availRows - topH);

  // ── Top Left: Active Agents ──
  const topLeftLines: string[] = [];
  topLeftLines.push(`${BOLD} Active Agents (${agents.length})${RESET}`);
  if (agents.length === 0) {
    topLeftLines.push(`${DIM}  No active agents${RESET}`);
  } else {
    for (const agent of agents.slice(0, topH - 2)) {
      const dur = formatDuration(Date.now() - agent.startTime);
      // visible: "  ● " (4) + folder + " " + dur (7) + " " + "running" (7) = 20 fixed chars
      const folderW = Math.max(4, leftW - 20);
      const line = `  ${FG_GREEN}●${RESET} ${pad(truncate(agent.folder, folderW), folderW)} ${pad(dur, 7)} ${FG_GREEN}running${RESET}`;
      topLeftLines.push(line);
    }
  }

  // ── Top Right: Groups ──
  const topRightLines: string[] = [];
  topRightLines.push(`${BOLD} Groups (${groups.length})${RESET}`);
  if (groups.length === 0) {
    topRightLines.push(`${DIM}  No groups registered${RESET}`);
  } else {
    for (let i = 0; i < Math.min(groups.length, topH - 2); i++) {
      const g = groups[i];
      const cursor = i === selectedGroupIndex ? `${FG_CYAN}>${RESET}` : ' ';
      const indicator = g.hasActiveAgent ? `${FG_GREEN}●${RESET}` : `${FG_GRAY}○${RESET}`;
      const mainTag = g.isMain ? `${FG_MAGENTA}★${RESET}` : ' ';
      const nameStr = truncate(g.name, rightW - 10);
      const sel = i === selectedGroupIndex ? `${ESC}[7m` : '';
      const selEnd = i === selectedGroupIndex ? RESET : '';
      topRightLines.push(`${sel}${cursor}${mainTag}${pad(nameStr, rightW - 6)} ${indicator}${selEnd}`);
    }
  }

  // Render top panes
  for (let r = 0; r < topH; r++) {
    const left = r < topLeftLines.length ? topLeftLines[r] : '';
    const right = r < topRightLines.length ? topRightLines[r] : '';
    out.push(V + padStyled(left, leftW) + V + padStyled(right, rightW) + V);
  }

  // Middle divider
  out.push(horizontalLine(width, LJ, RJ, H, { pos: midCol, char: CROSS }));

  // ── Bottom Left: Recent Activity ──
  const filteredLogs =
    selectedGroupIndex >= 0 && groups[selectedGroupIndex]
      ? logEntries.filter((l) => {
          const g = groups[selectedGroupIndex];
          return !l.group || l.group === g.folder || l.group === g.name;
        })
      : logEntries;
  const visibleLogs = filteredLogs.slice(-(bottomH - 1));

  const botLeftLines: string[] = [];
  const filterLabel = selectedGroupIndex >= 0 && groups[selectedGroupIndex]
    ? ` ${FG_CYAN}[${groups[selectedGroupIndex].name}]${RESET}`
    : '';
  botLeftLines.push(`${BOLD} Recent Activity${filterLabel}${RESET}`);
  if (visibleLogs.length === 0) {
    botLeftLines.push(`${DIM}  No recent log entries${RESET}`);
  } else {
    for (const entry of visibleLogs) {
      const lvl = levelColor(entry.level) + pad(entry.level, 5) + RESET;
      const msg = truncate(entry.msg, leftW - 16);
      botLeftLines.push(` ${FG_GRAY}${entry.time}${RESET} ${lvl} ${msg}`);
    }
  }

  // ── Bottom Right: Scheduled Tasks ──
  const botRightLines: string[] = [];
  botRightLines.push(`${BOLD} Scheduled Tasks (${tasks.length})${RESET}`);
  if (tasks.length === 0) {
    botRightLines.push(`${DIM}  No active tasks${RESET}`);
  } else {
    for (const task of tasks.slice(0, bottomH - 1)) {
      const shortId = task.id.slice(0, 7);
      const nextStr = formatRelativeTime(task.nextRun ?? undefined);
      const sched = task.scheduleType === 'cron' ? task.scheduleValue : task.scheduleType;
      botRightLines.push(` ${FG_YELLOW}${shortId}${RESET} ${pad(truncate(sched, 12), 12)} ${nextStr}`);
      if (task.prompt) {
        botRightLines.push(`   ${DIM}${truncate(task.prompt, rightW - 5)}${RESET}`);
      }
    }
  }

  // Render bottom panes
  for (let r = 0; r < bottomH; r++) {
    const left = r < botLeftLines.length ? botLeftLines[r] : '';
    const right = r < botRightLines.length ? botRightLines[r] : '';
    out.push(V + padStyled(left, leftW) + V + padStyled(right, rightW) + V);
  }

  // Footer
  out.push(horizontalLine(width, LJ, RJ, H));
  const footerKeys = ` ${FG_CYAN}q${RESET}:quit  ${FG_CYAN}↑↓${RESET}:select group  ${FG_CYAN}Enter${RESET}:detail  ${FG_CYAN}Esc${RESET}:deselect  ${FG_CYAN}r${RESET}:refresh`;
  out.push(V + padStyled(footerKeys, width - 2) + V);
  out.push(horizontalLine(width, BL, BR, H));

  return out.join('\n');
}

function renderDetailView(): string {
  if (selectedGroupIndex < 0 || !groups[selectedGroupIndex]) return renderDashboard();
  const group = groups[selectedGroupIndex];

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const width = Math.max(60, cols);

  const out: string[] = [];

  // Title bar with status and token counts
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  const title = ` ${group.name}`;
  const statusStr = group.hasActiveAgent ? `${FG_GREEN}● running${RESET}` : `${FG_GRAY}○ idle${RESET}`;
  const tokenStr = detailTokens.input > 0
    ? `${FG_GRAY}in:${formatTokenCount(detailTokens.input)} out:${formatTokenCount(detailTokens.output)} cache:${formatTokenCount(detailTokens.cacheRead)}${RESET}`
    : '';

  out.push(horizontalLine(width, TL, TR, H));
  out.push(
    V + BG_BLUE + FG_WHITE + BOLD +
    pad(title, width - 2 - timeStr.length - 12) + RESET + ' ' +
    statusStr + '  ' + timeStr + ' ' + V,
  );
  // Token usage bar
  if (tokenStr) {
    out.push(V + padStyled(` ${tokenStr}`, width - 2) + V);
  }
  out.push(horizontalLine(width, LJ, RJ, H));

  const headerRows = tokenStr ? 4 : 3;
  const availRows = rows - headerRows - 3; // footer = 3

  // Render transcript turns as lines
  const turnLines: string[] = [];
  for (const turn of detailTranscript) {
    const ts = turn.timestamp
      ? new Date(turn.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '        ';

    switch (turn.role) {
      case 'user': {
        const text = truncate(turn.text.replace(/\n/g, ' '), width - 16);
        turnLines.push(` ${FG_GRAY}${ts}${RESET} ${FG_GREEN}<-${RESET} ${text}`);
        break;
      }
      case 'assistant': {
        // Multi-line assistant text: first line with arrow, rest indented
        const lines = turn.text.split('\n');
        const firstLine = truncate(lines[0], width - 16);
        turnLines.push(` ${FG_GRAY}${ts}${RESET} ${FG_CYAN}->${RESET} ${firstLine}`);
        for (let i = 1; i < Math.min(lines.length, 4); i++) {
          const line = truncate(lines[i], width - 16);
          if (line.trim()) turnLines.push(`            ${FG_CYAN}  ${RESET} ${line}`);
        }
        if (lines.length > 4) turnLines.push(`            ${DIM}   ... (${lines.length - 4} more lines)${RESET}`);
        break;
      }
      case 'tool_use': {
        const toolLabel = turn.toolName || 'tool';
        const text = truncate(turn.text.replace(/\n/g, ' '), width - 20 - toolLabel.length);
        turnLines.push(` ${FG_GRAY}${ts}${RESET} ${FG_YELLOW}${toolLabel}${RESET} ${DIM}${text}${RESET}`);
        break;
      }
      case 'tool_result': {
        const text = truncate(turn.text.replace(/\n/g, ' '), width - 18);
        turnLines.push(`            ${FG_GRAY}=> ${text}${RESET}`);
        break;
      }
    }
  }

  // Apply scroll offset — show last turns by default, allow scrolling up
  const maxScroll = Math.max(0, turnLines.length - availRows);
  detailScrollOffset = Math.min(detailScrollOffset, maxScroll);
  detailScrollOffset = Math.max(0, detailScrollOffset);
  const scrollPos = maxScroll - detailScrollOffset;
  const visibleTurns = turnLines.slice(scrollPos, scrollPos + availRows);

  // Transcript header
  const scrollIndicator = detailScrollOffset > 0 ? ` ${FG_GRAY}(${detailScrollOffset} more below)${RESET}` : '';
  const headerText = `${BOLD} Claude Interaction${RESET} ${FG_GRAY}(${detailTranscript.length} turns)${RESET}${scrollIndicator}`;
  out.push(V + padStyled(` ${headerText}`, width - 2) + V);

  if (turnLines.length === 0) {
    out.push(V + padStyled(`${DIM}  No transcript data${RESET}`, width - 2) + V);
    for (let i = 0; i < availRows - 2; i++) out.push(V + ' '.repeat(width - 2) + V);
  } else {
    for (let i = 0; i < availRows - 1; i++) {
      if (i < visibleTurns.length) {
        out.push(V + padStyled(visibleTurns[i], width - 2) + V);
      } else {
        out.push(V + ' '.repeat(width - 2) + V);
      }
    }
  }

  // Footer
  out.push(horizontalLine(width, LJ, RJ, H));
  const footerKeys = ` ${FG_CYAN}Esc${RESET}:back  ${FG_CYAN}↑↓${RESET}:scroll  ${FG_CYAN}q${RESET}:quit  ${FG_CYAN}r${RESET}:refresh`;
  out.push(V + padStyled(footerKeys, width - 2) + V);
  out.push(horizontalLine(width, BL, BR, H));

  return out.join('\n');
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

function refreshData(): void {
  agents = fetchAgents();
  const db = getDb();
  groups = fetchGroups(db);
  tasks = fetchTasks(db);

  // Fetch transcript for detail view
  if (detailView && selectedGroupIndex >= 0 && groups[selectedGroupIndex]) {
    const group = groups[selectedGroupIndex];
    const sessionId = fetchSessionId(db, group.folder);
    if (sessionId) {
      const result = fetchTranscript(group.folder, sessionId);
      detailTranscript = result.turns;
      detailTokens = result.tokens;
    } else {
      detailTranscript = [];
      detailTokens = { input: 0, output: 0, cacheRead: 0 };
    }
  }

  db?.close();
  logEntries = fetchLogs();

  // Clamp selection
  if (selectedGroupIndex >= groups.length) {
    selectedGroupIndex = groups.length - 1;
  }
}

function render(): void {
  const frame = detailView ? renderDetailView() : renderDashboard();
  process.stdout.write(CLEAR + frame);
}

function tick(): void {
  refreshData();
  render();
}

// ─── Input Handling ──────────────────────────────────────────────────────────

function handleInput(data: Buffer): void {
  const key = data.toString();

  // Ctrl+C
  if (key === '\x03') {
    cleanup();
    process.exit(0);
  }

  // q - quit
  if (key === 'q' || key === 'Q') {
    cleanup();
    process.exit(0);
  }

  // r - manual refresh
  if (key === 'r' || key === 'R') {
    tick();
    return;
  }

  // Escape
  if (key === '\x1b' && data.length === 1) {
    if (detailView) {
      detailView = false;
      detailScrollOffset = 0;
    } else {
      selectedGroupIndex = -1;
    }
    render();
    return;
  }

  // Arrow keys (escape sequences)
  if (key === '\x1b[A') {
    // Up
    if (detailView) {
      detailScrollOffset++;
      render();
    } else if (groups.length > 0) {
      selectedGroupIndex = selectedGroupIndex <= 0 ? groups.length - 1 : selectedGroupIndex - 1;
      render();
    }
    return;
  }
  if (key === '\x1b[B') {
    // Down
    if (detailView) {
      detailScrollOffset = Math.max(0, detailScrollOffset - 1);
      render();
    } else if (groups.length > 0) {
      selectedGroupIndex = selectedGroupIndex >= groups.length - 1 ? 0 : selectedGroupIndex + 1;
      render();
    }
    return;
  }

  // Enter - detail view
  if (key === '\r' || key === '\n') {
    if (!detailView && selectedGroupIndex >= 0 && groups[selectedGroupIndex]) {
      detailView = true;
      detailScrollOffset = 0;
      tick(); // Refresh to load detail data
    }
    return;
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  // Enter alternate screen, hide cursor
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);

  // Enable raw mode for keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleInput);
  }

  // Handle resize
  process.stdout.on('resize', render);

  // Handle signals
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Initial render
  tick();

  // Auto-refresh
  refreshTimer = setInterval(tick, REFRESH_INTERVAL);
}

main();
