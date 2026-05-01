import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingBridge } from '../MeetingBridge.js';
import type { TranscriptSource, TranscriptSourceCallbacks } from '../ParakeetTranscriptSource.js';

class FakeTranscriptSource implements TranscriptSource {
  started = false;
  stopped = false;

  constructor(private readonly callbacks: TranscriptSourceCallbacks) {}

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  emit(chunk: unknown): void {
    this.callbacks.onChunk(chunk);
  }

  fail(message: string): void {
    this.callbacks.onError(new Error(message));
  }
}

function makeBridge(overrides: { baseDir?: string; messenger?: { send: ReturnType<typeof vi.fn> } } = {}) {
  const baseDir = overrides.baseDir ?? mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
  const messenger = overrides.messenger ?? { send: vi.fn() };
  const createParakeetSource = vi.fn<(options: unknown, callbacks: TranscriptSourceCallbacks) => TranscriptSource>(
    (_options, callbacks) => new FakeTranscriptSource(callbacks),
  );
  const createVibeVoiceSource = vi.fn<(options: unknown, callbacks: TranscriptSourceCallbacks) => TranscriptSource>(
    (_options, callbacks) => new FakeTranscriptSource(callbacks),
  );
  const bridge = new MeetingBridge({
    baseDir,
    messenger,
    sourceFactory: { createParakeetSource, createVibeVoiceSource },
  });
  return { bridge, baseDir, messenger, createParakeetSource, createVibeVoiceSource };
}

