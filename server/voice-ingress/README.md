# Portolan voice ingress daemon

Streams transcript chunks to stdout as JSONL. Designed to be spawned by
`server/src/ParakeetTranscriptSource.ts`, which feeds the chunks into
`MeetingBridge` over the same `id`/`text`/`status` contract that VoiceInk uses
(see `server/src/MeetingBridge.ts:normalizeChunk`).

## Modes

```
parakeet_daemon.py --mic              # live capture (sounddevice + parakeet-mlx)
parakeet_daemon.py --audio FILE.wav   # transcribe a file as if streamed (parakeet-mlx)
parakeet_daemon.py --script FILE.jsonl  # replay a scripted chunk sequence (no ML)
```

Script mode replays a JSONL file where each line is `{"delay_ms": N, ...chunk
fields}`. It exists so the Node side can be exercised end-to-end in CI without
the parakeet weights or a microphone (see
`server/src/__tests__/ParakeetTranscriptSource.test.ts`).

## Output shape

One JSON object per line on stdout:

```json
{"id": "u1", "text": "we should check the calibration", "status": "partial",
 "timestamp_local": "2026-04-18T12:34:56"}
```

Repeated emits with the same `id` form a revision chain: MeetingBridge maps the
first one to a fresh `chunkIndex` and subsequent ones to revisions on that
chunk. `status: partial` marks tentative text; `status: complete` settles it.
Mic mode rolls the `id` forward (`u1`, `u2`, …) on detected utterance
boundaries; audio mode emits a single utterance for the whole file.

## Smoke test

Script mode (no model needed):

```
/opt/homebrew/bin/python3.13 server/voice-ingress/parakeet_daemon.py \
  --script server/src/__tests__/fixtures/parakeet-script.jsonl
```

Real audio (downloads ~600MB the first time):

```
/opt/homebrew/bin/python3.13 server/voice-ingress/parakeet_daemon.py \
  --audio path/to/clip.wav --model mlx-community/parakeet-tdt-0.6b-v3
```

Live mic (will prompt for microphone permission on first run):

```
/opt/homebrew/bin/python3.13 server/voice-ingress/parakeet_daemon.py --mic
```

## Dependencies

Already installed on the user's machine via Homebrew Python 3.13:

- `parakeet-mlx` (Apache 2.0)
- `mlx`
- `sounddevice` (mic mode only)
- `numpy`, `scipy`

`PORTOLAN_PARAKEET_PYTHON` overrides the Python interpreter the
`ParakeetTranscriptSource` Node wrapper uses to launch the daemon.
