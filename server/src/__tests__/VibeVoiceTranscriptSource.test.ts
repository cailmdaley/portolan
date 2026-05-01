import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import { MeetingBridge } from '../MeetingBridge.js';
import { VibeVoiceTranscriptSource, buildDaemonArgs } from '../VibeVoiceTranscriptSource.js';

describe('buildVibeVoiceDaemonArgs', () => {
  it('emits audio mode by default and threads model / prompt / device settings', () => {
    const args = buildDaemonArgs({
      audioPath: '/tmp/meeting.wav',
      model: 'microsoft/VibeVoice-ASR-HF',
      prompt: 'CMB lensing',
      device: 'auto',
      maxNewTokens: 4096,
      acousticTokenizerChunkSize: 64000,
    });
    expect(args.slice(0, 2)).toEqual(['--audio', '/tmp/meeting.wav']);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('microsoft/VibeVoice-ASR-HF');
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toBe('CMB lensing');
    expect(args).toContain('--device');
    expect(args[args.indexOf('--device') + 1]).toBe('auto');
    expect(args).toContain('--max-new-tokens');
    expect(args[args.indexOf('--max-new-tokens') + 1]).toBe('4096');
    expect(args).toContain('--acoustic-tokenizer-chunk-size');
    expect(args[args.indexOf('--acoustic-tokenizer-chunk-size') + 1]).toBe('64000');
  });

  it('rejects audio mode without audioPath and script mode without scriptPath', () => {
    expect(() => buildDaemonArgs({ mode: 'audio' })).toThrow(/audio mode requires audioPath/);
    expect(() => buildDaemonArgs({ mode: 'script' })).toThrow(/script mode requires scriptPath/);
  });
});

const fixtureScriptPath = fileURLToPath(new URL('./fixtures/vibevoice-script.jsonl', import.meta.url));
const pythonPath = process.env.PORTOLAN_VIBEVOICE_PYTHON ?? 'python3';

function pythonRuns(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

const describeIfPython = pythonRuns(pythonPath) ? describe : describe.skip;

describeIfPython('VibeVoiceTranscriptSource (script-mode daemon)', () => {
  it('drives MeetingBridge end-to-end with speaker-labelled segments', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-vibevoice-'));
    const cityPath = mkdtempSync(join(tmpdir(), 'vibevoice-city-'));
    const messenger = { send: vi.fn() };
    const collected: unknown[] = [];

    const exitPromise = new Promise<void>((resolve) => {
      const bridge = new MeetingBridge({
        baseDir,
        messenger,
        sourceFactory: {
          createVibeVoiceSource: (_options, callbacks) => new VibeVoiceTranscriptSource(
            { mode: 'script', scriptPath: fixtureScriptPath, pythonPath },
            {
              onChunk: (chunk) => {
                collected.push(chunk);
                callbacks.onChunk(chunk);
              },
              onError: callbacks.onError,
              onExit: (code, signal) => {
                callbacks.onExit(code, signal);
                resolve();
              },
            },
          ),
        },
      });

      bridge.start({
        sourceType: 'vibevoice',
        target: {
          sessionId: 'vibevoice-worker',
          tmuxSession: 'vibevoice-worker',
          originId: 'local',
          cwd: cityPath,
        },
        vibevoice: { mode: 'script', scriptPath: fixtureScriptPath },
      });
    });

    await exitPromise;
    await new Promise((r) => setTimeout(r, 50));

    expect(collected).toHaveLength(2);
    const meetingDir = join(baseDir, readdirSync(baseDir)[0]);
    const md = readFileSync(join(meetingDir, 'transcript.md'), 'utf-8');
    expect(md).toContain('Speaker 0: we should revisit the beam transfer function.');
    expect(md).toContain('Speaker 1: and file the decision with the calibration plot.');
  }, 15_000);
});
