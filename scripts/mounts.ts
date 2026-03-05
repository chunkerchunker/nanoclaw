/**
 * Manage mount points: list, add, remove, toggle read/write, and manage allowlist.
 *
 * Usage:
 *   npx tsx scripts/mounts.ts -i                                    Interactive mode
 *   npx tsx scripts/mounts.ts list
 *   npx tsx scripts/mounts.ts add <hostPath> [--groups <f1,f2,...>] [--readonly] [--container-path <name>]
 *   npx tsx scripts/mounts.ts remove <hostPath> [--groups <f1,f2,...>]
 *   npx tsx scripts/mounts.ts set <hostPath> --group <folder> --readonly <true|false>
 *   npx tsx scripts/mounts.ts allowlist                             Show allowlist
 *   npx tsx scripts/mounts.ts allow <path> [--read-write] [--description <desc>]
 *   npx tsx scripts/mounts.ts disallow <path>
 */
import * as p from '@clack/prompts';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AdditionalMount, MountAllowlist, RegisteredGroup } from '../src/types.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

process.env.DATA_DIR ??= path.join(PROJECT_ROOT, 'data');
process.env.STORE_DIR ??= path.join(PROJECT_ROOT, 'store');

const { initDatabase, getAllRegisteredGroups, setRegisteredGroup } = await import('../src/db.js');
const { MOUNT_ALLOWLIST_PATH } = await import('../src/config.js');

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

function expandPath(p: string): string {
  const home = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p === '~') return home;
  return path.resolve(p);
}

