import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingBridge } from '../MeetingBridge.js';
import type { TranscriptSource, TranscriptSourceCallbacks } from '../VoiceInkTranscriptSource.js';

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

describe('MeetingBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('boots a meeting run, persists transcript chunks, and injects wrapped messages', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    let source: FakeTranscriptSource | null = null;

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource: (_options, callbacks) => {
          source = new FakeTranscriptSource(callbacks);
          return source;
        },
      },
    });

    const run = bridge.start({
      target: {
        sessionId: 'worker-1',
        tmuxSession: 'worker-1',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    expect(source?.started).toBe(true);
    expect(messenger.send).toHaveBeenCalledTimes(1);
    expect(messenger.send).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-1' }),
      expect.stringContaining('Portolan meeting assistant mode is now active.'),
      { pressEnter: true },
    );

    source?.emit({
      id: 17,
      timestamp_local: '2026-04-02 19:41:00',
      duration_s: 8.25,
      enhanced_text: 'Could we pull up the calibration plot before deciding?',
      status: 'complete',
      audio_file_url: '/tmp/chunk.m4a',
    });

    const state = bridge.getState();
    expect(state.activeMeeting?.chunkCount).toBe(1);
    expect(state.activeMeeting?.injectedCount).toBe(2);
    expect(messenger.send).toHaveBeenCalledTimes(2);
    expect(messenger.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-1' }),
      expect.stringContaining('Could we pull up the calibration plot before deciding?'),
      { pressEnter: true },
    );

    const transcriptLines = readFileSync(run.transcriptPath, 'utf-8').trim().split('\n');
    expect(transcriptLines).toHaveLength(1);
    expect(JSON.parse(transcriptLines[0])).toMatchObject({
      meetingId: run.meetingId,
      chunkIndex: 1,
      sourceChunkId: '17',
      text: 'Could we pull up the calibration plot before deciding?',
    });

    const injectionLines = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n');
    expect(injectionLines).toHaveLength(2);
    expect(JSON.parse(injectionLines[0]).kind).toBe('bootstrap');
    expect(JSON.parse(injectionLines[1])).toMatchObject({
      kind: 'transcript-chunk',
      chunkIndex: 1,
      sourceChunkId: '17',
    });
  });

  it('records blank transcript chunks without injecting them into the worker', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    let source: FakeTranscriptSource | null = null;

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource: (_options, callbacks) => {
          source = new FakeTranscriptSource(callbacks);
          return source;
        },
      },
    });

    const run = bridge.start({
      target: {
        sessionId: 'worker-2',
        tmuxSession: 'worker-2',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    source?.emit({
      id: 18,
      timestamp_local: '2026-04-02 19:42:00',
      text: '',
      enhanced_text: '',
      status: 'complete',
    });

    expect(messenger.send).toHaveBeenCalledTimes(1);
    const transcript = JSON.parse(readFileSync(run.transcriptPath, 'utf-8').trim());
    expect(transcript.chunkIndex).toBe(1);
    expect(transcript.text).toBe('');
  });

  it('stops the active source and marks the run errored when the source fails', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    let source: FakeTranscriptSource | null = null;

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource: (_options, callbacks) => {
          source = new FakeTranscriptSource(callbacks);
          return source;
        },
      },
    });

    bridge.start({
      target: {
        sessionId: 'worker-3',
        tmuxSession: 'worker-3',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    source?.fail('voiceink disappeared');

    const state = bridge.getState();
    expect(source?.stopped).toBe(true);
    expect(state.activeMeeting).toBeNull();
    expect(state.lastMeeting?.status).toBe('error');
    expect(state.lastMeeting?.lastError).toBe('voiceink disappeared');
  });

  it('accepts manual transcript chunks over the generic ingest path', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    const run = bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-manual',
        tmuxSession: 'worker-manual',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    expect(run.sourceType).toBe('manual');
    expect(messenger.send).toHaveBeenCalledTimes(1);

    const updated = bridge.ingestChunk({
      id: 'manual-1',
      timestamp_local: '2026-04-02 20:45:00',
      speaker: 'Scientist',
      text: 'Log this as still unresolved until we compare against DES.',
      status: 'partial',
    });

    expect(updated.chunkCount).toBe(1);
    expect(updated.injectedCount).toBe(2);
    expect(messenger.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-manual' }),
      expect.stringContaining('source: manual'),
      { pressEnter: true },
    );

    const transcript = JSON.parse(readFileSync(run.transcriptPath, 'utf-8').trim());
    expect(transcript).toMatchObject({
      sourceChunkId: 'manual-1',
      speaker: 'Scientist',
      text: 'Log this as still unresolved until we compare against DES.',
      status: 'partial',
    });
  });

  it('persists operator updates and injects them into the active worker thread', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    const run = bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-update',
        tmuxSession: 'worker-update',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    const updated = bridge.ingestOperatorUpdate({
      kind: 'correction',
      text: 'No, the calibration comparison is still unresolved. Keep this tentative.',
    });

    expect(updated.operatorUpdateCount).toBe(1);
    expect(updated.injectedCount).toBe(2);
    expect(updated.lastOperatorUpdatePreview).toContain('calibration comparison');
    expect(messenger.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-update' }),
      expect.stringContaining('Portolan Meeting Operator Update'),
      { pressEnter: true },
    );

    const updateLog = JSON.parse(readFileSync(run.updatesPath, 'utf-8').trim());
    expect(updateLog).toMatchObject({
      meetingId: run.meetingId,
      updateIndex: 1,
      kind: 'correction',
      text: 'No, the calibration comparison is still unresolved. Keep this tentative.',
    });

    const injections = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(injections[1])).toMatchObject({
      kind: 'operator-update',
      updateIndex: 1,
    });
  });

  it('emits state updates as the meeting run changes', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const states: Array<{ activeMeeting: string | null; lastMeeting: string | null; chunkCount: number; operatorUpdateCount: number }> = [];

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    bridge.onStateChange((state) => {
      states.push({
        activeMeeting: state.activeMeeting?.status ?? null,
        lastMeeting: state.lastMeeting?.status ?? null,
        chunkCount: state.activeMeeting?.chunkCount ?? state.lastMeeting?.chunkCount ?? 0,
        operatorUpdateCount: state.activeMeeting?.operatorUpdateCount ?? state.lastMeeting?.operatorUpdateCount ?? 0,
      });
    });

    bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-stream',
        tmuxSession: 'worker-stream',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });
    bridge.ingestChunk({ id: 'c1', text: 'Pull up the prior evidence chain.' });
    bridge.ingestOperatorUpdate({ text: 'Keep this tentative until we compare both plots.' });
    bridge.stop();

    expect(states).toEqual([
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 0, operatorUpdateCount: 0 },
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 1, operatorUpdateCount: 0 },
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 1, operatorUpdateCount: 1 },
      { activeMeeting: null, lastMeeting: 'stopped', chunkCount: 1, operatorUpdateCount: 1 },
    ]);
  });

  it('recovers the most recent persisted meeting state on startup', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const meetingDir = join(baseDir, '2026-04-02-worker-portolan');
    mkdirSync(meetingDir, { recursive: true });

    writeFileSync(join(meetingDir, 'meeting.json'), JSON.stringify({
      meetingId: 'meeting-42',
      status: 'stopped',
      sourceType: 'voiceink',
      startedAt: 101,
      stoppedAt: 202,
      sessionId: 'worker-42',
      tmuxSession: 'worker-42',
      originId: 'local',
      cityPath: '/project/portolan',
      transcriptPath: join(meetingDir, 'transcript.jsonl'),
      injectionsPath: join(meetingDir, 'injections.jsonl'),
      metadataPath: join(meetingDir, 'meeting.json'),
      chunkCount: 3,
      injectedCount: 4,
      lastChunkPreview: 'Recovered chunk',
    }, null, 2));

    const bridge = new MeetingBridge({ baseDir, messenger: { send: vi.fn() } });
    expect(bridge.getState().lastMeeting).toMatchObject({
      meetingId: 'meeting-42',
      status: 'stopped',
      chunkCount: 3,
      injectedCount: 4,
      operatorUpdateCount: 0,
      updatesPath: join(meetingDir, 'operator-updates.jsonl'),
      lastChunkPreview: 'Recovered chunk',
    });
  });

  it('downgrades a recovered running meeting to stopped because the source is no longer attached', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const latestPath = join(baseDir, 'latest-meeting.json');

    writeFileSync(latestPath, JSON.stringify({
      meetingId: 'meeting-99',
      status: 'running',
      sourceType: 'voiceink',
      startedAt: 1000,
      sessionId: 'worker-99',
      tmuxSession: 'worker-99',
      originId: 'local',
      cityPath: '/project/portolan',
      transcriptPath: '/tmp/transcript.jsonl',
      injectionsPath: '/tmp/injections.jsonl',
      metadataPath: '/tmp/meeting.json',
      chunkCount: 8,
      injectedCount: 9,
    }, null, 2));

    const before = Date.now();
    const bridge = new MeetingBridge({ baseDir, messenger: { send: vi.fn() } });
    const after = Date.now();
    const recovered = bridge.getState().lastMeeting;

    expect(recovered).toMatchObject({
      meetingId: 'meeting-99',
      status: 'stopped',
      chunkCount: 8,
      injectedCount: 9,
    });
    expect(recovered?.stoppedAt).toBeGreaterThanOrEqual(before);
    expect(recovered?.stoppedAt).toBeLessThanOrEqual(after);
  });
});
