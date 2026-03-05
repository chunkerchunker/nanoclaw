/**
 * Manage registered groups: list, create, edit, delete, and interactive mode.
 *
 * Usage:
 *   npx tsx scripts/groups.ts -i                                                     Interactive mode
 *   npx tsx scripts/groups.ts list [--channel <channel>]
 *   npx tsx scripts/groups.ts show <jid>
 *   npx tsx scripts/groups.ts create --chat-id <telegram_id> --name <name> --folder <folder> [--trigger <pattern>] [--no-trigger] [--is-main] [--timeout <ms>]
 *   npx tsx scripts/groups.ts edit <jid> [--name <name>] [--trigger <pattern>] [--requires-trigger <true|false>] [--timeout <ms>]
 *   npx tsx scripts/groups.ts delete <jid>
 *   npx tsx scripts/groups.ts diff
 *   npx tsx scripts/groups.ts clean
 */
import * as p from '@clack/prompts';
import fs from 'fs';
import path from 'path';

import type { RegisteredGroup } from '../src/types.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// Set DATA_DIR and STORE_DIR before importing db (which reads config at import time)
process.env.DATA_DIR ??= path.join(PROJECT_ROOT, 'data');
process.env.STORE_DIR ??= path.join(PROJECT_ROOT, 'store');

const { initDatabase, getAllRegisteredGroups, getRegisteredGroup, setRegisteredGroup, deleteRegisteredGroup, getAllSessions, deleteSession } = await import('../src/db.js');
const { TIMEZONE, GROUPS_DIR, DATA_DIR } = await import('../src/config.js');
const { isValidGroupFolder } = await import('../src/group-folder.js');

// ─── Colors ──────────────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const FG_GREEN = '\x1b[32m';
const FG_YELLOW = '\x1b[33m';
const FG_CYAN = '\x1b[36m';
const FG_RED = '\x1b[31m';
const FG_GRAY = '\x1b[90m';
const FG_MAGENTA = '\x1b[35m';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`${FG_RED}Error:${RESET} ${msg}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatDate(iso: string | null): string {
  if (!iso) return `${DIM}—${RESET}`;
  const d = new Date(iso);
  return d.toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short' });
}

function channelFromJid(jid: string): string {
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('sl:')) return 'slack';
  if (jid.startsWith('gm:')) return 'gmail';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp')) return 'whatsapp';
  return 'unknown';
}

function formatTimeout(ms: number | undefined): string {
  if (!ms) return `${DIM}default (5m)${RESET}`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(0)}s`;
}

function boolLabel(val: boolean | undefined, defaultVal: boolean): string {
  const effective = val ?? defaultVal;
  return effective ? `${FG_GREEN}yes${RESET}` : `${FG_GRAY}no${RESET}`;
}

type GroupEntry = { jid: string } & RegisteredGroup;

function getAllGroupEntries(): GroupEntry[] {
  const groups = getAllRegisteredGroups();
  return Object.entries(groups).map(([jid, g]) => ({ jid, ...g }));
}

// ─── Display ─────────────────────────────────────────────────────────────────

function printGroupDetail(jid: string, g: RegisteredGroup): void {
  console.log(`  ${DIM}JID:${RESET}              ${FG_CYAN}${jid}${RESET}`);
  console.log(`  ${DIM}Name:${RESET}             ${g.name}`);
  console.log(`  ${DIM}Folder:${RESET}           ${g.folder}`);
  console.log(`  ${DIM}Channel:${RESET}          ${channelFromJid(jid)}`);
  console.log(`  ${DIM}Trigger:${RESET}          ${g.trigger}`);
  console.log(`  ${DIM}Requires trigger:${RESET} ${boolLabel(g.requiresTrigger, true)}`);
  console.log(`  ${DIM}Is main:${RESET}          ${boolLabel(g.isMain, false)}`);
  console.log(`  ${DIM}Timeout:${RESET}          ${formatTimeout(g.containerConfig?.timeout)}`);
  console.log(`  ${DIM}Added:${RESET}            ${formatDate(g.added_at)}`);
  if (g.containerConfig?.additionalMounts?.length) {
    console.log(`  ${DIM}Mounts:${RESET}`);
    for (const m of g.containerConfig.additionalMounts) {
      const rw = m.readonly === false ? 'rw' : 'ro';
      console.log(`    ${DIM}•${RESET} ${m.hostPath} → ${m.containerPath || path.basename(m.hostPath)} (${rw})`);
    }
  }
  const groupDir = path.join(GROUPS_DIR, g.folder);
  const hasDir = fs.existsSync(groupDir);
  console.log(`  ${DIM}Directory:${RESET}        ${hasDir ? `${FG_GREEN}exists${RESET}` : `${FG_YELLOW}missing${RESET}`} (groups/${g.folder}/)`);
}

