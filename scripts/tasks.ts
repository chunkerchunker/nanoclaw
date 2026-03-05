/**
 * Manage scheduled tasks: list, create, edit, delete, sync, diff, and interactive mode.
 *
 * Usage:
 *   npx tsx scripts/tasks.ts -i                                            Interactive mode
 *   npx tsx scripts/tasks.ts list [--group <folder>] [--status <status>]
 *   npx tsx scripts/tasks.ts create --group <folder> --jid <chat_jid> --prompt <prompt> --type <cron|interval|once> --value <schedule_value> [--context <group|isolated>]
 *   npx tsx scripts/tasks.ts edit <task-id> [--prompt <prompt>] [--type <type>] [--value <value>] [--status <status>]
 *   npx tsx scripts/tasks.ts delete <task-id>
 *   npx tsx scripts/tasks.ts sync
 *   npx tsx scripts/tasks.ts diff
 */
import * as p from '@clack/prompts';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import type { ScheduledTask } from '../src/types.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// Set DATA_DIR and STORE_DIR before importing db (which reads config at import time)
process.env.DATA_DIR ??= path.join(PROJECT_ROOT, 'data');
process.env.STORE_DIR ??= path.join(PROJECT_ROOT, 'store');

const { initDatabase, getAllTasks, getTasksForGroup, getTaskById, createTask, updateTask, deleteTask } = await import('../src/db.js');
const { TIMEZONE, DATA_DIR } = await import('../src/config.js');
const { writeTasksSnapshot } = await import('../src/container-runner.js');
const { getAllRegisteredGroups } = await import('../src/db.js');

// ─── Colors ──────────────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const UNDERLINE = '\x1b[4m';
const FG_GREEN = '\x1b[32m';
const FG_YELLOW = '\x1b[33m';
const FG_CYAN = '\x1b[36m';
const FG_RED = '\x1b[31m';
const FG_GRAY = '\x1b[90m';
const FG_MAGENTA = '\x1b[35m';
const BG_CYAN = '\x1b[46m';
const FG_BLACK = '\x1b[30m';

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

function formatDate(iso: string | null): string {
  if (!iso) return `${DIM}—${RESET}`;
  const d = new Date(iso);
  return d.toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short' });
}

function formatSchedule(type: string, value: string): string {
  if (type === 'cron') return `cron: ${value}`;
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (ms >= 86400000) return `every ${(ms / 86400000).toFixed(1)}d`;
    if (ms >= 3600000) return `every ${(ms / 3600000).toFixed(1)}h`;
    if (ms >= 60000) return `every ${(ms / 60000).toFixed(0)}m`;
    return `every ${(ms / 1000).toFixed(0)}s`;
  }
  if (type === 'once') return `once: ${formatDate(value)}`;
  return `${type}: ${value}`;
}

function statusColor(status: string): string {
  if (status === 'active') return FG_GREEN;
  if (status === 'paused') return FG_YELLOW;
  return FG_GRAY;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function computeNextRun(type: string, value: string): string | null {
  if (type === 'cron') {
    const interval = CronExpressionParser.parse(value, { tz: TIMEZONE });
    return interval.next().toISOString();
  }
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) die(`Invalid interval: ${value}`);
    return new Date(Date.now() + ms).toISOString();
  }
  if (type === 'once') {
    const d = new Date(value);
    if (isNaN(d.getTime())) die(`Invalid timestamp: ${value}`);
    return d.toISOString();
  }
  die(`Unknown schedule type: ${type}`);
}

function printTaskDetail(t: ScheduledTask): void {
  console.log(`  ${DIM}ID:${RESET}       ${FG_CYAN}${t.id}${RESET}`);
  console.log(`  ${DIM}Group:${RESET}    ${t.group_folder}`);
  console.log(`  ${DIM}JID:${RESET}      ${t.chat_jid}`);
  console.log(`  ${DIM}Status:${RESET}   ${statusColor(t.status)}${t.status}${RESET}`);
  console.log(`  ${DIM}Schedule:${RESET} ${formatSchedule(t.schedule_type, t.schedule_value)}`);
  console.log(`  ${DIM}Next run:${RESET} ${formatDate(t.next_run)}`);
  console.log(`  ${DIM}Last run:${RESET} ${formatDate(t.last_run)}`);
  console.log(`  ${DIM}Context:${RESET}  ${t.context_mode || 'isolated'}`);
  console.log(`  ${DIM}Prompt:${RESET}   ${t.prompt}`);
}

