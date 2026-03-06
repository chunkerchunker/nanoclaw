import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('fix-clear-session skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: fix-clear-session');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('src/db.ts');
    expect(content).toContain('src/index.ts');
    expect(content).toContain('src/ipc.ts');
    expect(content).toContain('container/agent-runner/src/ipc-mcp-stdio.ts');
  });

  it('has all modified files with intent docs', () => {
    const modifyFiles = [
      'src/db.ts',
      'src/index.ts',
      'src/ipc.ts',
      'container/agent-runner/src/ipc-mcp-stdio.ts',
    ];

    for (const relPath of modifyFiles) {
      const filePath = path.join(skillDir, 'modify', relPath);
      expect(fs.existsSync(filePath), `Missing modify file: ${relPath}`).toBe(
        true,
      );

      const intentPath = `${filePath}.intent.md`;
      expect(
        fs.existsSync(intentPath),
        `Missing intent file: ${relPath}.intent.md`,
      ).toBe(true);
    }
  });

  it('db.ts excludes system messages from getNewMessages', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'db.ts'),
      'utf-8',
    );
    expect(content).toContain("AND sender != 'system'");
    expect(content).toContain('deleteSession');
    expect(content).toContain('deleteRegisteredGroup');
  });

  it('index.ts has clearSession handler and race condition fixes', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );
    expect(content).toContain('clearSession');
    expect(content).toContain('deleteSession');
    expect(content).toContain("m.sender === 'system'");
    expect(content).toContain('Pruned stale session');
    expect(content).toContain('recoverPendingMessages()');
    expect(content).toContain('log-archive');
  });

  it('ipc.ts has clear_session case', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'ipc.ts'),
      'utf-8',
    );
    expect(content).toContain("case 'clear_session'");
    expect(content).toContain('clearSession');
    expect(content).toContain('Unauthorized clear_session attempt blocked');
  });

  it('ipc-mcp-stdio.ts has clear_session MCP tool', () => {
    const content = fs.readFileSync(
      path.join(
        skillDir,
        'modify',
        'container',
        'agent-runner',
        'src',
        'ipc-mcp-stdio.ts',
      ),
      'utf-8',
    );
    expect(content).toContain("'clear_session'");
    expect(content).toContain('target_group_folder');
    expect(content).toContain('Session clear requested');
  });
});