function printGroupTable(groups: GroupEntry[]): void {
  if (groups.length === 0) {
    console.log(`${DIM}No groups found.${RESET}`);
    return;
  }

  console.log(
    `${BOLD}${'#'.padEnd(4)} ${'Folder'.padEnd(22)} ${'Name'.padEnd(24)} ${'Channel'.padEnd(12)} ${'Trigger'.padEnd(20)} ${'Main'.padEnd(6)} ${'Trig?'.padEnd(6)} JID${RESET}`,
  );
  console.log(`${DIM}${'─'.repeat(130)}${RESET}`);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const ch = channelFromJid(g.jid);
    const mainRaw = g.isMain ? 'yes' : 'no';
    const mainCol = g.isMain ? FG_MAGENTA : DIM;
    const trigRaw = (g.requiresTrigger ?? true) ? 'yes' : 'no';
    const trigCol = (g.requiresTrigger ?? true) ? FG_GREEN : DIM;
    console.log(
      `${DIM}${String(i + 1).padEnd(4)}${RESET}` +
      `${FG_CYAN}${g.folder.padEnd(22)}${RESET} ` +
      `${g.name.padEnd(24)} ` +
      `${ch.padEnd(12)} ` +
      `${truncate(g.trigger, 18).padEnd(20)} ` +
      `${mainCol}${mainRaw.padEnd(6)}${RESET} ` +
      `${trigCol}${trigRaw.padEnd(6)}${RESET} ` +
      `${DIM}${g.jid}${RESET}`,
    );
  }

  console.log(`\n${DIM}${groups.length} group(s)${RESET}`);
}

// ─── CLI Commands ────────────────────────────────────────────────────────────

function cmdList(args: string[]): void {
  const channelFilter = flag(args, 'channel');
  let groups = getAllGroupEntries();
  if (channelFilter) groups = groups.filter((g) => channelFromJid(g.jid) === channelFilter);
  printGroupTable(groups);
}

function cmdShow(args: string[]): void {
  const jid = args[0];
  if (!jid || jid.startsWith('--')) die('JID is required');
  const group = getRegisteredGroup(jid);
  if (!group) die(`Group not found: ${jid}`);
  printGroupDetail(jid, group);
}

function cmdCreate(args: string[]): void {
  const chatId = flag(args, 'chat-id');
  const name = flag(args, 'name');
  const folder = flag(args, 'folder');
  const trigger = flag(args, 'trigger') || '^@Andy\\b';
  const requiresTrigger = !hasFlag(args, 'no-trigger');
  const isMain = hasFlag(args, 'is-main');
  const timeout = flag(args, 'timeout');

  if (!chatId) die('--chat-id is required (Telegram chat ID, e.g. -1001234567890)');
  if (!name) die('--name is required');
  if (!folder) die('--folder is required');
  if (!isValidGroupFolder(folder)) die(`Invalid folder name: ${folder}`);

  const jid = chatId.startsWith('tg:') ? chatId : `tg:${chatId}`;

  const group: RegisteredGroup = {
    name,
    folder,
    trigger,
    added_at: new Date().toISOString(),
    requiresTrigger,
    isMain: isMain || undefined,
  };

  if (timeout) {
    const ms = parseInt(timeout, 10);
    if (isNaN(ms) || ms <= 0) die(`Invalid timeout: ${timeout}`);
    group.containerConfig = { timeout: ms };
  }

  setRegisteredGroup(jid, group);

  // Create group directory
  const groupDir = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  console.log(`${FG_GREEN}✓${RESET} Registered group ${FG_CYAN}${folder}${RESET}`);
  printGroupDetail(jid, group);
}

