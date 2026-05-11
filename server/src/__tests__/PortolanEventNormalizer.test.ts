import { describe, expect, it } from 'vitest';
import { normalizeHarnessEvent, normalizeToolTouch } from '../PortolanEventNormalizer.js';

describe('PortolanEventNormalizer', () => {
  it('normalizes Claude Code file tools into canonical Portolan events', () => {
    const event = normalizeHarnessEvent({
      hook_event_name: 'PostToolUse',
      session_id: 'claude-session',
      cwd: '/project',
      tool_name: 'Read',
      tool_input: { file_path: '/project/src/main.ts' },
    }, {
      harness: 'claude-code',
      tmuxSession: 'worker-claude',
      timestamp: 1_000,
      originName: 'local-host',
    });

    expect(event).toEqual(expect.objectContaining({
      timestamp: 1_000,
      type: 'post_tool_use',
      sessionId: 'claude-session',
      cwd: '/project',
      tmuxSession: 'worker-claude',
      harness: 'claude-code',
      originName: 'local-host',
      tool: 'Read',
      toolInput: { file_path: '/project/src/main.ts' },
    }));
  });

  it('normalizes Codex file-path spellings and tool aliases', () => {
    const touch = normalizeToolTouch({
      tool_name: 'apply_patch',
      tool_input: { path: '/project/src/EventWatcher.ts' },
    });

    expect(touch).toEqual({
      tool: 'Edit',
      toolInput: {
        path: '/project/src/EventWatcher.ts',
        file_path: '/project/src/EventWatcher.ts',
      },
    });
  });

  it('extracts Codex apply_patch file paths from the command payload', () => {
    const touch = normalizeToolTouch({
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
    });

    expect(touch).toEqual({
      tool: 'Edit',
      toolInput: {
        command: [
          '*** Begin Patch',
          '*** Update File: seed.txt',
          '@@',
          '+raw-hook-active',
          '*** End Patch',
        ].join('\n'),
        file_path: 'seed.txt',
      },
    });
  });

  it('normalizes Pi tool_call/tool_result event names', () => {
    const event = normalizeHarnessEvent({
      event: 'tool_call',
      sessionId: 'pi-session',
      cwd: '/project',
      toolName: 'write_file',
      input: { filePath: '/project/notes.md' },
    }, {
      harness: 'pi',
      tmuxSession: 'worker-pi',
      timestamp: 2_000,
    });

    expect(event).toEqual(expect.objectContaining({
      type: 'pre_tool_use',
      sessionId: 'pi-session',
      tmuxSession: 'worker-pi',
      harness: 'pi',
      tool: 'Write',
      toolInput: {
        filePath: '/project/notes.md',
        file_path: '/project/notes.md',
      },
    }));
  });

  it('keeps non-file tools as activity-neutral canonical events', () => {
    const event = normalizeHarnessEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'codex-session',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    }, {
      harness: 'codex',
      tmuxSession: 'worker-codex',
      timestamp: 3_000,
    });

    expect(event).toEqual(expect.objectContaining({
      type: 'pre_tool_use',
      tool: 'Bash',
      toolInput: { command: 'pwd' },
    }));
  });
});
