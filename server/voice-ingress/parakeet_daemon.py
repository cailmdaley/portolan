#!/usr/bin/env python3
"""Portolan voice ingress daemon.

Streams transcripts to stdout as JSONL chunks. Each chunk has the shape the
Portolan MeetingBridge expects from any transcript source:

    {"id": "u1", "text": "hello world", "status": "partial",
     "timestamp_local": "2026-04-18T12:34:56"}

Repeated emits for the same `id` form a revision chain — MeetingBridge maps the
first emit to a fresh chunkIndex and subsequent ones to revisions on that
chunkIndex. `status: partial` marks tentative text; `status: complete` settles it.

Three modes:

  --mic           live capture from default microphone (sounddevice + parakeet-mlx)
  --audio FILE    transcribe a WAV/MP3 file as if streamed (parakeet-mlx)
  --script FILE   replay a JSONL chunk script (no parakeet, used in CI tests)

Script mode is the CI fixture: it lets the Node side exercise the spawn /
stdout-parse / chunk-ingress pipeline end-to-end without depending on the
parakeet model weights or a microphone.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional


def _install_sigterm_handler() -> None:
    """Map SIGTERM to KeyboardInterrupt so finally blocks still run on `kill`."""

    def _raise_keyboard_interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)


def emit(chunk: dict) -> None:
    sys.stdout.write(json.dumps(chunk, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def now_local_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portolan voice ingress daemon")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--mic", action="store_true", help="capture from default microphone")
    mode.add_argument("--audio", type=Path, help="WAV/MP3 file to stream through parakeet-mlx")
    mode.add_argument("--script", type=Path, help="JSONL chunk script to replay (test fixture mode)")

    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3",
                        help="HuggingFace model id for parakeet-mlx (mic/audio modes)")
    parser.add_argument("--chunk-ms", type=int, default=500,
                        help="audio chunk size in milliseconds")
    parser.add_argument("--partial-interval-ms", type=int, default=250,
                        help="minimum interval between partial emissions")
    parser.add_argument("--silence-ms", type=int, default=1500,
                        help="silence threshold for mic-mode utterance boundaries")
    parser.add_argument("--silence-rms", type=float, default=0.005,
                        help="RMS threshold below which audio is considered silence")
    parser.add_argument("--id-prefix", default="u",
                        help="utterance id prefix (default: 'u')")
    parser.add_argument("--device", default=None,
                        help="sounddevice input device name or index (mic mode)")
    parser.add_argument("--sample-rate", type=int, default=16000,
                        help="audio sample rate in Hz (default: 16000)")
    parser.add_argument("--context-frames", type=int, default=256,
                        help="parakeet streaming context size (frames in/out)")
    parser.add_argument("--save-audio", type=Path, default=None,
                        help="(mic mode) archive captured PCM to this WAV path for post-hoc replay")
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# script mode — replay a JSONL chunk script (no ML deps)
# ---------------------------------------------------------------------------

def run_script_mode(path: Path) -> None:
    """Replay JSONL lines from PATH.

    Each line is `{"delay_ms": N, ...chunk fields}`. The daemon sleeps
    `delay_ms` then emits `{...chunk fields}` (without delay_ms) to stdout.
    Missing `timestamp_local` is filled with current time. Missing `status`
    defaults to 'partial'.
    """
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                delay_ms = float(entry.pop("delay_ms", 0))
                if delay_ms > 0:
                    time.sleep(delay_ms / 1000.0)
                entry.setdefault("status", "partial")
                entry.setdefault("timestamp_local", now_local_iso())
                emit(entry)
    except KeyboardInterrupt:
        # SIGINT/SIGTERM during replay is a graceful stop — exit 0 without a traceback.
        return


# ---------------------------------------------------------------------------
# audio + mic modes — real parakeet streaming
# ---------------------------------------------------------------------------

def _import_parakeet():
    try:
        import parakeet_mlx  # type: ignore
        import mlx.core as mx  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment dep
        sys.stderr.write(
            "parakeet_mlx and mlx are required for --audio/--mic modes. "
            "Install with: pip install parakeet-mlx\n"
        )
        raise SystemExit(2) from exc
    return parakeet_mlx, mx


def _iter_audio_chunks(audio, chunk_samples: int) -> Iterator:
    """Yield slices of `audio` of length `chunk_samples` (last chunk may be short)."""
    total = audio.shape[0]
    for start in range(0, total, chunk_samples):
        yield audio[start:start + chunk_samples]


def _open_wav_writer(path: Path, sample_rate: int) -> wave.Wave_write:
    """Open a mono 16-bit PCM WAV writer. Parent dirs are created if missing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = wave.open(str(path), "wb")
    writer.setnchannels(1)
    writer.setsampwidth(2)
    writer.setframerate(sample_rate)
    return writer