function cmdEdit(args: string[]): void {
  const jid = args[0];
  if (!jid || jid.startsWith('--')) die('JID is required');

  const existing = getRegisteredGroup(jid);
  if (!existing) die(`Group not found: ${jid}`);

  const name = flag(args, 'name');
  const trigger = flag(args, 'trigger');
  const requiresTriggerStr = flag(args, 'requires-trigger');
  const timeout = flag(args, 'timeout');

  const updated: RegisteredGroup = { ...existing };
  if (name) updated.name = name;
  if (trigger) updated.trigger = trigger;
  if (requiresTriggerStr !== undefined) updated.requiresTrigger = requiresTriggerStr === 'true';
  if (timeout) {
    const ms = parseInt(timeout, 10);
    if (isNaN(ms) || ms <= 0) die(`Invalid timeout: ${timeout}`);
    updated.containerConfig = { ...updated.containerConfig, timeout: ms };
  }

  setRegisteredGroup(jid, updated);
  console.log(`${FG_GREEN}✓${RESET} Updated group ${FG_CYAN}${existing.folder}${RESET}`);
  printGroupDetail(jid, updated);
}

function cmdDelete(args: string[]): void {
  const jid = args[0];
  if (!jid || jid.startsWith('--')) die('JID is required');

  const group = getRegisteredGroup(jid);
  if (!group) die(`Group not found: ${jid}`);

  deleteRegisteredGroup(jid);

  console.log(`${FG_GREEN}✓${RESET} Deleted group ${FG_CYAN}${group.folder}${RESET} (${jid})`);
  console.log(`${DIM}Note: Group directory groups/${group.folder}/ was NOT removed.${RESET}`);
}

// ─── Diff ────────────────────────────────────────────────────────────────────

function cmdDiff(): void {
  const dbGroups = getAllRegisteredGroups();
  const dbFolders = new Map(Object.entries(dbGroups).map(([jid, g]) => [g.folder, { jid, ...g }]));
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const sessionsDir = path.join(DATA_DIR, 'sessions');

  let hasDiff = false;

  // 1. Check each DB group against filesystem
  for (const [folder, g] of dbFolders) {
    const issues: string[] = [];

    // Group directory
    const groupDir = path.join(GROUPS_DIR, folder);
    if (!fs.existsSync(groupDir)) {
      issues.push(`${FG_YELLOW}groups/${folder}/ missing${RESET}`);
    }

    // IPC directory
    const ipcDir = path.join(ipcBaseDir, folder);
    if (!fs.existsSync(ipcDir)) {
      issues.push(`${FG_YELLOW}ipc/${folder}/ missing${RESET}`);
    } else {
      // Check available_groups.json for main groups
      const agFile = path.join(ipcDir, 'available_groups.json');
      if (g.isMain && !fs.existsSync(agFile)) {
        issues.push(`${FG_YELLOW}available_groups.json missing${RESET} (main group)`);
      }

      // Check current_tasks.json
      const ctFile = path.join(ipcDir, 'current_tasks.json');
      if (!fs.existsSync(ctFile)) {
        issues.push(`${FG_YELLOW}current_tasks.json missing${RESET}`);
      }
    }

    // Session directory
    const sessionDir = path.join(sessionsDir, folder);
    if (!fs.existsSync(sessionDir)) {
      issues.push(`${DIM}sessions/${folder}/ missing (no sessions yet)${RESET}`);
    }

    if (issues.length === 0) {
      console.log(`${FG_GREEN}✓${RESET} ${BOLD}${folder}${RESET} ${DIM}(${g.name})${RESET}`);
    } else {
      hasDiff = true;
      console.log(`${FG_YELLOW}~${RESET} ${BOLD}${folder}${RESET} ${DIM}(${g.name})${RESET}`);
      for (const issue of issues) {
        console.log(`    ${issue}`);
      }
    }
  }

  // 2. Check for orphan group directories (in groups/ but not in DB)
  if (fs.existsSync(GROUPS_DIR)) {
    for (const dir of fs.readdirSync(GROUPS_DIR)) {
      if (dir === 'global' || dir.startsWith('.')) continue;
      if (!dbFolders.has(dir)) {
        hasDiff = true;
        console.log(`${FG_RED}?${RESET} ${BOLD}${dir}${RESET}: orphan group directory ${DIM}(groups/${dir}/ exists but not registered in DB)${RESET}`);
      }
    }
  }

  // 3. Check for orphan IPC directories (not belonging to any registered group)
  if (fs.existsSync(ipcBaseDir)) {
    for (const dir of fs.readdirSync(ipcBaseDir)) {
      if (dir === 'errors' || dir.startsWith('.')) continue;
      if (!dbFolders.has(dir)) {
        hasDiff = true;
        const contents: string[] = [];
        const ipcDir = path.join(ipcBaseDir, dir);
        if (fs.existsSync(path.join(ipcDir, 'current_tasks.json'))) contents.push('tasks');
        if (fs.existsSync(path.join(ipcDir, 'available_groups.json'))) contents.push('groups snapshot');
        const hint = contents.length > 0 ? ` — has: ${contents.join(', ')}` : '';
        console.log(`${FG_RED}?${RESET} ${BOLD}${dir}${RESET}: orphan IPC directory${hint}`);
      }
    }
  }

  // 4. Check for orphan session directories
  if (fs.existsSync(sessionsDir)) {
    for (const dir of fs.readdirSync(sessionsDir)) {
      if (dir.startsWith('.')) continue;
      if (!dbFolders.has(dir)) {
        hasDiff = true;
        console.log(`${FG_RED}?${RESET} ${BOLD}${dir}${RESET}: orphan session directory ${DIM}(data/sessions/${dir}/)${RESET}`);
      }
    }
  }

  // 5. Check for orphan DB sessions (session entries for folders not in registered groups)
  const sessions = getAllSessions();
  for (const folder of Object.keys(sessions)) {
    if (!dbFolders.has(folder)) {
      hasDiff = true;
      console.log(`${FG_RED}?${RESET} ${BOLD}${folder}${RESET}: orphan session in DB ${DIM}(session entry exists but group not registered)${RESET}`);
    }
  }

  if (!hasDiff) {
    console.log(`\n${FG_GREEN}All groups in sync.${RESET}`);
  } else {
    console.log(`\n${DIM}Run \`npx tsx scripts/groups.ts clean\` to remove orphans.${RESET}`);
  }
}

