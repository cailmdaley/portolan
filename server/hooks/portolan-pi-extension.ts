import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

type PiEvent = {
  toolName?: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
};

type PiApi = {
  on: (event: string, handler: (event: PiEvent) => void | Promise<void>) => void;
};

const eventsFile = process.env.PORTOLAN_EVENTS_FILE
  ?? join(process.env.PORTOLAN_DATA_DIR ?? join(homedir(), '.portolan', 'data'), 'events.jsonl');

const toolAliases: Record<string, string> = {
  Read: 'Read',
  read_file: 'Read',
  ReadFile: 'Read',
  Write: 'Write',
  write_file: 'Write',
  WriteFile: 'Write',
  Edit: 'Edit',
  edit_file: 'Edit',
  apply_patch: 'Edit',
};

export default function portolanPiExtension(pi: PiApi) {
  pi.on('tool_call', (event) => writePortolanEvent('pre_tool_use', event));
  pi.on('tool_result', (event) => writePortolanEvent('post_tool_use', event));
}

function writePortolanEvent(type: 'pre_tool_use' | 'post_tool_use', event: PiEvent): void {
  const tool = event.toolName ? toolAliases[event.toolName] : undefined;
  const input = event.input ?? {};
  const filePath = firstString(input, ['file_path', 'path', 'filePath', 'absolute_path']);
  if (!tool || !filePath) return;

  mkdirSync(dirname(eventsFile), { recursive: true });
  const timestamp = Date.now();
  const sessionId = event.sessionId ?? event.session_id ?? 'unknown';
  appendFileSync(eventsFile, JSON.stringify({
    id: `pi-${sessionId}-${timestamp}`,
    timestamp,
    type,
    sessionId,
    cwd: event.cwd ?? process.cwd(),
    tmuxSession: tmuxSession(),
    harness: 'pi',
    originName: hostname(),
    tool,
    toolInput: { ...input, file_path: filePath },
  }) + '\n');
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function tmuxSession(): string {
  if (!process.env.TMUX) return '';
  try {
    return execSync('tmux display-message -p "#S"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