// ─── Sync ────────────────────────────────────────────────────────────────────

function syncSnapshots(): void {
  const tasks = getAllTasks();
  const mapped = tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));
  const groups = getAllRegisteredGroups();
  let count = 0;
  for (const group of Object.values(groups)) {
    writeTasksSnapshot(group.folder, group.isMain === true, mapped);
    count++;
  }
  console.log(`${FG_GREEN}✓${RESET} Synced task snapshots for ${count} group(s)`);
}

// ─── Diff ────────────────────────────────────────────────────────────────────

interface SnapshotTask {
  id: string;
  groupFolder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

function cmdDiff(): void {
  const dbTasks = getAllTasks();
  const groups = getAllRegisteredGroups();
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');

  // Build expected snapshots per group (same logic as writeTasksSnapshot)
  const dbMapped: SnapshotTask[] = dbTasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));

  let hasDiff = false;

  // Check each group's snapshot
  for (const group of Object.values(groups)) {
    const snapshotPath = path.join(ipcBaseDir, group.folder, 'current_tasks.json');
    const isMain = group.isMain === true;
    const expectedTasks = isMain
      ? dbMapped
      : dbMapped.filter((t) => t.groupFolder === group.folder);

    let actualTasks: SnapshotTask[] = [];
    let fileExists = false;

    if (fs.existsSync(snapshotPath)) {
      fileExists = true;
      try {
        actualTasks = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      } catch {
        console.log(`${FG_RED}✗${RESET} ${BOLD}${group.folder}${RESET}: ${FG_RED}invalid JSON${RESET} in ${snapshotPath}`);
        hasDiff = true;
        continue;
      }
    }

    // Compare
    const expectedById = new Map(expectedTasks.map((t) => [t.id, t]));
    const actualById = new Map(actualTasks.map((t) => [t.id, t]));

    const missing: SnapshotTask[] = []; // in DB but not in snapshot
    const extra: SnapshotTask[] = [];   // in snapshot but not in DB
    const changed: Array<{ id: string; fields: string[] }> = [];

    for (const [id, expected] of expectedById) {
      const actual = actualById.get(id);
      if (!actual) {
        missing.push(expected);
      } else {
        const diffs: string[] = [];
        if (actual.prompt !== expected.prompt) diffs.push('prompt');
        if (actual.schedule_type !== expected.schedule_type) diffs.push('schedule_type');
        if (actual.schedule_value !== expected.schedule_value) diffs.push('schedule_value');
        if (actual.status !== expected.status) diffs.push('status');
        if (actual.next_run !== expected.next_run) diffs.push('next_run');
        if (diffs.length > 0) changed.push({ id, fields: diffs });
      }
    }

    for (const [id, actual] of actualById) {
      if (!expectedById.has(id)) extra.push(actual);
    }

    if (!fileExists && expectedTasks.length === 0) continue; // both empty, no snapshot needed

    if (missing.length === 0 && extra.length === 0 && changed.length === 0 && fileExists) {
      console.log(`${FG_GREEN}✓${RESET} ${BOLD}${group.folder}${RESET}: in sync (${expectedTasks.length} task(s))`);
      continue;
    }

    hasDiff = true;
    console.log(`${FG_YELLOW}~${RESET} ${BOLD}${group.folder}${RESET}:`);

    if (!fileExists) {
      console.log(`    ${FG_RED}snapshot file missing${RESET} (expected ${expectedTasks.length} task(s))`);
      continue;
    }

    for (const t of missing) {
      console.log(`    ${FG_GREEN}+ DB only:${RESET} ${t.id} — ${truncate(t.prompt, 50)}`);
    }
    for (const t of extra) {
      console.log(`    ${FG_RED}- Snapshot only:${RESET} ${t.id} — ${truncate(t.prompt, 50)}`);
    }
    for (const c of changed) {
      const expected = expectedById.get(c.id)!;
      const actual = actualById.get(c.id)!;
      console.log(`    ${FG_YELLOW}~ Changed:${RESET} ${c.id}`);
      for (const field of c.fields) {
        const expVal = (expected as Record<string, unknown>)[field];
        const actVal = (actual as Record<string, unknown>)[field];
        const expStr = field === 'prompt' ? truncate(String(expVal), 40) : String(expVal);
        const actStr = field === 'prompt' ? truncate(String(actVal), 40) : String(actVal);
        console.log(`      ${DIM}${field}:${RESET} ${FG_RED}${actStr}${RESET} → ${FG_GREEN}${expStr}${RESET}`);
      }
    }
  }

  // Check for orphan snapshot dirs not in registered groups
  if (fs.existsSync(ipcBaseDir)) {
    const groupFolders = new Set(Object.values(groups).map((g) => g.folder));
    for (const dir of fs.readdirSync(ipcBaseDir)) {
      if (dir === 'errors') continue;
      const snapshotPath = path.join(ipcBaseDir, dir, 'current_tasks.json');
      if (fs.existsSync(snapshotPath) && !groupFolders.has(dir)) {
        hasDiff = true;
        const tasks: SnapshotTask[] = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
        console.log(`${FG_RED}?${RESET} ${BOLD}${dir}${RESET}: orphan snapshot (${tasks.length} task(s), group not registered)`);
      }
    }
  }

  if (!hasDiff) {
    console.log(`\n${FG_GREEN}All snapshots in sync with DB.${RESET}`);
  } else {
    console.log(`\n${DIM}Run \`npx tsx scripts/tasks.ts sync\` to fix.${RESET}`);
  }
}