// ─── Clean ───────────────────────────────────────────────────────────────────

interface Orphan {
  folder: string;
  kind: 'group-dir' | 'ipc-dir' | 'session-dir' | 'session-db';
  description: string;
  path?: string;
}

function findOrphans(): Orphan[] {
  const dbGroups = getAllRegisteredGroups();
  const dbFolders = new Set(Object.values(dbGroups).map((g) => g.folder));
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  const orphans: Orphan[] = [];

  // Orphan group directories
  if (fs.existsSync(GROUPS_DIR)) {
    for (const dir of fs.readdirSync(GROUPS_DIR)) {
      if (dir === 'global' || dir.startsWith('.')) continue;
      if (!dbFolders.has(dir)) {
        orphans.push({ folder: dir, kind: 'group-dir', description: `groups/${dir}/`, path: path.join(GROUPS_DIR, dir) });
      }
    }
  }

  // Orphan IPC directories
  if (fs.existsSync(ipcBaseDir)) {
    for (const dir of fs.readdirSync(ipcBaseDir)) {
      if (dir === 'errors' || dir.startsWith('.')) continue;
      if (!dbFolders.has(dir)) {
        orphans.push({ folder: dir, kind: 'ipc-dir', description: `data/ipc/${dir}/`, path: path.join(ipcBaseDir, dir) });
      }
    }
  }

  // Orphan session directories
  if (fs.existsSync(sessionsDir)) {
    for (const dir of fs.readdirSync(sessionsDir)) {
      if (dir.startsWith('.')) continue;
      if (!dbFolders.has(dir)) {
        orphans.push({ folder: dir, kind: 'session-dir', description: `data/sessions/${dir}/`, path: path.join(sessionsDir, dir) });
      }
    }
  }

  // Orphan DB sessions
  const sessions = getAllSessions();
  for (const folder of Object.keys(sessions)) {
    if (!dbFolders.has(folder)) {
      orphans.push({ folder, kind: 'session-db', description: `DB session for "${folder}"` });
    }
  }

  return orphans;
}