function contractPath(p: string): string {
  const home = process.env.HOME || os.homedir();
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

type GroupEntry = { jid: string } & RegisteredGroup;

function getAllGroupEntries(): GroupEntry[] {
  const groups = getAllRegisteredGroups();
  return Object.entries(groups).map(([jid, g]) => ({ jid, ...g }));
}

function getMountsForGroup(group: RegisteredGroup): AdditionalMount[] {
  return group.containerConfig?.additionalMounts || [];
}

function setMountsForGroup(group: RegisteredGroup, mounts: AdditionalMount[]): void {
  if (mounts.length === 0) {
    if (group.containerConfig) {
      delete group.containerConfig.additionalMounts;
      if (Object.keys(group.containerConfig).length === 0) {
        group.containerConfig = undefined;
      }
    }
  } else {
    group.containerConfig = { ...group.containerConfig, additionalMounts: mounts };
  }
}

// ─── Mount Index ─────────────────────────────────────────────────────────────
// Deduplicated view of all mounts across all groups

interface MountInfo {
  hostPath: string;
  containerPath?: string;
  groups: Array<{ folder: string; name: string; jid: string; readonly: boolean }>;
}

function buildMountIndex(): MountInfo[] {
  const groups = getAllGroupEntries();
  const index = new Map<string, MountInfo>();

  for (const g of groups) {
    const mounts = getMountsForGroup(g);
    for (const m of mounts) {
      const key = expandPath(m.hostPath);
      if (!index.has(key)) {
        index.set(key, { hostPath: m.hostPath, containerPath: m.containerPath, groups: [] });
      }
      index.get(key)!.groups.push({
        folder: g.folder,
        name: g.name,
        jid: g.jid,
        readonly: m.readonly !== false,
      });
    }
  }

  return [...index.values()].sort((a, b) => a.hostPath.localeCompare(b.hostPath));
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

function loadAllowlist(): MountAllowlist {
  if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    return { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: false };
  }
  return JSON.parse(fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8'));
}

function saveAllowlist(allowlist: MountAllowlist): void {
  const dir = path.dirname(MOUNT_ALLOWLIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MOUNT_ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n');
}

function isPathAllowed(hostPath: string): { allowed: boolean; root?: string } {
  const allowlist = loadAllowlist();
  const real = expandPath(hostPath);
  for (const root of allowlist.allowedRoots) {
    const rootReal = expandPath(root.path);
    const rel = path.relative(rootReal, real);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { allowed: true, root: root.path };
    }
  }
  return { allowed: false };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function printMountTable(mounts: MountInfo[]): void {
  if (mounts.length === 0) {
    console.log(`${DIM}No mounts configured.${RESET}`);
    return;
  }

  const allGroups = getAllGroupEntries();

  console.log(`${BOLD}${'#'.padEnd(4)} ${'Host Path'.padEnd(44)} ${'Container Path'.padEnd(22)} Groups${RESET}`);
  console.log(`${DIM}${'─'.repeat(110)}${RESET}`);

  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i];
    const containerPath = m.containerPath || path.basename(expandPath(m.hostPath));
    const { allowed } = isPathAllowed(m.hostPath);
    const allowedIcon = allowed ? `${FG_GREEN}●${RESET}` : `${FG_RED}●${RESET}`;

    // Build group status string
    const groupParts: string[] = [];
    for (const g of allGroups) {
      const match = m.groups.find((mg) => mg.folder === g.folder);
      if (match) {
        const rw = match.readonly ? `${FG_YELLOW}ro${RESET}` : `${FG_GREEN}rw${RESET}`;
        groupParts.push(`${FG_CYAN}${g.folder}${RESET}(${rw})`);
      } else {
        groupParts.push(`${DIM}${g.folder}${RESET}`);
      }
    }

    console.log(
      `${DIM}${String(i + 1).padEnd(4)}${RESET}` +
      `${allowedIcon} ${contractPath(expandPath(m.hostPath)).padEnd(42)} ` +
      `${DIM}${containerPath.padEnd(22)}${RESET} ` +
      groupParts.join('  '),
    );
  }

  console.log(`\n${DIM}${mounts.length} mount(s) | ${FG_GREEN}●${RESET}${DIM} = in allowlist, ${FG_RED}●${RESET}${DIM} = not in allowlist${RESET}`);
}

function printMountDetail(m: MountInfo): void {
  const containerPath = m.containerPath || path.basename(expandPath(m.hostPath));
  const expanded = expandPath(m.hostPath);
  const exists = fs.existsSync(expanded);
  const { allowed, root } = isPathAllowed(m.hostPath);

  console.log(`  ${DIM}Host path:${RESET}       ${m.hostPath}`);
  console.log(`  ${DIM}Expanded:${RESET}        ${expanded}`);
  console.log(`  ${DIM}Container path:${RESET}  /workspace/extra/${containerPath}`);
  console.log(`  ${DIM}Exists:${RESET}          ${exists ? `${FG_GREEN}yes${RESET}` : `${FG_RED}no${RESET}`}`);
  console.log(`  ${DIM}Allowlisted:${RESET}     ${allowed ? `${FG_GREEN}yes${RESET} (root: ${root})` : `${FG_RED}no${RESET}`}`);
  console.log(`  ${DIM}Groups:${RESET}`);
  for (const g of m.groups) {
    const rw = g.readonly ? `${FG_YELLOW}ro${RESET}` : `${FG_GREEN}rw${RESET}`;
    console.log(`    ${DIM}•${RESET} ${FG_CYAN}${g.folder}${RESET} (${g.name}) — ${rw}`);
  }

  const allGroups = getAllGroupEntries();
  const missing = allGroups.filter((g) => !m.groups.some((mg) => mg.folder === g.folder));
  if (missing.length > 0) {
    console.log(`  ${DIM}Not mounted in:${RESET}`);
    for (const g of missing) {
      console.log(`    ${DIM}• ${g.folder} (${g.name})${RESET}`);
    }
  }
}

function printAllowlist(): void {
  const allowlist = loadAllowlist();

  if (allowlist.allowedRoots.length === 0) {
    console.log(`${DIM}No allowed roots configured.${RESET}`);
    console.log(`${DIM}File: ${MOUNT_ALLOWLIST_PATH}${RESET}`);
    return;
  }

  console.log(`${BOLD}Allowed Roots${RESET} ${DIM}(${MOUNT_ALLOWLIST_PATH})${RESET}\n`);
  for (const root of allowlist.allowedRoots) {
    const rw = root.allowReadWrite ? `${FG_GREEN}rw${RESET}` : `${FG_YELLOW}ro${RESET}`;
    const desc = root.description ? ` ${DIM}— ${root.description}${RESET}` : '';
    console.log(`  ${FG_CYAN}${root.path}${RESET} (${rw})${desc}`);
  }

  if (allowlist.blockedPatterns.length > 0) {
    console.log(`\n${BOLD}Extra Blocked Patterns${RESET}`);
    for (const pat of allowlist.blockedPatterns) {
      console.log(`  ${FG_RED}•${RESET} ${pat}`);
    }
  }

  console.log(`\n  ${DIM}Non-main read-only:${RESET} ${allowlist.nonMainReadOnly ? `${FG_YELLOW}yes${RESET}` : `${FG_GREEN}no${RESET}`}`);
}

// ─── CLI Commands ────────────────────────────────────────────────────────────

function cmdList(): void {
  const mounts = buildMountIndex();
  printMountTable(mounts);
}

function cmdAdd(args: string[]): void {
  const hostPath = args[0];
  if (!hostPath || hostPath.startsWith('--')) die('Host path is required');

  const groupsStr = flag(args, 'groups');
  const readonly = hasFlag(args, 'readonly');
  const containerPath = flag(args, 'container-path');

  const allGroups = getAllGroupEntries();
  const targetFolders = groupsStr
    ? groupsStr.split(',').map((s) => s.trim())
    : allGroups.map((g) => g.folder);

  // Verify target folders exist
  for (const f of targetFolders) {
    if (!allGroups.some((g) => g.folder === f)) die(`Group not found: ${f}`);
  }

  // Check allowlist
  const { allowed } = isPathAllowed(hostPath);
  if (!allowed) {
    console.log(`${FG_YELLOW}Warning:${RESET} ${hostPath} is not in the mount allowlist.`);
    console.log(`${DIM}The mount will be saved but rejected at runtime. Run 'allow' to add it.${RESET}`);
  }

  // Ensure host path exists
  const expanded = expandPath(hostPath);
  if (!fs.existsSync(expanded)) {
    fs.mkdirSync(expanded, { recursive: true });
    console.log(`${FG_GREEN}Created${RESET} ${expanded}`);
  }

  let added = 0;
  let skipped = 0;

  for (const g of allGroups) {
    if (!targetFolders.includes(g.folder)) continue;

    const mounts = getMountsForGroup(g);
    const existing = mounts.find((m) => expandPath(m.hostPath) === expanded);
    if (existing) {
      skipped++;
      continue;
    }

    const mount: AdditionalMount = { hostPath, readonly: readonly || false };
    if (containerPath) mount.containerPath = containerPath;
    mounts.push(mount);
    setMountsForGroup(g, mounts);
    setRegisteredGroup(g.jid, g);
    added++;
  }

  console.log(`${FG_GREEN}✓${RESET} Added to ${added} group(s)${skipped > 0 ? `, skipped ${skipped} (already mounted)` : ''}`);
}

function cmdRemove(args: string[]): void {
  const hostPath = args[0];
  if (!hostPath || hostPath.startsWith('--')) die('Host path is required');

  const groupsStr = flag(args, 'groups');
  const expanded = expandPath(hostPath);
  const allGroups = getAllGroupEntries();
  const targetFolders = groupsStr
    ? groupsStr.split(',').map((s) => s.trim())
    : allGroups.map((g) => g.folder);

  let removed = 0;

  for (const g of allGroups) {
    if (!targetFolders.includes(g.folder)) continue;

    const mounts = getMountsForGroup(g);
    const filtered = mounts.filter((m) => expandPath(m.hostPath) !== expanded);
    if (filtered.length < mounts.length) {
      setMountsForGroup(g, filtered);
      setRegisteredGroup(g.jid, g);
      removed++;
    }
  }

  console.log(`${FG_GREEN}✓${RESET} Removed from ${removed} group(s)`);
}

function cmdSet(args: string[]): void {
  const hostPath = args[0];
  if (!hostPath || hostPath.startsWith('--')) die('Host path is required');

  const folder = flag(args, 'group');
  const readonlyStr = flag(args, 'readonly');
  if (!folder) die('--group is required');
  if (readonlyStr === undefined) die('--readonly <true|false> is required');

  const expanded = expandPath(hostPath);
  const allGroups = getAllGroupEntries();
  const group = allGroups.find((g) => g.folder === folder);
  if (!group) die(`Group not found: ${folder}`);

  const mounts = getMountsForGroup(group);
  const mount = mounts.find((m) => expandPath(m.hostPath) === expanded);
  if (!mount) die(`Mount not found in group ${folder}: ${hostPath}`);

  mount.readonly = readonlyStr === 'true';
  setMountsForGroup(group, mounts);
  setRegisteredGroup(group.jid, group);

  const rw = mount.readonly ? 'read-only' : 'read-write';
  console.log(`${FG_GREEN}✓${RESET} Set ${hostPath} to ${rw} for ${folder}`);
}

function cmdAllowlist(): void {
  printAllowlist();
}

function cmdAllow(args: string[]): void {
  const hostPath = args[0];
  if (!hostPath || hostPath.startsWith('--')) die('Path is required');

  const readWrite = hasFlag(args, 'read-write');
  const description = flag(args, 'description');

  const allowlist = loadAllowlist();
  const expanded = expandPath(hostPath);

  // Check if already present
  const existing = allowlist.allowedRoots.find((r) => expandPath(r.path) === expanded);
  if (existing) {
    existing.allowReadWrite = readWrite;
    if (description) existing.description = description;
    saveAllowlist(allowlist);
    console.log(`${FG_GREEN}✓${RESET} Updated ${hostPath} in allowlist`);
    return;
  }

  allowlist.allowedRoots.push({
    path: hostPath,
    allowReadWrite: readWrite,
    description,
  });
  saveAllowlist(allowlist);
  console.log(`${FG_GREEN}✓${RESET} Added ${hostPath} to allowlist (${readWrite ? 'read-write' : 'read-only'})`);
}

function cmdDisallow(args: string[]): void {
  const hostPath = args[0];
  if (!hostPath || hostPath.startsWith('--')) die('Path is required');

  const expanded = expandPath(hostPath);
  const allowlist = loadAllowlist();
  const before = allowlist.allowedRoots.length;
  allowlist.allowedRoots = allowlist.allowedRoots.filter((r) => expandPath(r.path) !== expanded);

  if (allowlist.allowedRoots.length === before) {
    die(`Path not found in allowlist: ${hostPath}`);
  }

  saveAllowlist(allowlist);
  console.log(`${FG_GREEN}✓${RESET} Removed ${hostPath} from allowlist`);
}

// ─── Interactive Mode ────────────────────────────────────────────────────────

async function interactiveAdd(): Promise<void> {
  const allGroups = getAllGroupEntries();
  if (allGroups.length === 0) {
    p.log.warn('No groups registered.');
    return;
  }

  const hostPath = await p.text({
    message: 'Host path',
    placeholder: '~/dev/my-project',
    validate(v) {
      if (!v.trim()) return 'Path is required';
    },
  });
  if (p.isCancel(hostPath)) return;

  const expanded = expandPath(hostPath);
  if (!fs.existsSync(expanded)) {
    const create = await p.confirm({ message: `${expanded} does not exist. Create it?` });
    if (p.isCancel(create)) return;
    if (create) fs.mkdirSync(expanded, { recursive: true });
  }

  const containerPath = await p.text({
    message: 'Container path name (mounted at /workspace/extra/<name>)',
    initialValue: path.basename(expanded),
  });
  if (p.isCancel(containerPath)) return;

  const readonly = await p.select({
    message: 'Default access mode',
    options: [
      { value: false, label: 'Read-write', hint: 'agent can create/modify files' },
      { value: true, label: 'Read-only', hint: 'agent can only read files' },
    ],
  });
  if (p.isCancel(readonly)) return;

  const selectedGroups = await p.multiselect({
    message: 'Add to which groups?',
    options: allGroups.map((g) => ({
      value: g,
      label: `${g.folder} (${g.name})`,
      hint: g.isMain ? 'main' : undefined,
    })),
    required: true,
    initialValues: allGroups,
  });
  if (p.isCancel(selectedGroups)) return;

  // Check allowlist
  const { allowed } = isPathAllowed(hostPath);
  if (!allowed) {
    p.log.warn(`${hostPath} is not in the mount allowlist.`);
    const addToAllowlist = await p.confirm({ message: 'Add to allowlist now?' });
    if (!p.isCancel(addToAllowlist) && addToAllowlist) {
      const allowRw = await p.select({
        message: 'Allowlist access level',
        options: [
          { value: true, label: 'Read-write allowed' },
          { value: false, label: 'Read-only only' },
        ],
      });
      if (!p.isCancel(allowRw)) {
        const allowlist = loadAllowlist();
        allowlist.allowedRoots.push({
          path: hostPath,
          allowReadWrite: allowRw,
        });
        saveAllowlist(allowlist);
        p.log.success('Added to allowlist.');
      }
    }
  }

  let added = 0;
  let skipped = 0;

  for (const g of selectedGroups) {
    const mounts = getMountsForGroup(g);
    const existing = mounts.find((m) => expandPath(m.hostPath) === expanded);
    if (existing) {
      skipped++;
      continue;
    }

    const mount: AdditionalMount = { hostPath, readonly };
    if (containerPath && containerPath !== path.basename(expanded)) {
      mount.containerPath = containerPath;
    }
    mounts.push(mount);
    setMountsForGroup(g, mounts);
    setRegisteredGroup(g.jid, g);
    added++;
  }

  p.log.success(`Added to ${added} group(s)${skipped > 0 ? `, skipped ${skipped} (already mounted)` : ''}`);
}

async function interactiveRemove(): Promise<void> {
  const mounts = buildMountIndex();
  if (mounts.length === 0) {
    p.log.warn('No mounts configured.');
    return;
  }

  const selected = await p.select({
    message: 'Select mount to remove',
    options: mounts.map((m) => ({
      value: m,
      label: contractPath(expandPath(m.hostPath)),
      hint: `${m.groups.length} group(s)`,
    })),
  });
  if (p.isCancel(selected)) return;

  printMountDetail(selected);

  const removeFrom = await p.multiselect({
    message: 'Remove from which groups?',
    options: selected.groups.map((g) => ({
      value: g,
      label: `${g.folder} (${g.name})`,
    })),
    required: true,
    initialValues: selected.groups,
  });
  if (p.isCancel(removeFrom)) return;

  const expanded = expandPath(selected.hostPath);
  let removed = 0;
  const allGroups = getAllGroupEntries();

  for (const target of removeFrom) {
    const g = allGroups.find((g) => g.jid === target.jid);
    if (!g) continue;

    const mounts = getMountsForGroup(g);
    const filtered = mounts.filter((m) => expandPath(m.hostPath) !== expanded);
    if (filtered.length < mounts.length) {
      setMountsForGroup(g, filtered);
      setRegisteredGroup(g.jid, g);
      removed++;
    }
  }

  p.log.success(`Removed from ${removed} group(s).`);
}

async function interactiveEdit(): Promise<void> {
  const mounts = buildMountIndex();
  if (mounts.length === 0) {
    p.log.warn('No mounts configured.');
    return;
  }

  const selected = await p.select({
    message: 'Select mount to edit',
    options: mounts.map((m) => ({
      value: m,
      label: contractPath(expandPath(m.hostPath)),
      hint: m.groups.map((g) => `${g.folder}(${g.readonly ? 'ro' : 'rw'})`).join(', '),
    })),
  });
  if (p.isCancel(selected)) return;

  printMountDetail(selected);

  const allGroups = getAllGroupEntries();
  const expanded = expandPath(selected.hostPath);

  // Show per-group toggle
  for (const g of allGroups) {
    const groupMounts = getMountsForGroup(g);
    const mount = groupMounts.find((m) => expandPath(m.hostPath) === expanded);

    if (!mount) {
      const add = await p.confirm({
        message: `${g.folder} (${g.name}): not mounted. Add?`,
        initialValue: false,
      });
      if (p.isCancel(add)) return;
      if (add) {
        const ro = await p.select({
          message: `Access mode for ${g.folder}`,
          options: [
            { value: false, label: 'Read-write' },
            { value: true, label: 'Read-only' },
          ],
        });
        if (p.isCancel(ro)) return;
        groupMounts.push({ hostPath: selected.hostPath, readonly: ro, containerPath: selected.containerPath });
        setMountsForGroup(g, groupMounts);
        setRegisteredGroup(g.jid, g);
        p.log.success(`Added to ${g.folder}`);
      }
    } else {
      const currentRw = mount.readonly !== false ? 'read-only' : 'read-write';
      const action = await p.select({
        message: `${g.folder} (${g.name}): currently ${currentRw}`,
        options: [
          { value: 'keep', label: `Keep (${currentRw})` },
          { value: 'toggle', label: `Switch to ${mount.readonly !== false ? 'read-write' : 'read-only'}` },
          { value: 'remove', label: 'Remove from this group' },
        ],
      });
      if (p.isCancel(action)) return;

      if (action === 'toggle') {
        mount.readonly = !mount.readonly;
        setMountsForGroup(g, groupMounts);
        setRegisteredGroup(g.jid, g);
        p.log.success(`Updated ${g.folder}`);
      } else if (action === 'remove') {
        const filtered = groupMounts.filter((m) => expandPath(m.hostPath) !== expanded);
        setMountsForGroup(g, filtered);
        setRegisteredGroup(g.jid, g);
        p.log.success(`Removed from ${g.folder}`);
      }
    }
  }
}

async function interactiveAllowlist(): Promise<void> {
  printAllowlist();
  console.log();

  const action = await p.select({
    message: 'Action',
    options: [
      { value: 'add', label: 'Add root', hint: 'allow a new path' },
      { value: 'edit', label: 'Edit root', hint: 'change access level' },
      { value: 'remove', label: 'Remove root' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (p.isCancel(action) || action === 'back') return;

  const allowlist = loadAllowlist();

  if (action === 'add') {
    const pathVal = await p.text({
      message: 'Path to allow',
      placeholder: '~/dev/projects',
      validate: (v) => (v.trim() ? undefined : 'Path is required'),
    });
    if (p.isCancel(pathVal)) return;

    const rw = await p.select({
      message: 'Allow read-write?',
      options: [
        { value: true, label: 'Read-write', hint: 'groups can modify files' },
        { value: false, label: 'Read-only', hint: 'groups can only read' },
      ],
    });
    if (p.isCancel(rw)) return;

    const desc = await p.text({ message: 'Description (optional)', placeholder: 'My projects' });
    if (p.isCancel(desc)) return;

    allowlist.allowedRoots.push({
      path: pathVal,
      allowReadWrite: rw,
      description: desc || undefined,
    });
    saveAllowlist(allowlist);
    p.log.success(`Added ${pathVal} to allowlist.`);
  } else if (action === 'edit' || action === 'remove') {
    if (allowlist.allowedRoots.length === 0) {
      p.log.warn('No roots to edit.');
      return;
    }

    const root = await p.select({
      message: 'Select root',
      options: allowlist.allowedRoots.map((r) => ({
        value: r,
        label: r.path,
        hint: `${r.allowReadWrite ? 'rw' : 'ro'}${r.description ? ' — ' + r.description : ''}`,
      })),
    });
    if (p.isCancel(root)) return;

    if (action === 'remove') {
      const expanded = expandPath(root.path);
      allowlist.allowedRoots = allowlist.allowedRoots.filter((r) => expandPath(r.path) !== expanded);
      saveAllowlist(allowlist);
      p.log.success(`Removed ${root.path} from allowlist.`);
    } else {
      const rw = await p.select({
        message: 'Allow read-write?',
        options: [
          { value: true, label: 'Read-write' },
          { value: false, label: 'Read-only' },
        ],
        initialValue: root.allowReadWrite,
      });
      if (p.isCancel(rw)) return;

      root.allowReadWrite = rw;
      saveAllowlist(allowlist);
      p.log.success(`Updated ${root.path}.`);
    }
  }
}

async function interactiveShow(): Promise<void> {
  const mounts = buildMountIndex();
  if (mounts.length === 0) {
    p.log.warn('No mounts configured.');
    return;
  }

  const selected = await p.select({
    message: 'Select mount',
    options: mounts.map((m) => ({
      value: m,
      label: contractPath(expandPath(m.hostPath)),
      hint: m.groups.map((g) => `${g.folder}(${g.readonly ? 'ro' : 'rw'})`).join(', '),
    })),
  });
  if (p.isCancel(selected)) return;

  console.log();
  printMountDetail(selected);
}

async function interactiveMode(): Promise<void> {
  p.intro('NanoClaw Mount Manager');

  while (true) {
    const mounts = buildMountIndex();
    printMountTable(mounts);

    const action = await p.select({
      message: 'Action',
      options: [
        { value: 'show', label: 'Show', hint: 'view mount details' },
        { value: 'add', label: 'Add', hint: 'add a mount to groups' },
        { value: 'edit', label: 'Edit', hint: 'change per-group access' },
        { value: 'remove', label: 'Remove', hint: 'remove a mount from groups' },
        { value: 'allowlist', label: 'Allowlist', hint: 'manage security allowlist' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (p.isCancel(action) || action === 'quit') {
      p.outro('Goodbye!');
      return;
    }

    switch (action) {
      case 'show':
        await interactiveShow();
        break;
      case 'add':
        await interactiveAdd();
        break;
      case 'edit':
        await interactiveEdit();
        break;
      case 'remove':
        await interactiveRemove();
        break;
      case 'allowlist':
        await interactiveAllowlist();
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
    cmdList();
    break;
  case 'add':
    cmdAdd(rest);
    break;
  case 'remove':
  case 'rm':
    cmdRemove(rest);
    break;
  case 'set':
    cmdSet(rest);
    break;
  case 'allowlist':
  case 'al':
    cmdAllowlist();
    break;
  case 'allow':
    cmdAllow(rest);
    break;
  case 'disallow':
    cmdDisallow(rest);
    break;
  default:
    console.log(`${BOLD}NanoClaw Mount Manager${RESET}\n`);
    console.log('Commands:');
    console.log(`  ${FG_CYAN}-i${RESET}                                                     Interactive mode`);
    console.log(`  ${FG_CYAN}list${RESET}                                                    List all mounts`);
    console.log(`  ${FG_CYAN}add${RESET}    <path> [--groups <f1,f2>] [--readonly] [--container-path <n>]`);
    console.log(`  ${FG_CYAN}remove${RESET} <path> [--groups <f1,f2>]                        Remove mount`);
    console.log(`  ${FG_CYAN}set${RESET}    <path> --group <folder> --readonly <true|false>   Set access`);
    console.log(`  ${FG_CYAN}allowlist${RESET}                                                Show allowlist`);
    console.log(`  ${FG_CYAN}allow${RESET}  <path> [--read-write] [--description <desc>]      Add to allowlist`);
    console.log(`  ${FG_CYAN}disallow${RESET} <path>                                          Remove from allowlist`);
    break;
}