// ─── CLI Commands ────────────────────────────────────────────────────────────

function cmdList(args: string[]): void {
  const groupFilter = flag(args, 'group');
  const statusFilter = flag(args, 'status');

  let tasks = groupFilter ? getTasksForGroup(groupFilter) : getAllTasks();
  if (statusFilter) tasks = tasks.filter((t) => t.status === statusFilter);

  printTaskTable(tasks);
}

function printTaskTable(tasks: ScheduledTask[]): void {
  if (tasks.length === 0) {
    console.log(`${DIM}No tasks found.${RESET}`);
    return;
  }

  console.log(
    `${BOLD}${'#'.padEnd(4)} ${'ID'.padEnd(28)} ${'Group'.padEnd(20)} ${'Status'.padEnd(10)} ${'Schedule'.padEnd(20)} ${'Next Run'.padEnd(20)} Prompt${RESET}`,
  );
  console.log(`${DIM}${'─'.repeat(130)}${RESET}`);

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const sc = statusColor(t.status);
    console.log(
      `${DIM}${String(i + 1).padEnd(4)}${RESET}` +
      `${FG_CYAN}${t.id.padEnd(28)}${RESET} ` +
      `${t.group_folder.padEnd(20)} ` +
      `${sc}${t.status.padEnd(10)}${RESET} ` +
      `${formatSchedule(t.schedule_type, t.schedule_value).padEnd(20)} ` +
      `${formatDate(t.next_run).padEnd(20)} ` +
      `${truncate(t.prompt, 50)}`,
    );
  }

  console.log(`\n${DIM}${tasks.length} task(s)${RESET}`);
}

