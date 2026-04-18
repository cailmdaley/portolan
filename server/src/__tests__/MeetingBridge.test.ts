import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

  it('boots a meeting run, persists transcript chunks to transcript.md, and never injects chunks into the worker', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
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
        cwd: cityPath,
      },
    });

    expect(run.liveDocumentPath).toBe(join(cityPath, 'meeting-live-brief.md'));
    expect(run.currentMeetingSymlinkPath).toBe(join(cityPath, '.portolan', 'current-meeting.md'));
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
    expect(state.activeMeeting?.injectedCount).toBe(1);
    expect(state.activeMeeting?.recentTranscriptChunks).toEqual([
      expect.objectContaining({
        chunkIndex: 1,
        sourceChunkId: '17',
        text: 'Could we pull up the calibration plot before deciding?',
      }),
    ]);
    // Transcript chunks must never be delivered via messenger.send — they
    // would interrupt the worker's Claude Code turn boundaries.
    expect(messenger.send).toHaveBeenCalledTimes(1);

    const transcriptLines = readFileSync(run.transcriptPath, 'utf-8').trim().split('\n');
    expect(transcriptLines).toHaveLength(1);
    expect(JSON.parse(transcriptLines[0])).toMatchObject({
      meetingId: run.meetingId,
      chunkIndex: 1,
      sourceChunkId: '17',
      text: 'Could we pull up the calibration plot before deciding?',
    });

    const injectionLines = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n');
    expect(injectionLines).toHaveLength(1);
    expect(JSON.parse(injectionLines[0]).kind).toBe('bootstrap');

    const transcriptMd = readFileSync(run.transcriptMarkdownPath, 'utf-8');
    expect(transcriptMd).toContain('Could we pull up the calibration plot before deciding?');
    expect(transcriptMd).not.toContain(' …');
    // Symlink at <cwd>/.portolan/current-meeting.md resolves to transcript.md.
    expect(readFileSync(join(cityPath, '.portolan', 'current-meeting.md'), 'utf-8')).toBe(transcriptMd);

    const liveDocument = readFileSync(run.liveDocumentPath, 'utf-8');
    expect(liveDocument).toContain(`# Live meeting brief: ${run.meetingId}`);
    expect(liveDocument).toContain('## Recent thread');
    expect(liveDocument).toContain('Could we pull up the calibration plot before deciding?');
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

  it('spawns the parakeet source when sourceType=parakeet and forwards options', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    let parakeetSource: FakeTranscriptSource | null = null;
    const createVoiceInkSource = vi.fn(() => {
      throw new Error('voiceink should not start for parakeet meetings');
    });
    const createParakeetSource = vi.fn((_options, callbacks) => {
      parakeetSource = new FakeTranscriptSource(callbacks);
      return parakeetSource;
    });

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: {
        createVoiceInkSource,
        createParakeetSource,
      },
    });

    const parakeetOptions = { mode: 'mic' as const, model: 'mlx-community/parakeet-tdt-0.6b-v2' };
    const run = bridge.start({
      sourceType: 'parakeet',
      parakeet: parakeetOptions,
      target: {
        sessionId: 'worker-parakeet',
        tmuxSession: 'worker-parakeet',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    expect(run.sourceType).toBe('parakeet');
    expect(createVoiceInkSource).not.toHaveBeenCalled();
    // MeetingBridge threads through the original options and adds a default
    // saveAudioPath for mic mode (archives PCM alongside transcript.jsonl).
    expect(createParakeetSource).toHaveBeenCalledWith(
      expect.objectContaining(parakeetOptions),
      expect.any(Object),
    );
    expect(parakeetSource?.started).toBe(true);

    parakeetSource?.emit({
      id: 'u1',
      text: 'we should',
      status: 'partial',
    });
    parakeetSource?.emit({
      id: 'u1',
      text: 'we should check the calibration',
      status: 'partial',
    });
    parakeetSource?.emit({
      id: 'u1',
      text: 'we should check the calibration plot.',
      status: 'complete',
    });

    const state = bridge.getState();
    const recent = state.activeMeeting?.recentTranscriptChunks ?? [];
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      chunkIndex: 1,
      sourceChunkId: 'u1',
      text: 'we should check the calibration plot.',
    });
    expect(recent[0].isPartial).toBeFalsy();
    expect(recent[0].revisionIndex).toBe(3);

    const transcriptLines = readFileSync(run.transcriptPath, 'utf-8').trim().split('\n');
    expect(transcriptLines).toHaveLength(3);
    const parsed = transcriptLines.map((line) => JSON.parse(line));
    expect(parsed[0]).toMatchObject({ chunkIndex: 1, revisionIndex: 1, isPartial: true, isRevision: false });
    expect(parsed[1]).toMatchObject({ chunkIndex: 1, revisionIndex: 2, isPartial: true, isRevision: true });
    expect(parsed[2]).toMatchObject({ chunkIndex: 1, revisionIndex: 3, isPartial: false, isRevision: true });

    bridge.stop();
    expect(parakeetSource?.stopped).toBe(true);
  });

  it('defaults parakeet mic mode to archive audio alongside the transcript', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const createParakeetSource = vi.fn((_options, callbacks) => new FakeTranscriptSource(callbacks));

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: { createParakeetSource },
    });

    const run = bridge.start({
      sourceType: 'parakeet',
      parakeet: { mode: 'mic' },
      target: {
        sessionId: 'worker-parakeet',
        tmuxSession: 'worker-parakeet',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    expect(createParakeetSource).toHaveBeenCalledTimes(1);
    const [forwardedOptions] = createParakeetSource.mock.calls[0];
    const meetingDir = join(run.transcriptPath, '..');
    expect(forwardedOptions.saveAudioPath).toBe(join(meetingDir, 'audio.wav'));

    bridge.stop();
  });

  it('respects an explicit parakeet saveAudioPath (opt-out by setting null-like sentinel)', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const createParakeetSource = vi.fn((_options, callbacks) => new FakeTranscriptSource(callbacks));

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: { createParakeetSource },
    });

    bridge.start({
      sourceType: 'parakeet',
      parakeet: { mode: 'mic', saveAudioPath: '/tmp/elsewhere.wav' },
      target: {
        sessionId: 'worker-parakeet',
        tmuxSession: 'worker-parakeet',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    const [forwardedOptions] = createParakeetSource.mock.calls[0];
    expect(forwardedOptions.saveAudioPath).toBe('/tmp/elsewhere.wav');

    bridge.stop();
  });

  it('does not archive audio for parakeet --audio or --script modes', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const createParakeetSource = vi.fn((_options, callbacks) => new FakeTranscriptSource(callbacks));

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      sourceFactory: { createParakeetSource },
    });

    bridge.start({
      sourceType: 'parakeet',
      parakeet: { mode: 'script', scriptPath: '/tmp/x.jsonl' },
      target: {
        sessionId: 'worker-parakeet',
        tmuxSession: 'worker-parakeet',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    const [forwardedOptions] = createParakeetSource.mock.calls[0];
    expect(forwardedOptions.saveAudioPath).toBeUndefined();

    bridge.stop();
  });

  it('syncs the live meeting brief into astra.yaml before explicit promotion', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
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
        sessionId: 'worker-live-astra',
        tmuxSession: 'worker-live-astra',
        originId: 'local',
        cwd: cityPath,
      },
    });

    bridge.ingestChunk({
      id: 'chunk-1',
      text: 'The DES comparison is the blocker before we can settle calibration.',
    });
    bridge.ingestOperatorUpdate({
      kind: 'narrative',
      text: 'Calibration remains open until the DES comparison is checked.',
    });
    bridge.ingestAssistantResponses({
      sessionId: 'worker-live-astra',
      tmuxSession: 'worker-live-astra',
      originId: 'local',
    }, {
      sourceKey: 'live-astra-assistant-1',
      timestamp: '2026-04-03T08:05:00Z',
      text: 'The DES comparison fiber and latest calibration plot are the key evidence to resolve this.',
    });
    bridge.ingestCandidateEvent({
      kind: 'note',
      title: 'DES comparison gates calibration',
      text: 'Do not collapse the calibration conclusion until the DES comparison is reviewed.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestCandidateEvent({
      kind: 'question',
      title: 'Does the DES comparison change calibration?',
      text: 'Check whether the DES comparison materially changes the calibration conclusion.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestCandidateEvent({
      kind: 'decision',
      title: 'Keep calibration tentative',
      text: 'Treat calibration as unresolved pending the DES comparison.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestCandidateEvent({
      kind: 'action-item',
      title: 'Pull the latest calibration plot',
      text: 'Open the latest calibration plot beside the DES comparison fiber before concluding.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestRetrievalRequest({
      text: 'Pull the DES comparison fiber and the latest calibration plot into view.',
    });
    bridge.ingestRetrievedEvidence({
      type: 'fiber',
      title: 'use-des-weights',
      fiberId: 'use-des-weights',
      match: 'Decision to use DES weights for the comparison run.',
    });

    const updated = bridge.getState().activeMeeting;
    expect(updated?.liveAstraAnalysisId).toBe(`meeting-live-${run.meetingId}`.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\./g, '-'));
    expect(updated?.liveAstraPath).toBe(join(cityPath, 'astra.yaml'));
    expect(updated?.liveDocumentPath).toBe(join(cityPath, 'meeting-live-brief.md'));

    const astra = parseYaml(readFileSync(join(cityPath, 'astra.yaml'), 'utf-8')) as Record<string, any>;
    const liveAnalysis = astra.analyses[updated!.liveAstraAnalysisId];
    expect(liveAnalysis).toMatchObject({
      name: 'Live meeting brief: Calibration remains open until the DES comparison is checked.',
      tags: ['portolan', 'meeting', 'meeting-live'],
    });
    expect(liveAnalysis.description).toContain('Calibration remains open until the DES comparison is checked.');
    expect(liveAnalysis.description).toContain(run.liveDocumentPath);
    expect(liveAnalysis.findings['meeting-live-summary']).toMatchObject({
      claim: 'Calibration remains open until the DES comparison is checked.',
      tags: ['meeting', 'meeting-live-summary'],
    });
    expect(liveAnalysis.findings['meeting-live-note-1']).toMatchObject({
      claim: 'DES comparison gates calibration',
      tags: ['meeting', 'meeting-live-note'],
    });
    expect(liveAnalysis.findings['meeting-live-question-2']).toMatchObject({
      claim: 'Does the DES comparison change calibration?',
      tags: ['meeting', 'meeting-live-question'],
    });
    expect(liveAnalysis.findings['meeting-live-action-item-4']).toMatchObject({
      claim: 'Pull the latest calibration plot',
      tags: ['meeting', 'meeting-live-action-item'],
    });
    expect(liveAnalysis.decisions['meeting-decision-3']).toMatchObject({
      label: 'Keep calibration tentative',
      rationale: 'Treat calibration as unresolved pending the DES comparison.',
      tags: ['meeting', 'meeting-decision'],
    });
    expect(liveAnalysis.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'meeting_live_document', source: run.liveDocumentPath }),
      expect.objectContaining({ id: 'meeting_transcript_log', source: run.transcriptPath }),
      expect.objectContaining({ id: 'meeting_assistant_replies', source: run.assistantResponsesPath }),
      expect.objectContaining({ id: 'meeting_retrieval_requests', source: run.retrievalRequestsPath }),
    ]));
    expect(liveAnalysis.description).toContain(run.assistantResponsesPath);
    expect(liveAnalysis.description).toContain(run.retrievalRequestsPath);
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
    // Chunks update transcript.md only — no messenger.send beyond bootstrap.
    expect(updated.injectedCount).toBe(1);
    expect(messenger.send).toHaveBeenCalledTimes(1);

    const transcript = JSON.parse(readFileSync(run.transcriptPath, 'utf-8').trim());
    expect(transcript).toMatchObject({
      sourceChunkId: 'manual-1',
      speaker: 'Scientist',
      text: 'Log this as still unresolved until we compare against DES.',
      status: 'partial',
    });
  });

  it('keeps a stable chunk index across partial transcript revisions', () => {
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
        sessionId: 'worker-partial',
        tmuxSession: 'worker-partial',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestChunk({
      id: 'live-1',
      speaker: 'Scientist',
      status: 'partial',
      text: 'Could we pull up',
    });
    bridge.ingestChunk({
      id: 'live-1',
      speaker: 'Scientist',
      status: 'partial',
      text: 'Could we pull up the calibration plot',
    });
    const updated = bridge.ingestChunk({
      id: 'live-1',
      speaker: 'Scientist',
      status: 'complete',
      text: 'Could we pull up the calibration plot',
    });

    expect(updated.chunkCount).toBe(1);
    expect(updated.recentTranscriptChunks).toEqual([
      expect.objectContaining({
        chunkIndex: 1,
        revisionIndex: 3,
        status: 'complete',
        isRevision: true,
        text: 'Could we pull up the calibration plot',
      }),
    ]);

    const transcriptLines = readFileSync(run.transcriptPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(transcriptLines).toHaveLength(3);
    expect(transcriptLines.map((entry) => entry.chunkIndex)).toEqual([1, 1, 1]);
    expect(transcriptLines.map((entry) => entry.revisionIndex)).toEqual([1, 2, 3]);
    expect(transcriptLines.map((entry) => entry.isPartial)).toEqual([true, true, false]);

    const injections = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(injections).toHaveLength(1);
    expect(injections[0].kind).toBe('bootstrap');

    // transcript.md reflects the settled revision, no trailing "…" marker.
    const transcriptMd = readFileSync(run.transcriptMarkdownPath, 'utf-8');
    expect(transcriptMd).toContain('Scientist: Could we pull up the calibration plot');
    expect(transcriptMd).not.toContain(' …');
  });

  it('marks unsettled partial chunks with a trailing ellipsis in transcript.md', () => {
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
        sessionId: 'worker-partial-md',
        tmuxSession: 'worker-partial-md',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestChunk({
      id: 'live-1',
      status: 'partial',
      text: 'still working on this phrase',
    });

    const afterPartial = readFileSync(run.transcriptMarkdownPath, 'utf-8');
    expect(afterPartial).toContain('still working on this phrase …');

    bridge.ingestChunk({
      id: 'live-1',
      status: 'complete',
      text: 'still working on this phrase for real',
    });

    const afterSettled = readFileSync(run.transcriptMarkdownPath, 'utf-8');
    expect(afterSettled).toContain('still working on this phrase for real');
    expect(afterSettled).not.toContain(' …');
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
    expect(updated.recentOperatorUpdates).toEqual([
      expect.objectContaining({
        updateIndex: 1,
        kind: 'correction',
      }),
    ]);
    expect(updated.liveBrief.currentNarrative).toEqual(expect.objectContaining({
      updateIndex: 1,
      kind: 'correction',
      text: 'No, the calibration comparison is still unresolved. Keep this tentative.',
    }));
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

  it('records assistant responses for the active meeting session and ignores duplicates', () => {
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
        sessionId: 'worker-assistant',
        tmuxSession: 'worker-assistant',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    const updated = bridge.ingestAssistantResponses({
      sessionId: 'worker-assistant',
      tmuxSession: 'worker-assistant',
      originId: 'local',
    }, [
      {
        sourceKey: '2026-04-03T08:00:00Z#0',
        timestamp: '2026-04-03T08:00:00Z',
        text: 'The calibration plot agrees with the DES comparison within the current error bars.',
      },
      {
        sourceKey: '2026-04-03T08:00:00Z#0',
        timestamp: '2026-04-03T08:00:00Z',
        text: 'The calibration plot agrees with the DES comparison within the current error bars.',
      },
    ], {
      transcriptPath: '/tmp/session.jsonl',
      hookSessionId: 'hook-session-1',
    });

    expect(updated?.assistantResponseCount).toBe(1);
    expect(updated?.lastAssistantResponsePreview).toContain('The calibration plot agrees');
    expect(updated?.recentAssistantResponses).toEqual([
      expect.objectContaining({
        responseIndex: 1,
        timestamp: '2026-04-03T08:00:00Z',
        text: 'The calibration plot agrees with the DES comparison within the current error bars.',
      }),
    ]);

    expect(messenger.send).toHaveBeenCalledTimes(1);
    const assistantLines = readFileSync(run.assistantResponsesPath, 'utf-8').trim().split('\n');
    expect(assistantLines).toHaveLength(1);
    expect(JSON.parse(assistantLines[0])).toMatchObject({
      meetingId: run.meetingId,
      responseIndex: 1,
      sourceKey: '2026-04-03T08:00:00Z#0',
      transcriptPath: '/tmp/session.jsonl',
      hookSessionId: 'hook-session-1',
    });
  });

  it('captures candidate events with transcript provenance and injects them into the worker thread', () => {
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
        sessionId: 'worker-candidate',
        tmuxSession: 'worker-candidate',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestChunk({ id: 'chunk-1', text: 'We should keep this unresolved until we compare both calibrations.' });

    const updated = bridge.ingestCandidateEvent({
      kind: 'question',
      title: 'Calibration comparison still open',
      text: 'Whether the DES comparison changes the calibration conclusion remains open.',
      transcriptChunkIndices: [1],
    });

    expect(updated.candidateEventCount).toBe(1);
    // Bootstrap + candidate-event; transcript chunks no longer inject.
    expect(updated.injectedCount).toBe(2);
    expect(updated.lastCandidateEventPreview).toContain('Calibration comparison still open');
    expect(updated.recentCandidateEvents).toEqual([
      expect.objectContaining({
        eventIndex: 1,
        kind: 'question',
        title: 'Calibration comparison still open',
        transcriptChunkIndices: [1],
      }),
    ]);
    expect(updated.liveBrief.openQuestions).toEqual([
      expect.objectContaining({
        eventIndex: 1,
        kind: 'question',
        title: 'Calibration comparison still open',
      }),
    ]);
    expect(messenger.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-candidate' }),
      expect.stringContaining('Portolan Meeting Candidate Event'),
      { pressEnter: true },
    );

    const eventLog = JSON.parse(readFileSync(run.candidateEventsPath, 'utf-8').trim());
    expect(eventLog).toMatchObject({
      meetingId: run.meetingId,
      eventIndex: 1,
      kind: 'question',
      title: 'Calibration comparison still open',
      transcriptChunkIndices: [1],
      text: 'Whether the DES comparison changes the calibration conclusion remains open.',
    });

    const injections = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n');
    expect(injections).toHaveLength(2);
    expect(JSON.parse(injections[0]).kind).toBe('bootstrap');
    expect(JSON.parse(injections[1])).toMatchObject({
      kind: 'candidate-event',
      eventIndex: 1,
    });
  });

  it('promotes a candidate event into felt and records the promotion provenance', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const fiberPromoter = {
      createFiber: vi.fn(async () => 'meeting-question-fiber'),
    };

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      fiberPromoter,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    const run = bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-promote',
        tmuxSession: 'worker-promote',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestChunk({ id: 'chunk-1', text: 'Keep this unresolved until we compare against DES.' });
    bridge.ingestCandidateEvent({
      kind: 'question',
      title: 'DES comparison still open',
      text: 'Whether the DES comparison changes the calibration conclusion remains open.',
      transcriptChunkIndices: [1],
    });

    const updated = await bridge.promoteCandidateEvent(1);

    expect(fiberPromoter.createFiber).toHaveBeenCalledWith(expect.objectContaining({
      cityPath: '/project/portolan',
      originId: 'local',
      title: 'DES comparison still open',
      kind: 'question',
    }));
    expect(updated.promotedCandidateEventCount).toBe(1);
    expect(updated.lastPromotedCandidateFiberId).toBe('meeting-question-fiber');
    expect(updated.recentCandidateEvents).toEqual([
      expect.objectContaining({
        eventIndex: 1,
        promotedFiberId: 'meeting-question-fiber',
      }),
    ]);
    expect(updated.liveBrief.openQuestions).toEqual([
      expect.objectContaining({
        eventIndex: 1,
        promotedFiberId: 'meeting-question-fiber',
      }),
    ]);

    const promotions = readFileSync(run.candidatePromotionsPath, 'utf-8').trim().split('\n');
    expect(promotions).toHaveLength(1);
    expect(JSON.parse(promotions[0])).toMatchObject({
      meetingId: run.meetingId,
      eventIndex: 1,
      fiberId: 'meeting-question-fiber',
      kind: 'question',
    });

    const liveDocument = readFileSync(run.liveDocumentPath, 'utf-8');
    expect(liveDocument).toContain('promoted fiber: [meeting-question-fiber](<.felt/meeting-question-fiber/meeting-question-fiber.md>)');
  });

  it('syncs promoted meeting decisions into astra.yaml', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
    const messenger = { send: vi.fn() };
    const fiberPromoter = {
      createFiber: vi.fn(async () => 'meeting-decision-fiber'),
    };

    writeFileSync(join(cityPath, 'astra.yaml'), [
      '$schema: https://astra-spec.org/v1/analysis.schema.json',
      'version: "1.0"',
      'name: Project Fibers',
      '',
    ].join('\n'));

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      fiberPromoter,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    const run = bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-decision-promote',
        tmuxSession: 'worker-decision-promote',
        originId: 'local',
        cwd: cityPath,
      },
    });

    bridge.ingestChunk({ id: 'chunk-1', text: 'We will use the DES weighting path for the comparison run.' });
    bridge.ingestCandidateEvent({
      kind: 'decision',
      title: 'Use DES weighting for comparison run',
      text: 'Use the DES weighting path for the comparison run and keep the previous weighting as historical context only.',
      transcriptChunkIndices: [1],
    });

    const updated = await bridge.promoteCandidateEvent(1);

    expect(updated.lastPromotedCandidateFiberId).toBe('meeting-decision-fiber');
    expect(updated.lastPromotedCandidateAstraDecisionId).toContain(`meeting-${run.meetingId}-event-1-`);
    expect(updated.recentCandidateEvents).toEqual([
      expect.objectContaining({
        eventIndex: 1,
        promotedFiberId: 'meeting-decision-fiber',
        promotedAstraDecisionId: updated.lastPromotedCandidateAstraDecisionId,
      }),
    ]);

    const astra = parseYaml(readFileSync(join(cityPath, 'astra.yaml'), 'utf-8')) as Record<string, any>;
    const decision = astra.decisions[updated.lastPromotedCandidateAstraDecisionId!];
    expect(decision).toMatchObject({
      label: 'Use DES weighting for comparison run',
      default: 'accepted',
      tags: ['portolan', 'meeting', 'meeting-decision'],
      options: {
        accepted: {
          label: 'Accepted',
        },
      },
    });
    expect(decision.rationale).toContain('meeting-decision-fiber');
    expect(decision.rationale).toContain(run.metadataPath);

    const promotions = readFileSync(run.candidatePromotionsPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(promotions[0])).toMatchObject({
      eventIndex: 1,
      fiberId: 'meeting-decision-fiber',
      astraDecisionId: updated.lastPromotedCandidateAstraDecisionId,
      astraPath: join(cityPath, 'astra.yaml'),
    });
  });

  it('rejects promoting a candidate event twice', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const fiberPromoter = {
      createFiber: vi.fn(async () => 'meeting-note-fiber'),
    };

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      fiberPromoter,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-promote-repeat',
        tmuxSession: 'worker-promote-repeat',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestChunk({ id: 'chunk-1', text: 'Accepted note with provenance.' });
    bridge.ingestCandidateEvent({
      kind: 'note',
      text: 'Capture this as an accepted note.',
      transcriptChunkIndices: [1],
    });

    await bridge.promoteCandidateEvent(1);

    await expect(bridge.promoteCandidateEvent(1)).rejects.toThrowError(
      'Meeting candidate event already promoted: 1',
    );
  });

  it('promotes the current live brief into felt and records the promotion provenance', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
    const messenger = { send: vi.fn() };
    const fiberPromoter = {
      createFiber: vi.fn(async () => 'meeting-brief-fiber'),
    };
    writeFileSync(join(cityPath, 'astra.yaml'), [
      '$schema: https://astra-spec.org/v1/analysis.schema.json',
      'version: "1.0"',
      'name: Portolan',
      'decisions: {}',
      'prior_insights: {}',
      'findings: {}',
      '',
    ].join('\n'));

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      fiberPromoter,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    const run = bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-brief-promote',
        tmuxSession: 'worker-brief-promote',
        originId: 'local',
        cwd: cityPath,
      },
    });

    bridge.ingestChunk({ id: 'chunk-1', text: 'We still need the DES calibration comparison before settling this.' });
    bridge.ingestOperatorUpdate({ kind: 'narrative', text: 'Calibration remains open pending the DES comparison.' });
    bridge.ingestAssistantResponses({
      sessionId: 'worker-brief-promote',
      tmuxSession: 'worker-brief-promote',
      originId: 'local',
    }, {
      sourceKey: 'brief-promote-assistant-1',
      timestamp: '2026-04-03T09:10:00Z',
      text: 'The next useful step is to pull the calibration plot and compare it against DES weighting.',
    });
    bridge.ingestCandidateEvent({
      kind: 'question',
      title: 'Does DES change calibration?',
      text: 'Check whether the DES comparison changes the calibration conclusion.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestCandidateEvent({
      kind: 'decision',
      title: 'Hold calibration conclusion until DES comparison',
      text: 'Do not finalize the calibration conclusion before reviewing the DES comparison.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestCandidateEvent({
      kind: 'note',
      title: 'Comparison run already scoped',
      text: 'The DES-weight comparison run is already scoped and only needs execution.',
      transcriptChunkIndices: [1],
    });
    bridge.ingestCandidateEvent({
      kind: 'action-item',
      title: 'Pull calibration plot into view',
      text: 'Open the latest calibration plot during this meeting before making the call.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestRetrievalRequest({
      text: 'Pull the calibration plot and the DES-weighting fiber.',
    });
    bridge.ingestRetrievedEvidence({
      type: 'fiber',
      title: 'use-des-weights',
      fiberId: 'use-des-weights',
      match: 'Decision to use DES weights for the comparison run.',
    });

    const updated = await bridge.promoteLiveBrief();

    expect(fiberPromoter.createFiber).toHaveBeenCalledWith(expect.objectContaining({
      cityPath,
      originId: 'local',
      kind: 'task',
      title: 'Meeting brief: Calibration remains open pending the DES comparison.',
    }));
    expect(fiberPromoter.createFiber).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('## Current narrative'),
    }));
    expect(fiberPromoter.createFiber).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('## Open questions'),
    }));
    expect(fiberPromoter.createFiber).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('use-des-weights'),
    }));
    expect(updated.briefPromotionCount).toBe(1);
    expect(updated.lastBriefPromotionFiberId).toBe('meeting-brief-fiber');
    expect(updated.lastBriefPromotionAstraAnalysisId).toBe(`meeting-${run.meetingId}`.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\./g, '-'));
    expect(updated.recentBriefPromotions).toEqual([
      expect.objectContaining({
        promotionIndex: 1,
        fiberId: 'meeting-brief-fiber',
        astraAnalysisId: updated.lastBriefPromotionAstraAnalysisId,
        astraPath: join(cityPath, 'astra.yaml'),
      }),
    ]);

    const promotions = readFileSync(run.briefPromotionsPath, 'utf-8').trim().split('\n');
    expect(promotions).toHaveLength(1);
    expect(JSON.parse(promotions[0])).toMatchObject({
      meetingId: run.meetingId,
      promotionIndex: 1,
      fiberId: 'meeting-brief-fiber',
      astraAnalysisId: updated.lastBriefPromotionAstraAnalysisId,
      astraPath: join(cityPath, 'astra.yaml'),
    });

    const astra = parseYaml(readFileSync(join(cityPath, 'astra.yaml'), 'utf-8')) as Record<string, any>;
    const liveAnalysis = astra.analyses[updated.liveAstraAnalysisId!];
    const briefAnalysis = astra.analyses[updated.lastBriefPromotionAstraAnalysisId!];
    expect(liveAnalysis).toMatchObject({
      name: 'Live meeting brief: Calibration remains open pending the DES comparison.',
      tags: ['portolan', 'meeting', 'meeting-live'],
    });
    expect(briefAnalysis).toMatchObject({
      name: 'Meeting brief: Calibration remains open pending the DES comparison.',
      tags: ['portolan', 'meeting', 'meeting-brief'],
    });
    expect(updated.lastBriefPromotionAstraAnalysisId).not.toBe(updated.liveAstraAnalysisId);
    expect(briefAnalysis.description).toContain('Calibration remains open pending the DES comparison.');
    expect(briefAnalysis.description).toContain('meeting-brief-fiber');
    expect(briefAnalysis.findings['meeting-summary']).toMatchObject({
      claim: 'Calibration remains open pending the DES comparison.',
      tags: ['meeting', 'meeting-summary'],
    });
    expect(briefAnalysis.findings['accepted-note-3']).toMatchObject({
      claim: 'Comparison run already scoped',
      notes: 'The DES-weight comparison run is already scoped and only needs execution.',
      tags: ['meeting', 'accepted-note'],
    });
    expect(briefAnalysis.findings['open-question-1']).toMatchObject({
      claim: 'Does DES change calibration?',
      tags: ['meeting', 'open-question'],
    });
    expect(briefAnalysis.findings['action-item-4']).toMatchObject({
      claim: 'Pull calibration plot into view',
      tags: ['meeting', 'action-item'],
    });
    expect(briefAnalysis.decisions['meeting-decision-2']).toMatchObject({
      label: 'Hold calibration conclusion until DES comparison',
      rationale: 'Do not finalize the calibration conclusion before reviewing the DES comparison.',
      tags: ['meeting', 'meeting-decision'],
      default: 'accepted',
    });
    expect(briefAnalysis.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'meeting_transcript_log', source: run.transcriptPath }),
      expect.objectContaining({ id: 'meeting_operator_updates', source: run.updatesPath }),
      expect.objectContaining({ id: 'meeting_assistant_replies', source: run.assistantResponsesPath }),
      expect.objectContaining({ id: 'meeting_retrieval_requests', source: run.retrievalRequestsPath }),
    ]));
    expect(briefAnalysis.description).toContain(run.assistantResponsesPath);
    expect(briefAnalysis.description).toContain(run.retrievalRequestsPath);

    const liveDocument = readFileSync(run.liveDocumentPath, 'utf-8');
    expect(liveDocument).toContain('# Live meeting brief: Calibration remains open pending the DES comparison.');
    expect(liveDocument).toContain('## Current narrative');
    expect(liveDocument).toContain('## Open questions');
    expect(liveDocument).toContain('## Decisions');
    expect(liveDocument).toContain('## Evidence in view');
    expect(liveDocument).toContain('## Retrieval queue');
    expect(liveDocument).toContain('## Assistant replies');
    expect(liveDocument).toContain('(fiber: [use-des-weights](<.felt/use-des-weights/use-des-weights.md>))');
    expect(liveDocument).toContain(`- live ASTRA: [astra.yaml](<${join(cityPath, 'astra.yaml')}>)`);
    expect(liveDocument).toContain(`- brief promotions: [brief-promotions.jsonl](<${run.briefPromotionsPath}>)`);
  });

  it('rejects promoting an empty live brief', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const fiberPromoter = {
      createFiber: vi.fn(async () => 'meeting-brief-fiber'),
    };

    const bridge = new MeetingBridge({
      baseDir,
      messenger,
      fiberPromoter,
      sourceFactory: {
        createVoiceInkSource: vi.fn(() => {
          throw new Error('voiceink should not start for manual meetings');
        }),
      },
    });

    bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-empty-brief',
        tmuxSession: 'worker-empty-brief',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    await expect(bridge.promoteLiveBrief()).rejects.toThrowError('Meeting live brief is empty');
    expect(fiberPromoter.createFiber).not.toHaveBeenCalled();
  });

  it('persists retrieval requests and injects them into the active worker thread', () => {
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
        sessionId: 'worker-retrieval',
        tmuxSession: 'worker-retrieval',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    const updated = bridge.ingestRetrievalRequest({
      text: 'Pull up the latest calibration plot and the fiber where we last discussed DES weighting.',
    });

    expect(updated.retrievalRequestCount).toBe(1);
    expect(updated.injectedCount).toBe(2);
    expect(updated.lastRetrievalRequestPreview).toContain('latest calibration plot');
    expect(updated.recentRetrievalRequests).toEqual([
      expect.objectContaining({
        requestIndex: 1,
        text: 'Pull up the latest calibration plot and the fiber where we last discussed DES weighting.',
      }),
    ]);
    expect(messenger.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-retrieval' }),
      expect.stringContaining('Portolan Meeting Retrieval Request'),
      { pressEnter: true },
    );

    const requestLog = JSON.parse(readFileSync(run.retrievalRequestsPath, 'utf-8').trim());
    expect(requestLog).toMatchObject({
      meetingId: run.meetingId,
      requestIndex: 1,
      text: 'Pull up the latest calibration plot and the fiber where we last discussed DES weighting.',
    });

    const injections = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(injections[1])).toMatchObject({
      kind: 'retrieval-request',
      requestIndex: 1,
    });
  });

  it('persists retrieved evidence and injects it into the active worker thread', () => {
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
        sessionId: 'worker-retrieval-evidence',
        tmuxSession: 'worker-retrieval-evidence',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestRetrievalRequest({
      text: 'Pull up the DES weighting fiber.',
    });

    const updated = bridge.ingestRetrievedEvidence({
      type: 'fiber',
      title: 'use-des-weights',
      fiberId: 'use-des-weights',
      match: 'Decision to use DES weights for the comparison run.',
      requestIndex: 1,
    });

    expect(updated.retrievalEvidenceCount).toBe(1);
    expect(updated.injectedCount).toBe(3);
    expect(updated.lastRetrievedEvidencePreview).toBe('use-des-weights');
    expect(updated.recentRetrievedEvidence).toEqual([
      expect.objectContaining({
        evidenceIndex: 1,
        type: 'fiber',
        title: 'use-des-weights',
        fiberId: 'use-des-weights',
        requestIndex: 1,
      }),
    ]);
    expect(updated.liveBrief.evidenceInView).toEqual([
      expect.objectContaining({
        evidenceIndex: 1,
        title: 'use-des-weights',
        fiberId: 'use-des-weights',
      }),
    ]);
    expect(messenger.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ tmuxSession: 'worker-retrieval-evidence' }),
      expect.stringContaining('Portolan Meeting Retrieved Evidence'),
      { pressEnter: true },
    );

    const evidenceLog = JSON.parse(readFileSync(run.retrievalEvidencePath, 'utf-8').trim());
    expect(evidenceLog).toMatchObject({
      meetingId: run.meetingId,
      evidenceIndex: 1,
      type: 'fiber',
      title: 'use-des-weights',
      fiberId: 'use-des-weights',
      requestIndex: 1,
    });

    const injections = readFileSync(run.injectionsPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(injections[2])).toMatchObject({
      kind: 'retrieved-evidence',
      evidenceIndex: 1,
    });
  });

  it('rejects candidate events without transcript or operator provenance', () => {
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

    bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-candidate-empty',
        tmuxSession: 'worker-candidate-empty',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    expect(() => bridge.ingestCandidateEvent({
      kind: 'note',
      text: 'Accepted note without cited provenance should fail.',
    })).toThrowError('Meeting candidate event requires transcript or operator provenance');
  });

  it('rejects candidate events that cite nonexistent provenance indices', () => {
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

    bridge.start({
      sourceType: 'manual',
      target: {
        sessionId: 'worker-candidate-bad-index',
        tmuxSession: 'worker-candidate-bad-index',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    bridge.ingestChunk({ id: 'chunk-1', text: 'Only one transcript chunk exists so far.' });

    expect(() => bridge.ingestCandidateEvent({
      kind: 'decision',
      text: 'This cites an impossible transcript chunk index.',
      transcriptChunkIndices: [2],
    })).toThrowError('Meeting candidate event cites invalid transcript chunk index: 2');
  });

  it('emits state updates as the meeting run changes', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
    const messenger = { send: vi.fn() };
    const states: Array<{ activeMeeting: string | null; lastMeeting: string | null; chunkCount: number; operatorUpdateCount: number; candidateEventCount: number; retrievalRequestCount: number }> = [];

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
        candidateEventCount: state.activeMeeting?.candidateEventCount ?? state.lastMeeting?.candidateEventCount ?? 0,
        retrievalRequestCount: state.activeMeeting?.retrievalRequestCount ?? state.lastMeeting?.retrievalRequestCount ?? 0,
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
    bridge.ingestCandidateEvent({
      kind: 'note',
      text: 'Accepted note: prior evidence chain needs to be surfaced next.',
      transcriptChunkIndices: [1],
      operatorUpdateIndices: [1],
    });
    bridge.ingestRetrievalRequest('Retrieve the prior evidence chain and DES calibration plot.');
    bridge.stop();

    expect(states).toEqual([
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 0, operatorUpdateCount: 0, candidateEventCount: 0, retrievalRequestCount: 0 },
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 1, operatorUpdateCount: 0, candidateEventCount: 0, retrievalRequestCount: 0 },
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 1, operatorUpdateCount: 1, candidateEventCount: 0, retrievalRequestCount: 0 },
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 1, operatorUpdateCount: 1, candidateEventCount: 1, retrievalRequestCount: 0 },
      { activeMeeting: 'running', lastMeeting: 'running', chunkCount: 1, operatorUpdateCount: 1, candidateEventCount: 1, retrievalRequestCount: 1 },
      { activeMeeting: null, lastMeeting: 'stopped', chunkCount: 1, operatorUpdateCount: 1, candidateEventCount: 1, retrievalRequestCount: 1 },
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
      liveDocumentPath: join(meetingDir, 'live-brief.md'),
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
      candidateEventCount: 0,
      retrievalRequestCount: 0,
      briefPromotionCount: 0,
      candidateEventsPath: join(meetingDir, 'candidate-events.jsonl'),
      updatesPath: join(meetingDir, 'operator-updates.jsonl'),
      retrievalRequestsPath: join(meetingDir, 'retrieval-requests.jsonl'),
      briefPromotionsPath: join(meetingDir, 'brief-promotions.jsonl'),
      liveDocumentPath: join(meetingDir, 'live-brief.md'),
      lastChunkPreview: 'Recovered chunk',
      recentTranscriptChunks: [],
      recentOperatorUpdates: [],
      recentCandidateEvents: [],
      recentRetrievalRequests: [],
      recentBriefPromotions: [],
      liveBrief: {
        acceptedNotes: [],
        actionItems: [],
        decisions: [],
        evidenceInView: [],
        openQuestions: [],
      },
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
      liveDocumentPath: '/tmp/live-brief.md',
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
      candidateEventCount: 0,
      retrievalRequestCount: 0,
      briefPromotionCount: 0,
      liveDocumentPath: '/tmp/live-brief.md',
      recentTranscriptChunks: [],
      recentOperatorUpdates: [],
      recentCandidateEvents: [],
      recentRetrievalRequests: [],
      recentBriefPromotions: [],
      liveBrief: {
        acceptedNotes: [],
        actionItems: [],
        decisions: [],
        evidenceInView: [],
        openQuestions: [],
      },
    });
    expect(recovered?.stoppedAt).toBeGreaterThanOrEqual(before);
    expect(recovered?.stoppedAt).toBeLessThanOrEqual(after);
  });

  it('keeps only a bounded recent live thread and persists it for recovery', () => {
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
        sessionId: 'worker-thread',
        tmuxSession: 'worker-thread',
        originId: 'local',
        cwd: '/project/portolan',
      },
    });

    for (let index = 1; index <= 7; index += 1) {
      bridge.ingestChunk({ id: `chunk-${index}`, text: `transcript ${index}` });
      bridge.ingestOperatorUpdate({ kind: 'correction', text: `update ${index}` });
      bridge.ingestCandidateEvent({ kind: 'note', text: `candidate ${index}`, transcriptChunkIndices: [index] });
      bridge.ingestRetrievalRequest(`retrieval ${index}`);
    }

    const active = bridge.getState().activeMeeting;
    expect(active?.recentTranscriptChunks.map((chunk) => chunk.chunkIndex)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(active?.recentOperatorUpdates.map((update) => update.updateIndex)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(active?.recentCandidateEvents.map((event) => event.eventIndex)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(active?.recentRetrievalRequests.map((request) => request.requestIndex)).toEqual([2, 3, 4, 5, 6, 7]);

    const recovered = new MeetingBridge({ baseDir, messenger: { send: vi.fn() } }).getState().lastMeeting;
    expect(recovered).toMatchObject({
      meetingId: run.meetingId,
      recentTranscriptChunks: [
        expect.objectContaining({ chunkIndex: 2 }),
        expect.objectContaining({ chunkIndex: 3 }),
        expect.objectContaining({ chunkIndex: 4 }),
        expect.objectContaining({ chunkIndex: 5 }),
        expect.objectContaining({ chunkIndex: 6 }),
        expect.objectContaining({ chunkIndex: 7 }),
      ],
      recentOperatorUpdates: [
        expect.objectContaining({ updateIndex: 2 }),
        expect.objectContaining({ updateIndex: 3 }),
        expect.objectContaining({ updateIndex: 4 }),
        expect.objectContaining({ updateIndex: 5 }),
        expect.objectContaining({ updateIndex: 6 }),
        expect.objectContaining({ updateIndex: 7 }),
      ],
      recentCandidateEvents: [
        expect.objectContaining({ eventIndex: 2 }),
        expect.objectContaining({ eventIndex: 3 }),
        expect.objectContaining({ eventIndex: 4 }),
        expect.objectContaining({ eventIndex: 5 }),
        expect.objectContaining({ eventIndex: 6 }),
        expect.objectContaining({ eventIndex: 7 }),
      ],
      recentRetrievalRequests: [
        expect.objectContaining({ requestIndex: 2 }),
        expect.objectContaining({ requestIndex: 3 }),
        expect.objectContaining({ requestIndex: 4 }),
        expect.objectContaining({ requestIndex: 5 }),
        expect.objectContaining({ requestIndex: 6 }),
        expect.objectContaining({ requestIndex: 7 }),
      ],
    });
  });

  describe('delivery to the worker', () => {
    it('never calls messenger.send for transcript chunks, even across a burst of revisions', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
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

      bridge.start({
        sourceType: 'manual',
        target: {
          sessionId: 'worker-delivery',
          tmuxSession: 'worker-delivery',
          originId: 'local',
          cwd: cityPath,
        },
      });

      for (let index = 1; index <= 5; index += 1) {
        bridge.ingestChunk({ id: `chunk-${index}`, status: 'partial', text: `chunk ${index} tentative` });
        bridge.ingestChunk({ id: `chunk-${index}`, status: 'complete', text: `chunk ${index} settled` });
      }

      // Only the bootstrap message should have been sent to the worker.
      expect(messenger.send).toHaveBeenCalledTimes(1);
      expect(messenger.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Portolan meeting assistant mode'),
        expect.objectContaining({ pressEnter: true }),
      );
      for (const call of messenger.send.mock.calls) {
        expect(call[1]).not.toContain('[Portolan Meeting Transcript Chunk]');
      }
    });

    it('bootstrap prompt points at the cwd-local symlink, not the global meeting path', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
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

      bridge.start({
        sourceType: 'manual',
        target: {
          sessionId: 'worker-bootstrap',
          tmuxSession: 'worker-bootstrap',
          originId: 'local',
          cwd: cityPath,
        },
      });

      expect(messenger.send).toHaveBeenCalledTimes(1);
      const bootstrap = messenger.send.mock.calls[0][1];
      expect(bootstrap).toContain('.portolan/current-meeting.md');
      expect(bootstrap).toContain('Read the file on demand');
    });

    it('removes the <cwd>/.portolan/current-meeting.md symlink when the meeting stops', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
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

      bridge.start({
        sourceType: 'manual',
        target: {
          sessionId: 'worker-teardown',
          tmuxSession: 'worker-teardown',
          originId: 'local',
          cwd: cityPath,
        },
      });

      const symlinkPath = join(cityPath, '.portolan', 'current-meeting.md');
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

      bridge.stop();

      expect(existsSync(symlinkPath)).toBe(false);
    });

    it('updates the cwd-local symlink target as partial chunks settle', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'meeting-bridge-'));
      const cityPath = mkdtempSync(join(tmpdir(), 'meeting-city-'));
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
          sessionId: 'worker-revision',
          tmuxSession: 'worker-revision',
          originId: 'local',
          cwd: cityPath,
        },
      });

      const symlinkPath = join(cityPath, '.portolan', 'current-meeting.md');
      expect(readlinkSync(symlinkPath)).toBe(run.transcriptMarkdownPath);

      bridge.ingestChunk({ id: 'c1', status: 'partial', text: 'we are still thinking' });
      expect(readFileSync(symlinkPath, 'utf-8')).toContain('we are still thinking …');

      bridge.ingestChunk({ id: 'c1', status: 'complete', text: 'we are still thinking about calibration' });
      const settled = readFileSync(symlinkPath, 'utf-8');
      expect(settled).toContain('we are still thinking about calibration');
      expect(settled).not.toContain(' …');
    });

    it('skips the worker-cwd symlink when the city path is not a local directory', () => {
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
          sessionId: 'worker-remote',
          tmuxSession: 'worker-remote',
          originId: 'local',
          cwd: '/nonexistent/remote/project',
        },
      });

      // No symlink was installed, and bootstrap falls back to the absolute path.
      expect(run.currentMeetingSymlinkPath).toBeUndefined();
      const bootstrap = messenger.send.mock.calls[0][1];
      expect(bootstrap).toContain(run.transcriptMarkdownPath);
      expect(bootstrap).not.toContain('.portolan/current-meeting.md');
    });
  });
});