def _write_wav_samples(writer: wave.Wave_write, samples) -> None:
    """Append float32 samples in [-1, 1] to a 16-bit PCM WAV writer."""
    import numpy as np  # type: ignore

    arr = np.asarray(samples, dtype=np.float32)
    clipped = np.clip(arr, -1.0, 1.0)
    ints = (clipped * 32767.0).astype(np.int16)
    writer.writeframes(ints.tobytes())


def run_audio_mode(args: argparse.Namespace) -> None:
    parakeet_mlx, _ = _import_parakeet()
    from parakeet_mlx.audio import load_audio

    model = parakeet_mlx.from_pretrained(args.model)
    audio = load_audio(args.audio, sampling_rate=args.sample_rate)

    chunk_samples = max(1, int(args.sample_rate * args.chunk_ms / 1000))
    utterance_id = f"{args.id_prefix}1"
    last_text = ""
    last_emit_at = 0.0

    with model.transcribe_stream(
        context_size=(args.context_frames, args.context_frames)
    ) as streaming:
        try:
            for chunk in _iter_audio_chunks(audio, chunk_samples):
                streaming.add_audio(chunk)
                text = streaming.result.text
                now = time.monotonic()
                if text != last_text and (now - last_emit_at) * 1000 >= args.partial_interval_ms:
                    emit({
                        "id": utterance_id,
                        "text": text,
                        "status": "partial",
                        "timestamp_local": now_local_iso(),
                    })
                    last_text = text
                    last_emit_at = now
        except KeyboardInterrupt:
            # SIGINT/SIGTERM mid-file — still emit what we have so far as settled.
            pass

        # finalize: emit one settled chunk for whatever was transcribed
        final_text = streaming.result.text
        if final_text:
            emit({
                "id": utterance_id,
                "text": final_text,
                "status": "complete",
                "timestamp_local": now_local_iso(),
            })


def run_mic_mode(args: argparse.Namespace) -> None:
    parakeet_mlx, mx = _import_parakeet()
    try:
        import sounddevice as sd  # type: ignore
        import numpy as np  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment dep
        sys.stderr.write("sounddevice and numpy are required for --mic mode\n")
        raise SystemExit(2) from exc

    model = parakeet_mlx.from_pretrained(args.model)
    chunk_samples = max(1, int(args.sample_rate * args.chunk_ms / 1000))
    silence_chunks_threshold = max(1, int(args.silence_ms / args.chunk_ms))

    utterance_index = 1
    utterance_id = f"{args.id_prefix}{utterance_index}"
    last_text = ""
    last_emit_at = 0.0
    silent_chunks = 0
    in_speech = False

    def make_streaming():
        return model.transcribe_stream(
            context_size=(args.context_frames, args.context_frames),
        )

    streaming_cm = make_streaming()
    streaming = streaming_cm.__enter__()

    wav_writer: Optional[wave.Wave_write] = None
    if args.save_audio is not None:
        wav_writer = _open_wav_writer(args.save_audio, args.sample_rate)

    try:
        with sd.InputStream(
            samplerate=args.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=chunk_samples,
            device=args.device,
        ) as stream:
            while True:
                buf, _ = stream.read(chunk_samples)
                samples = buf[:, 0] if buf.ndim == 2 else buf
                if wav_writer is not None:
                    _write_wav_samples(wav_writer, samples)
                rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
                streaming.add_audio(mx.array(samples))

                text = streaming.result.text
                now = time.monotonic()
                if text != last_text and (now - last_emit_at) * 1000 >= args.partial_interval_ms:
                    emit({
                        "id": utterance_id,
                        "text": text,
                        "status": "partial",
                        "timestamp_local": now_local_iso(),
                        "rms": rms,
                    })
                    last_text = text
                    last_emit_at = now

                if rms < args.silence_rms:
                    silent_chunks += 1
                else:
                    silent_chunks = 0
                    in_speech = True

                if in_speech and silent_chunks >= silence_chunks_threshold and text:
                    # utterance boundary — settle and start a new streaming session
                    emit({
                        "id": utterance_id,
                        "text": text,
                        "status": "complete",
                        "timestamp_local": now_local_iso(),
                    })
                    streaming_cm.__exit__(None, None, None)
                    utterance_index += 1
                    utterance_id = f"{args.id_prefix}{utterance_index}"
                    last_text = ""
                    last_emit_at = 0.0
                    silent_chunks = 0
                    in_speech = False
                    streaming_cm = make_streaming()
                    streaming = streaming_cm.__enter__()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            text = streaming.result.text
            if text:
                emit({
                    "id": utterance_id,
                    "text": text,
                    "status": "complete",
                    "timestamp_local": now_local_iso(),
                })
        except Exception:  # pragma: no cover
            pass
        try:
            streaming_cm.__exit__(None, None, None)
        except Exception:  # pragma: no cover
            pass
        if wav_writer is not None:
            try:
                wav_writer.close()
            except Exception:  # pragma: no cover
                pass


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    _install_sigterm_handler()
    if args.script:
        run_script_mode(args.script)
    elif args.audio:
        run_audio_mode(args)
    elif args.mic:
        run_mic_mode(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
