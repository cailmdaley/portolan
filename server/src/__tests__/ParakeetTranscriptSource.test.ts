import { accessSync, constants, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import { MeetingBridge } from '../MeetingBridge.js';
import { ParakeetTranscriptSource } from '../ParakeetTranscriptSource.js';

const fixtureScriptPath = fileURLToPath(new URL('./fixtures/parakeet-script.jsonl', import.meta.url));
const fixtureLongScriptPath = fileURLToPath(new URL('./fixtures/parakeet-script-long.jsonl', import.meta.url));
const pythonPath = process.env.PORTOLAN_PARAKEET_PYTHON ?? '/opt/homebrew/bin/python3.13';

function pythonExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const describeIfPython = pythonExists(pythonPath) ? describe : describe.skip;

describeIfPython('ParakeetTranscriptSource (script-mode daemon)', () => {
  it('drives MeetingBridge end-to-end with partial → complete revisions', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'meeting-parakeet-'));
    const cityPath = mkdtempSync(join(tmpdir(), 'parakeet-city-'));
    const messenger = { send: vi.fn() };

    const collected: unknown[] = [];
    const exitPromise = new Promise<void>((resolve) => {
      const bridge = new MeetingBridge({
        baseDir,
        messenger,
        sourceFactory: {
          createParakeetSource: (_options, callbacks) => new ParakeetTranscriptSource(
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
        sourceType: 'parakeet',
        target: {
          sessionId: 'parakeet-worker',
          tmuxSession: 'parakeet-worker',
          originId: 'local',
          cwd: cityPath,
        },
      });
    });

    await exitPromise;
    // brief grace window for the bridge to finalize state after the source exits
    await new Promise((r) => setTimeout(r, 50));

    expect(collected.length).toBe(5);

    const meetingDirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(meetingDirs).toHaveLength(1);
    const meetingDir = join(baseDir, meetingDirs[0]);
    const transcriptLines = readFileSync(join(meetingDir, 'transcript.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(transcriptLines).toHaveLength(5);

    const u1Lines = transcriptLines.filter((line) => line.sourceChunkId === 'u1');
    const u2Lines = transcriptLines.filter((line) => line.sourceChunkId === 'u2');
    expect(u1Lines).toHaveLength(4);
    expect(u2Lines).toHaveLength(1);

    expect(u1Lines.every((line) => line.chunkIndex === 1)).toBe(true);
    expect(u1Lines.map((line) => line.revisionIndex)).toEqual([1, 2, 3, 4]);
    expect(u1Lines[0]).toMatchObject({ isPartial: true, isRevision: false });
    expect(u1Lines[1]).toMatchObject({ isPartial: true, isRevision: true });
    expect(u1Lines[2]).toMatchObject({ isPartial: true, isRevision: true });
    expect(u1Lines[3]).toMatchObject({ isPartial: false, isRevision: true });
    expect(u1Lines[3].text).toBe('we should check the calibration plot.');

    expect(u2Lines[0]).toMatchObject({
      chunkIndex: 2,
      revisionIndex: 1,
      isPartial: false,
      isRevision: false,
      text: 'next utterance.',
    });
  }, 15_000);

  it('exits cleanly when stopped mid-stream (SIGTERM handled)', async () => {
    const chunks: Array<{ text: string; status: string }> = [];
    const errors: Error[] = [];
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        const source = new ParakeetTranscriptSource(
          { mode: 'script', scriptPath: fixtureLongScriptPath, pythonPath },
          {
            onChunk: (chunk) => chunks.push(chunk as { text: string; status: string }),
            onError: (error) => errors.push(error),
            onExit: (code, signal) => resolve({ code, signal }),
          },
        );
        source.start();
        // Let the two quick emits flow, then stop before the 5s-delayed third.
        setTimeout(() => source.stop(), 200);
      },
    );

    const exit = await exitPromise;
    expect(chunks.map((c) => c.text)).toEqual(['hello', 'hello there']);
    expect(errors).toEqual([]);
    // SIGTERM → KeyboardInterrupt → clean return. Python exits 0, no signal.
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  }, 10_000);
});
