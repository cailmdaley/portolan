import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const hookPath = fileURLToPath(new URL('../../hooks/portolan-codex-hook.sh', import.meta.url));

function runHook(payload: Record<string, unknown>, eventsFile: string): void {
  execFileSync('bash', [hookPath], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      PORTOLAN_EVENTS_FILE: eventsFile,
      TMUX: '',
    },
  });
}

function readEvents(eventsFile: string): Array<Record<string, any>> {
  return readFileSync(eventsFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('portolan-codex-hook.sh', () => {
  it('keeps non-file tool events and extracts apply_patch paths from Codex command payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'portolan-codex-hook-'));
    const workdir = join(root, 'work');
    const eventsFile = join(root, 'events.jsonl');

    runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'codex-session',
      cwd: workdir,
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    }, eventsFile);

    runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'codex-session',
      cwd: workdir,
      tool_name: 'apply_patch',
      tool_input: {
        command: [
          '*** Begin Patch',
          '*** Update File: seed.txt',
          '@@',
          '+raw-hook-active',
          '*** End Patch',
        ].join('\n'),
      },
    }, eventsFile);

    const events = readEvents(eventsFile);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'pre_tool_use',
      sessionId: 'codex-session',
      harness: 'codex',
      tool: 'Bash',
      toolInput: { command: 'pwd' },
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      type: 'post_tool_use',
      sessionId: 'codex-session',
      harness: 'codex',
      tool: 'Edit',
      toolInput: expect.objectContaining({
        file_path: join(workdir, 'seed.txt'),
      }),
    }));
  });
});