async function cmdClean(): Promise<void> {
  const orphans = findOrphans();

  if (orphans.length === 0) {
    console.log(`${FG_GREEN}No orphans found.${RESET}`);
    return;
  }

  console.log(`${BOLD}Found ${orphans.length} orphan(s):${RESET}\n`);
  for (const o of orphans) {
    const icon = o.kind === 'session-db' ? FG_YELLOW : FG_RED;
    console.log(`  ${icon}•${RESET} ${o.description}`);
  }

  // Group by folder for the interactive selector
  const folders = [...new Set(orphans.map((o) => o.folder))];

  const toClean = await p.multiselect({
    message: 'Select orphans to remove',
    options: folders.map((f) => {
      const items = orphans.filter((o) => o.folder === f);
      const kinds = items.map((i) => i.kind.replace('-dir', '').replace('-db', ' (DB)')).join(', ');
      return { value: f, label: f, hint: kinds };
    }),
    required: false,
  });

  if (p.isCancel(toClean) || toClean.length === 0) {
    p.log.info('Nothing removed.');
    return;
  }

  const selected = new Set(toClean);
  let removed = 0;

  for (const o of orphans) {
    if (!selected.has(o.folder)) continue;

    if (o.kind === 'session-db') {
      deleteSession(o.folder);
      console.log(`  ${FG_GREEN}✓${RESET} Deleted DB session: ${o.folder}`);
    } else if (o.path) {
      fs.rmSync(o.path, { recursive: true, force: true });
      console.log(`  ${FG_GREEN}✓${RESET} Removed ${o.description}`);
    }
    removed++;
  }

  p.log.success(`Cleaned ${removed} orphan(s).`);
}

// ─── Interactive Mode ────────────────────────────────────────────────────────

function groupSelectOptions(groups: GroupEntry[]): Array<{ value: GroupEntry; label: string; hint: string }> {
  return groups.map((g) => ({
    value: g,
    label: `${g.folder} (${g.name})`,
    hint: `${channelFromJid(g.jid)} | ${g.jid}`,
  }));
}

async function interactiveSelectGroup(groups: GroupEntry[]): Promise<GroupEntry | symbol> {
  if (groups.length === 0) {
    p.log.warn('No groups to select from.');
    return Symbol();
  }
  return p.select({
    message: 'Select a group',
    options: groupSelectOptions(groups),
  });
}