describe('MeetingBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('safety guardrail', () => {
    it('refuses to spawn a real Parakeet daemon when no factory is injected', () => {
      const bridge = new MeetingBridge({
        baseDir: mkdtempSync(join(tmpdir(), 'meeting-bridge-')),
        messenger: { send: vi.fn() },
      });
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      expect(() =>
        bridge.start({
          target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
        }),
      ).toThrow(/createParakeetSource not injected/);
    });
  });

  describe('start and bootstrap', () => {
    it('starts the parakeet source and sends exactly one bootstrap message', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, messenger, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_options, callbacks) => {
        source = new FakeTranscriptSource(callbacks);
        return source;
      });

      const run = bridge.start({
        target: { sessionId: 'worker-1', tmuxSession: 'worker-1', originId: 'local', cwd: cityPath },
      });

      expect(createParakeetSource).toHaveBeenCalledTimes(1);
      expect(source?.started).toBe(true);
      expect(run.status).toBe('running');
      expect(messenger.send).toHaveBeenCalledTimes(1);
      expect(messenger.send).toHaveBeenCalledWith(
        expect.objectContaining({ tmuxSession: 'worker-1' }),
        expect.any(String),
        { pressEnter: true },
      );
    });

    it('bootstrap prompt references the cwd symlink, mentions /loop, and names actionable categories', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, messenger } = makeBridge();
      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });
      const bootstrap = messenger.send.mock.calls[0][1] as string;
      expect(bootstrap).toContain('.portolan/current-meeting.md');
      expect(bootstrap).toContain('/loop');
      expect(bootstrap).toContain('plot');
      expect(bootstrap).toContain('todo');
      expect(bootstrap).toContain('fiber');
      expect(bootstrap).toMatch(/not interrupt|not respond/i);
    });

    it('honors a custom initialPrompt when provided', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, messenger } = makeBridge();
      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
        initialPrompt: 'Custom meeting brief.',
      });
      expect(messenger.send).toHaveBeenCalledWith(expect.anything(), 'Custom meeting brief.', { pressEnter: true });
    });

    it('forwards parakeet options to the factory and defaults mic mode to archive audio', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
        parakeet: { mode: 'mic', model: 'mlx-community/parakeet-tdt-0.6b-v3' },
      });
      const [options] = createParakeetSource.mock.calls[0];
      expect(options).toMatchObject({ mode: 'mic', model: 'mlx-community/parakeet-tdt-0.6b-v3' });
      expect((options as { saveAudioPath?: string }).saveAudioPath).toMatch(/audio\.wav$/);
    });

    it('does not override an explicit saveAudioPath', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
        parakeet: { mode: 'mic', saveAudioPath: '/tmp/custom.wav' },
      });
      const [options] = createParakeetSource.mock.calls[0];
      expect((options as { saveAudioPath?: string }).saveAudioPath).toBe('/tmp/custom.wav');
    });

    it('starts the vibevoice source when requested and records the audio path', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource, createVibeVoiceSource } = makeBridge();
      const run = bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
        sourceType: 'vibevoice',
        vibevoice: { mode: 'audio', audioPath: '/tmp/meeting.wav', prompt: 'CMB lensing meeting' },
      });

      expect(createParakeetSource).not.toHaveBeenCalled();
      expect(createVibeVoiceSource).toHaveBeenCalledWith(
        { mode: 'audio', audioPath: '/tmp/meeting.wav', prompt: 'CMB lensing meeting' },
        expect.anything(),
      );
      expect(run.sourceType).toBe('vibevoice');
      expect(run.audioPath).toBe('/tmp/meeting.wav');
    });
  });

  describe('transcript delivery (file-backed, no prompt injection)', () => {
    it('accumulates chunks into transcript.md without ever calling messenger.send again', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, messenger, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_o, c) => (source = new FakeTranscriptSource(c)));

      const run = bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });

      for (let i = 1; i <= 5; i += 1) {
        source?.emit({ id: `c${i}`, status: 'partial', text: `chunk ${i} tentative` });
        source?.emit({ id: `c${i}`, status: 'complete', text: `chunk ${i} settled` });
      }

      expect(messenger.send).toHaveBeenCalledTimes(1);
      const md = readFileSync(run.transcriptMarkdownPath, 'utf-8');
      expect(md).toContain('chunk 5 settled');
      expect(md).not.toContain(' …');
    });

    it('updates the cwd-local symlink as partial chunks settle', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_o, c) => (source = new FakeTranscriptSource(c)));

      const run = bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });

      const symlinkPath = join(cityPath, '.portolan', 'current-meeting.md');
      expect(readlinkSync(symlinkPath)).toBe(run.transcriptMarkdownPath);

      source?.emit({ id: 'c1', status: 'partial', text: 'we are still thinking' });
      expect(readFileSync(symlinkPath, 'utf-8')).toContain('we are still thinking …');

      source?.emit({ id: 'c1', status: 'complete', text: 'we are still thinking about calibration' });
      const settled = readFileSync(symlinkPath, 'utf-8');
      expect(settled).toContain('we are still thinking about calibration');
      expect(settled).not.toContain(' …');
    });

    it('skips the cwd symlink when the city path does not exist (remote workers fall back to absolute)', () => {
      const { bridge, messenger } = makeBridge();
      const run = bridge.start({
        target: {
          sessionId: 'w',
          tmuxSession: 'w',
          originId: 'local',
          cwd: '/nonexistent/remote/project',
        },
      });
      expect(run.currentMeetingSymlinkPath).toBeUndefined();
      const bootstrap = messenger.send.mock.calls[0][1] as string;
      expect(bootstrap).toContain(run.transcriptMarkdownPath);
      expect(bootstrap).not.toContain('.portolan/current-meeting.md');
    });

    it('skips the cwd symlink for remote origins', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge } = makeBridge();
      const run = bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'remote-candide', cwd: cityPath },
      });
      expect(run.currentMeetingSymlinkPath).toBeUndefined();
      expect(existsSync(join(cityPath, '.portolan', 'current-meeting.md'))).toBe(false);
    });
  });

  describe('stop and teardown', () => {
    it('stops the source, removes the symlink, and transitions state to stopped', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_o, c) => (source = new FakeTranscriptSource(c)));

      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });
      const symlinkPath = join(cityPath, '.portolan', 'current-meeting.md');
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

      bridge.stop();

      expect(source?.stopped).toBe(true);
      expect(existsSync(symlinkPath)).toBe(false);
      expect(bridge.getState().activeMeeting).toBeNull();
      expect(bridge.getState().lastMeeting?.status).toBe('stopped');
    });

    it('transitions to error when the source emits onError', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_o, c) => (source = new FakeTranscriptSource(c)));

      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });
      source?.fail('daemon died');

      const state = bridge.getState();
      expect(state.activeMeeting).toBeNull();
      expect(state.lastMeeting?.status).toBe('error');
      expect(state.lastMeeting?.lastError).toBe('daemon died');
    });

    it('stops an existing meeting when a new one starts', () => {
      const cityPathA = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const cityPathB = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      const sources: FakeTranscriptSource[] = [];
      createParakeetSource.mockImplementation((_o, c) => {
        const s = new FakeTranscriptSource(c);
        sources.push(s);
        return s;
      });

      bridge.start({
        target: { sessionId: 'wA', tmuxSession: 'wA', originId: 'local', cwd: cityPathA },
      });
      bridge.start({
        target: { sessionId: 'wB', tmuxSession: 'wB', originId: 'local', cwd: cityPathB },
      });

      expect(sources[0].stopped).toBe(true);
      expect(sources[1].started).toBe(true);
    });
  });

  describe('chunk normalization', () => {
    it('tracks revisions on the same source id without inflating chunkCount', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_o, c) => (source = new FakeTranscriptSource(c)));

      bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });

      source?.emit({ id: 'c1', status: 'partial', text: 'first' });
      source?.emit({ id: 'c1', status: 'partial', text: 'first revised' });
      source?.emit({ id: 'c1', status: 'complete', text: 'first settled' });
      source?.emit({ id: 'c2', status: 'complete', text: 'second' });

      const state = bridge.getState();
      expect(state.activeMeeting?.chunkCount).toBe(2);
    });

    it('marks partial chunks with trailing "…" in the markdown, strips it on settle', () => {
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const { bridge, createParakeetSource } = makeBridge();
      let source: FakeTranscriptSource | null = null;
      createParakeetSource.mockImplementation((_o, c) => (source = new FakeTranscriptSource(c)));

      const run = bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });

      source?.emit({ id: 'c1', status: 'partial', text: 'hello world' });
      expect(readFileSync(run.transcriptMarkdownPath, 'utf-8')).toContain('hello world …');

      source?.emit({ id: 'c1', status: 'complete', text: 'hello world!' });
      expect(readFileSync(run.transcriptMarkdownPath, 'utf-8').trim()).toBe('hello world!');
    });
  });

  describe('persistence', () => {
    it('recovers the last meeting on a fresh bridge, downgrading running→stopped', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
      const first = makeBridge({ baseDir });
      first.bridge.start({
        target: { sessionId: 'w', tmuxSession: 'w', originId: 'local', cwd: cityPath },
      });
      // Simulate abrupt termination: don't call stop().

      const recovered = new MeetingBridge({
        baseDir,
        messenger: { send: vi.fn() },
        sourceFactory: { createParakeetSource: vi.fn() },
      });
      const last = recovered.getState().lastMeeting;
      expect(last).not.toBeNull();
      expect(last?.status).toBe('stopped');
    });
  });
});
