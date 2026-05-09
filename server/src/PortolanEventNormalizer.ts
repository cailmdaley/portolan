export type PortolanEventType =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'subagent_stop'
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'notification';

export interface PortolanEvent {
  id: string;
  timestamp: number;
  type: PortolanEventType;
  sessionId: string;
  cwd: string;
  tmuxSession: string;
  harness?: string;
  originName?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  prompt?: string;
}

export interface NormalizedToolTouch {
  tool: 'Read' | 'Write' | 'Edit';
  toolInput: Record<string, unknown>;
}

interface NormalizeOptions {
  harness: string;
  tmuxSession?: string;
  timestamp?: number;
  originName?: string;
}

const EVENT_TYPE_BY_HOOK_NAME: Record<string, PortolanEventType> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  SubagentStop: 'subagent_stop',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  Notification: 'notification',
  tool_call: 'pre_tool_use',
  tool_result: 'post_tool_use',
  session_start: 'session_start',
  session_end: 'session_end',
};

const TOOL_ALIASES: Record<string, NormalizedToolTouch['tool']> = {
  Read: 'Read',
  read: 'Read',
  read_file: 'Read',
  ReadFile: 'Read',
  str_replace_based_edit_tool__read_file: 'Read',
  Write: 'Write',
  write: 'Write',
  write_file: 'Write',
  WriteFile: 'Write',
  create_file: 'Write',
  Edit: 'Edit',
  edit: 'Edit',
  edit_file: 'Edit',
  str_replace_based_edit_tool__str_replace: 'Edit',
  apply_patch: 'Edit',
};

const FILE_PATH_KEYS = [
  'file_path',
  'path',
  'absolute_path',
  'filepath',
  'filePath',
  'target_file',
];

export function normalizeHarnessEvent(
  payload: Record<string, unknown>,
  options: NormalizeOptions,
): PortolanEvent | null {
  const eventType = normalizeEventType(payload);
  if (!eventType) return null;

  const timestamp = normalizeTimestamp(payload.timestamp) ?? options.timestamp ?? Date.now();
  const sessionId = stringField(payload.session_id)
    ?? stringField(payload.sessionId)
    ?? stringField(payload.session)
    ?? 'unknown';
  const tmuxSession = options.tmuxSession
    ?? stringField(payload.tmux_session)
    ?? stringField(payload.tmuxSession)
    ?? '';

  const event: PortolanEvent = {
    id: `${options.harness}-${sessionId}-${timestamp}-${Math.floor(Math.random() * 100000)}`,
    timestamp,
    type: eventType,
    sessionId,
    cwd: stringField(payload.cwd) ?? '',
    tmuxSession,
    harness: options.harness,
  };

  if (options.originName) {
    event.originName = options.originName;
  }

  const prompt = stringField(payload.prompt);
  if (prompt) {
    event.prompt = prompt;
  }

  const touch = normalizeToolTouch(payload);
  if (touch) {
    event.tool = touch.tool;
    event.toolInput = touch.toolInput;
  } else {
    const toolName = stringField(payload.tool_name) ?? stringField(payload.toolName);
    const toolInput = objectField(payload.tool_input) ?? objectField(payload.input);
    if (toolName) event.tool = toolName;
    if (toolInput) event.toolInput = toolInput;
  }

  return event;
}

export function normalizeToolTouch(payload: Record<string, unknown>): NormalizedToolTouch | null {
  const rawTool = stringField(payload.tool_name)
    ?? stringField(payload.toolName)
    ?? stringField(payload.name);
  if (!rawTool) return null;

  const tool = TOOL_ALIASES[rawTool];
  if (!tool) return null;

  const rawInput = objectField(payload.tool_input)
    ?? objectField(payload.input)
    ?? objectField(payload.args)
    ?? {};
  const filePath = extractFilePath(rawInput);
  if (!filePath) return null;

  return {
    tool,
    toolInput: {
      ...rawInput,
      file_path: filePath,
    },
  };
}

function normalizeEventType(payload: Record<string, unknown>): PortolanEventType | null {
  const raw = stringField(payload.hook_event_name)
    ?? stringField(payload.event)
    ?? stringField(payload.eventName)
    ?? stringField(payload.type);
  if (!raw) return null;
  return EVENT_TYPE_BY_HOOK_NAME[raw] ?? null;
}

function extractFilePath(input: Record<string, unknown>): string | null {
  for (const key of FILE_PATH_KEYS) {
    const value = stringField(input[key]);
    if (value) return value;
  }
  return null;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  return Number.isFinite(asDate) ? asDate : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function objectField(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