async function interactiveCreate(): Promise<void> {
  const result = await p.group({
    chatId: () =>
      p.text({
        message: 'Telegram chat ID',
        placeholder: '-1001234567890',
        validate(v) {
          if (!v.trim()) return 'Chat ID is required';
          const id = v.trim().replace(/^tg:/, '');
          if (!/^-?\d+$/.test(id)) return 'Must be a numeric Telegram chat ID';
        },
      }),
    name: () =>
      p.text({
        message: 'Display name',
        validate: (v) => (v.trim() ? undefined : 'Name is required'),
      }),
    folder: () =>
      p.text({
        message: 'Folder name',
        placeholder: 'my-group',
        validate(v) {
          if (!v.trim()) return 'Folder is required';
          if (!isValidGroupFolder(v.trim())) return 'Must be alphanumeric with hyphens/underscores, max 64 chars, not "global"';
          const existing = getAllGroupEntries();
          if (existing.some((g) => g.folder === v.trim())) return 'Folder already in use by another group';
        },
      }),
    trigger: () =>
      p.text({
        message: 'Trigger pattern (regex)',
        initialValue: '^@Andy\\b',
      }),
    requiresTrigger: () =>
      p.select({
        message: 'Requires trigger?',
        options: [
          { value: true, label: 'Yes', hint: 'agent only responds when trigger matches' },
          { value: false, label: 'No', hint: 'agent processes every message' },
        ],
      }),
    isMain: () =>
      p.select({
        message: 'Is this the main control group?',
        options: [
          { value: false, label: 'No', hint: 'normal group' },
          { value: true, label: 'Yes', hint: 'elevated privileges, sees all groups' },
        ],
      }),
    timeout: () =>
      p.select({
        message: 'Container timeout',
        options: [
          { value: undefined, label: 'Default (5 minutes)' },
          { value: 120000, label: '2 minutes' },
          { value: 300000, label: '5 minutes' },
          { value: 600000, label: '10 minutes' },
          { value: 900000, label: '15 minutes' },
          { value: 1800000, label: '30 minutes' },
        ],
      }),
  });

  // Build JID from chat ID
  const chatIdRaw = result.chatId.trim().replace(/^tg:/, '');
  const jid = `tg:${chatIdRaw}`;

  // Summary
  console.log();
  console.log(`  ${DIM}JID:${RESET}              ${jid}`);
  console.log(`  ${DIM}Name:${RESET}             ${result.name}`);
  console.log(`  ${DIM}Folder:${RESET}           ${result.folder}`);
  console.log(`  ${DIM}Trigger:${RESET}          ${result.trigger}`);
  console.log(`  ${DIM}Requires trigger:${RESET} ${result.requiresTrigger ? 'yes' : 'no'}`);
  console.log(`  ${DIM}Is main:${RESET}          ${result.isMain ? 'yes' : 'no'}`);
  console.log(`  ${DIM}Timeout:${RESET}          ${formatTimeout(result.timeout)}`);

  const confirmed = await p.confirm({ message: 'Register this group?' });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info('Cancelled.');
    return;
  }

  const group: RegisteredGroup = {
    name: result.name,
    folder: result.folder,
    trigger: result.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: result.requiresTrigger,
    isMain: result.isMain || undefined,
  };

  if (result.timeout) {
    group.containerConfig = { timeout: result.timeout };
  }

  setRegisteredGroup(jid, group);

  // Create group directory
  const groupDir = path.join(GROUPS_DIR, result.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  p.log.success(`Registered group ${result.folder}`);
  printGroupDetail(jid, group);
}

async function interactiveEdit(groups: GroupEntry[]): Promise<void> {
  const group = await interactiveSelectGroup(groups);
  if (p.isCancel(group)) return;

  printGroupDetail(group.jid, group);

  while (true) {
    const field = await p.select({
      message: 'Edit field',
      options: [
        { value: 'name', label: 'Name', hint: group.name },
        { value: 'trigger', label: 'Trigger pattern', hint: group.trigger },
        { value: 'requiresTrigger', label: 'Requires trigger', hint: (group.requiresTrigger ?? true) ? 'yes' : 'no' },
        { value: 'timeout', label: 'Container timeout', hint: formatTimeout(group.containerConfig?.timeout) },
        { value: 'done', label: 'Done' },
      ],
    });
    if (p.isCancel(field) || field === 'done') break;

    if (field === 'name') {
      const val = await p.text({ message: 'Display name', initialValue: group.name, validate: (v) => (v.trim() ? undefined : 'Required') });
      if (p.isCancel(val)) continue;
      group.name = val;
    } else if (field === 'trigger') {
      const val = await p.text({ message: 'Trigger pattern (regex)', initialValue: group.trigger });
      if (p.isCancel(val)) continue;
      group.trigger = val;
    } else if (field === 'requiresTrigger') {
      const val = await p.select({
        message: 'Requires trigger?',
        options: [
          { value: true, label: 'Yes', hint: 'agent only responds when trigger matches' },
          { value: false, label: 'No', hint: 'agent processes every message' },
        ],
        initialValue: group.requiresTrigger ?? true,
      });
      if (p.isCancel(val)) continue;
      group.requiresTrigger = val;
    } else if (field === 'timeout') {
      const val = await p.select({
        message: 'Container timeout',
        options: [
          { value: undefined, label: 'Default (5 minutes)' },
          { value: 120000, label: '2 minutes' },
          { value: 300000, label: '5 minutes' },
          { value: 600000, label: '10 minutes' },
          { value: 900000, label: '15 minutes' },
          { value: 1800000, label: '30 minutes' },
        ],
      });
      if (p.isCancel(val)) continue;
      if (val) {
        group.containerConfig = { ...group.containerConfig, timeout: val };
      } else {
        if (group.containerConfig) {
          delete group.containerConfig.timeout;
          if (Object.keys(group.containerConfig).length === 0 || (Object.keys(group.containerConfig).length === 1 && !group.containerConfig.additionalMounts?.length)) {
            group.containerConfig = undefined;
          }
        }
      }
    }

    setRegisteredGroup(group.jid, group);
    p.log.success(`Updated ${group.folder}`);
    printGroupDetail(group.jid, group);
  }
}