function cmdCreate(args: string[]): void {
  const group = flag(args, 'group');
  const jid = flag(args, 'jid');
  const prompt = flag(args, 'prompt');
  const type = flag(args, 'type') as 'cron' | 'interval' | 'once' | undefined;
  const value = flag(args, 'value');
  const contextMode = (flag(args, 'context') || 'isolated') as 'group' | 'isolated';

  if (!group) die('--group is required');
  if (!jid) die('--jid is required');
  if (!prompt) die('--prompt is required');
  if (!type) die('--type is required (cron, interval, or once)');
  if (!value) die('--value is required');
  if (!['cron', 'interval', 'once'].includes(type)) die(`Invalid type: ${type}`);
  if (!['group', 'isolated'].includes(contextMode)) die(`Invalid context: ${contextMode}`);

  const nextRun = computeNextRun(type, value);
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  createTask({
    id: taskId,
    group_folder: group,
    chat_jid: jid,
    prompt,
    schedule_type: type,
    schedule_value: value,
    context_mode: contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  console.log(`${FG_GREEN}✓${RESET} Created task ${FG_CYAN}${taskId}${RESET}`);
  console.log(`  Group:    ${group}`);
  console.log(`  Schedule: ${formatSchedule(type, value)}`);
  console.log(`  Next run: ${formatDate(nextRun)}`);
  console.log(`  Prompt:   ${prompt}`);

  syncSnapshots();
}

function cmdEdit(args: string[]): void {
  const taskId = args[0];
  if (!taskId || taskId.startsWith('--')) die('Task ID is required');

  const task = getTaskById(taskId);
  if (!task) die(`Task not found: ${taskId}`);

  const prompt = flag(args, 'prompt');
  const type = flag(args, 'type') as 'cron' | 'interval' | 'once' | undefined;
  const value = flag(args, 'value');
  const status = flag(args, 'status') as 'active' | 'paused' | 'completed' | undefined;

  if (type && !['cron', 'interval', 'once'].includes(type)) die(`Invalid type: ${type}`);
  if (status && !['active', 'paused', 'completed'].includes(status)) die(`Invalid status: ${status}`);

  const updates: Parameters<typeof updateTask>[1] = {};
  if (prompt) updates.prompt = prompt;
  if (type) updates.schedule_type = type;
  if (value) updates.schedule_value = value;
  if (status) updates.status = status;

  // Recalculate next_run if schedule changed
  if (type || value) {
    const newType = type || task.schedule_type;
    const newValue = value || task.schedule_value;
    updates.next_run = computeNextRun(newType, newValue);
  }

  if (Object.keys(updates).length === 0) die('No updates provided. Use --prompt, --type, --value, or --status');

  updateTask(taskId, updates);

  const updated = getTaskById(taskId)!;
  console.log(`${FG_GREEN}✓${RESET} Updated task ${FG_CYAN}${taskId}${RESET}`);
  printTaskDetail(updated);

  syncSnapshots();
}

function cmdDelete(args: string[]): void {
  const taskId = args[0];
  if (!taskId || taskId.startsWith('--')) die('Task ID is required');

  const task = getTaskById(taskId);
  if (!task) die(`Task not found: ${taskId}`);

  deleteTask(taskId);
  console.log(`${FG_GREEN}✓${RESET} Deleted task ${FG_CYAN}${taskId}${RESET}`);
  console.log(`  Was: ${formatSchedule(task.schedule_type, task.schedule_value)} — ${truncate(task.prompt, 60)}`);

  syncSnapshots();
}

// ─── Interactive Mode ────────────────────────────────────────────────────────

const INTERVAL_PRESETS = [
  { value: '300000', label: '5 minutes' },
  { value: '900000', label: '15 minutes' },
  { value: '1800000', label: '30 minutes' },
  { value: '3600000', label: '1 hour' },
  { value: '7200000', label: '2 hours' },
  { value: '14400000', label: '4 hours' },
  { value: '28800000', label: '8 hours' },
  { value: '43200000', label: '12 hours' },
  { value: '86400000', label: '24 hours' },
  { value: 'custom', label: 'Custom (enter ms value)' },
] as const;

function taskSelectOptions(tasks: ScheduledTask[]): Array<{ value: ScheduledTask; label: string; hint: string }> {
  return tasks.map((t) => ({
    value: t,
    label: `${t.group_folder} | ${formatSchedule(t.schedule_type, t.schedule_value)}`,
    hint: truncate(t.prompt, 60),
  }));
}

async function promptScheduleValue(schedType: 'cron' | 'interval' | 'once'): Promise<string | symbol> {
  if (schedType === 'cron') {
    return p.text({
      message: 'Cron expression',
      placeholder: '0 9 * * *',
      validate(val) {
        try {
          CronExpressionParser.parse(val);
        } catch {
          return 'Invalid cron expression';
        }
      },
    });
  }

  if (schedType === 'interval') {
    const preset = await p.select({
      message: 'Interval',
      options: INTERVAL_PRESETS.map((pr) => ({ value: pr.value, label: pr.label })),
    });
    if (p.isCancel(preset)) return preset;
    if (preset === 'custom') {
      return p.text({
        message: 'Interval in milliseconds',
        placeholder: '3600000',
        validate(val) {
          const ms = parseInt(val, 10);
          if (isNaN(ms) || ms <= 0) return 'Must be a positive number';
        },
      });
    }
    return preset;
  }

  // once
  return p.text({
    message: 'Run at (ISO timestamp)',
    placeholder: new Date(Date.now() + 3600000).toISOString(),
    validate(val) {
      if (isNaN(new Date(val).getTime())) return 'Invalid date';
    },
  });
}

async function interactiveSelectTask(tasks: ScheduledTask[]): Promise<ScheduledTask | symbol> {
  if (tasks.length === 0) {
    p.log.warn('No tasks to select from.');
    return Symbol();
  }
  return p.select({
    message: 'Select a task',
    options: taskSelectOptions(tasks),
  });
}

async function interactiveEdit(tasks: ScheduledTask[]): Promise<void> {
  const task = await interactiveSelectTask(tasks);
  if (p.isCancel(task)) return;

  printTaskDetail(task);

  while (true) {
    const field = await p.select({
      message: 'Edit field',
      options: [
        { value: 'prompt', label: 'Prompt', hint: truncate(task.prompt, 40) },
        { value: 'schedule', label: 'Schedule', hint: formatSchedule(task.schedule_type, task.schedule_value) },
        { value: 'status', label: 'Status', hint: task.status },
        { value: 'done', label: 'Done' },
      ],
    });
    if (p.isCancel(field) || field === 'done') break;

    const updates: Parameters<typeof updateTask>[1] = {};

    if (field === 'prompt') {
      const val = await p.text({ message: 'Prompt', initialValue: task.prompt, validate: (v) => v.trim() ? undefined : 'Required' });
      if (p.isCancel(val)) continue;
      updates.prompt = val;
      task.prompt = val;
    } else if (field === 'schedule') {
      const schedType = await p.select({
        message: 'Schedule type',
        options: [
          { value: 'cron' as const, label: 'Cron', hint: 'e.g. 0 9 * * *' },
          { value: 'interval' as const, label: 'Interval', hint: 'e.g. every 2 hours' },
          { value: 'once' as const, label: 'Once', hint: 'run at a specific time' },
        ],
        initialValue: task.schedule_type as 'cron' | 'interval' | 'once',
      });
      if (p.isCancel(schedType)) continue;
      const schedValue = await promptScheduleValue(schedType);
      if (p.isCancel(schedValue)) continue;
      updates.schedule_type = schedType;
      updates.schedule_value = schedValue;
      try {
        updates.next_run = computeNextRun(schedType, schedValue);
      } catch {
        p.log.error('Invalid schedule value — skipping next_run update.');
      }
      task.schedule_type = schedType;
      task.schedule_value = schedValue;
    } else if (field === 'status') {
      const val = await p.select({
        message: 'Status',
        options: [
          { value: 'active' as const, label: 'Active' },
          { value: 'paused' as const, label: 'Paused' },
          { value: 'completed' as const, label: 'Completed' },
        ],
        initialValue: task.status as 'active' | 'paused' | 'completed',
      });
      if (p.isCancel(val)) continue;
      updates.status = val;
      task.status = val;
    }

    if (Object.keys(updates).length > 0) {
      updateTask(task.id, updates);
      p.log.success(`Updated ${task.id}`);
      printTaskDetail(getTaskById(task.id)!);
      syncSnapshots();
    }
  }
}

async function interactiveDelete(tasks: ScheduledTask[]): Promise<void> {
  const task = await interactiveSelectTask(tasks);
  if (p.isCancel(task)) return;

  printTaskDetail(task);

  const confirmed = await p.confirm({ message: 'Delete this task?' });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info('Cancelled.');
    return;
  }

  deleteTask(task.id);
  p.log.success(`Deleted ${task.id}`);
  syncSnapshots();
}

async function interactiveCreate(): Promise<void> {
  const groups = getAllRegisteredGroups();
  const groupEntries = Object.entries(groups);
  if (groupEntries.length === 0) {
    p.log.error('No registered groups found.');
    return;
  }

  const result = await p.group({
    group: () =>
      p.select({
        message: 'Group',
        options: groupEntries.map(([jid, g]) => ({
          value: { jid, folder: g.folder, name: g.name },
          label: `${g.folder} (${g.name})`,
        })),
      }),
    prompt: () =>
      p.text({
        message: 'Prompt',
        validate: (v) => (v.trim() ? undefined : 'Prompt is required'),
      }),
    scheduleType: () =>
      p.select({
        message: 'Schedule type',
        options: [
          { value: 'cron' as const, label: 'Cron', hint: 'e.g. 0 9 * * *' },
          { value: 'interval' as const, label: 'Interval', hint: 'e.g. every 2 hours' },
          { value: 'once' as const, label: 'Once', hint: 'run at a specific time' },
        ],
      }),
    scheduleValue: ({ results }) => promptScheduleValue(results.scheduleType!),
    contextMode: () =>
      p.select({
        message: 'Context mode',
        options: [
          { value: 'isolated' as const, label: 'Isolated', hint: 'task gets its own filesystem' },
          { value: 'group' as const, label: 'Group', hint: 'shares group filesystem' },
        ],
      }),
  });

  // summary
  const nextRun = computeNextRun(result.scheduleType, result.scheduleValue as string);
  console.log();
  console.log(`  ${DIM}Group:${RESET}    ${result.group.folder} (${result.group.name})`);
  console.log(`  ${DIM}Prompt:${RESET}   ${result.prompt}`);
  console.log(`  ${DIM}Schedule:${RESET} ${formatSchedule(result.scheduleType, result.scheduleValue as string)}`);
  console.log(`  ${DIM}Next run:${RESET} ${formatDate(nextRun)}`);
  console.log(`  ${DIM}Context:${RESET}  ${result.contextMode}`);

  const confirmed = await p.confirm({ message: 'Create this task?' });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info('Cancelled.');
    return;
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createTask({
    id: taskId,
    group_folder: result.group.folder,
    chat_jid: result.group.jid,
    prompt: result.prompt,
    schedule_type: result.scheduleType,
    schedule_value: result.scheduleValue as string,
    context_mode: result.contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  p.log.success(`Created task ${taskId}`);
  printTaskDetail(getTaskById(taskId)!);
  syncSnapshots();
}

async function interactiveToggle(tasks: ScheduledTask[]): Promise<void> {
  const task = await interactiveSelectTask(tasks);
  if (p.isCancel(task)) return;

  const newStatus = task.status === 'active' ? 'paused' : 'active';
  updateTask(task.id, { status: newStatus });
  p.log.success(`${task.id}: ${task.status} → ${newStatus}`);
  syncSnapshots();
}

async function interactiveMode(): Promise<void> {
  p.intro('NanoClaw Task Manager');

  while (true) {
    const tasks = getAllTasks();
    printTaskTable(tasks);

    const action = await p.select({
      message: 'Action',
      options: [
        { value: 'edit', label: 'Edit', hint: 'modify a task' },
        { value: 'delete', label: 'Delete', hint: 'remove a task' },
        { value: 'toggle', label: 'Toggle', hint: 'pause/resume a task' },
        { value: 'create', label: 'Create', hint: 'add a new task' },
        { value: 'diff', label: 'Diff', hint: 'DB vs snapshot diff' },
        { value: 'sync', label: 'Sync', hint: 'sync DB → snapshots' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (p.isCancel(action) || action === 'quit') {
      p.outro('Goodbye!');
      return;
    }

    switch (action) {
      case 'edit':
        await interactiveEdit(tasks);
        break;
      case 'delete':
        await interactiveDelete(tasks);
        break;
      case 'toggle':
        await interactiveToggle(tasks);
        break;
      case 'create':
        await interactiveCreate();
        break;
      case 'diff':
        console.log();
        cmdDiff();
        break;
      case 'sync':
        syncSnapshots();
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
  case 'sync':
    syncSnapshots();
    break;
  case 'diff':
    cmdDiff();
    break;
  default:
    console.log(`${BOLD}NanoClaw Task Manager${RESET}\n`);
    console.log('Commands:');
    console.log(`  ${FG_CYAN}-i${RESET}                                                Interactive mode`);
    console.log(`  ${FG_CYAN}list${RESET}   [--group <folder>] [--status <status>]     List tasks`);
    console.log(`  ${FG_CYAN}create${RESET} --group <f> --jid <j> --prompt <p> ...     Create a task`);
    console.log(`  ${FG_CYAN}edit${RESET}   <id> [--prompt <p>] [--status <s>] ...      Edit a task`);
    console.log(`  ${FG_CYAN}delete${RESET} <id>                                       Delete a task`);
    console.log(`  ${FG_CYAN}sync${RESET}                                              Sync DB → snapshot files`);
    console.log(`  ${FG_CYAN}diff${RESET}                                              Show DB vs snapshot diff`);
    break;
}