async function interactiveDelete(groups: GroupEntry[]): Promise<void> {
  const group = await interactiveSelectGroup(groups);
  if (p.isCancel(group)) return;

  printGroupDetail(group.jid, group);

  const confirmed = await p.confirm({ message: 'Delete this group registration?' });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info('Cancelled.');
    return;
  }

  deleteRegisteredGroup(group.jid);

  p.log.success(`Deleted ${group.folder} (${group.jid})`);
  p.log.info(`Group directory groups/${group.folder}/ was NOT removed.`);
}

async function interactiveShow(groups: GroupEntry[]): Promise<void> {
  const group = await interactiveSelectGroup(groups);
  if (p.isCancel(group)) return;
  console.log();
  printGroupDetail(group.jid, group);
}

async function interactiveMode(): Promise<void> {
  p.intro('NanoClaw Group Manager');

  while (true) {
    const groups = getAllGroupEntries();
    printGroupTable(groups);

    const action = await p.select({
      message: 'Action',
      options: [
        { value: 'show', label: 'Show', hint: 'view group details' },
        { value: 'edit', label: 'Edit', hint: 'modify a group' },
        { value: 'delete', label: 'Delete', hint: 'unregister a group' },
        { value: 'create', label: 'Create', hint: 'register a new group' },
        { value: 'diff', label: 'Diff', hint: 'DB vs filesystem consistency' },
        { value: 'clean', label: 'Clean', hint: 'remove orphan directories' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (p.isCancel(action) || action === 'quit') {
      p.outro('Goodbye!');
      return;
    }

    switch (action) {
      case 'show':
        await interactiveShow(groups);
        break;
      case 'edit':
        await interactiveEdit(groups);
        break;
      case 'delete':
        await interactiveDelete(groups);
        break;
      case 'create':
        await interactiveCreate();
        break;
      case 'diff':
        console.log();
        cmdDiff();
        break;
      case 'clean':
        await cmdClean();
        break;
    }

    console.log();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

initDatabase();

const args = process.argv.slice(2);
const interactive = args.includes('-i');
const filteredArgs = args.filter((a) => a !== '-i');
const [command, ...rest] = filteredArgs;

if (interactive) {
  await interactiveMode();
} else switch (command) {
  case 'list':
  case 'ls':
    cmdList(rest);
    break;
  case 'show':
  case 'info':
    cmdShow(rest);
    break;
  case 'create':
  case 'add':
    cmdCreate(rest);
    break;
  case 'edit':
  case 'update':
    cmdEdit(rest);
    break;
  case 'delete':
  case 'rm':
    cmdDelete(rest);
    break;
  case 'diff':
    cmdDiff();
    break;
  case 'clean':
    await cmdClean();
    break;
  default:
    console.log(`${BOLD}NanoClaw Group Manager${RESET}\n`);
    console.log('Commands:');
    console.log(`  ${FG_CYAN}-i${RESET}                                                     Interactive mode`);
    console.log(`  ${FG_CYAN}list${RESET}   [--channel <channel>]                            List groups`);
    console.log(`  ${FG_CYAN}show${RESET}   <jid>                                            Show group details`);
    console.log(`  ${FG_CYAN}create${RESET} --chat-id <id> --name <n> --folder <f> [--trigger <p>] Register a group`);
    console.log(`  ${FG_CYAN}edit${RESET}   <jid> [--name <n>] [--trigger <p>] ...            Edit a group`);
    console.log(`  ${FG_CYAN}delete${RESET} <jid>                                            Unregister a group`);
    console.log(`  ${FG_CYAN}diff${RESET}                                                    DB vs filesystem diff`);
    console.log(`  ${FG_CYAN}clean${RESET}                                                   Remove orphan directories`);
    break;
}
