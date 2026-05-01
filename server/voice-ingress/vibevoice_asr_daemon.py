#!/usr/bin/env python3
"""Portolan VibeVoice-ASR ingress daemon.

The daemon emits the same JSONL chunk contract as parakeet_daemon.py:

    {"id": "v1", "text": "hello world", "status": "complete",
     "speaker": "Speaker 0", "timestamp_local": "2026-05-01T12:34:56"}

VibeVoice-ASR is currently wired as a file/batch recognizer. The official
Transformers model supports long-form audio with speaker and timestamp output,
but it is not a low-latency microphone streaming API. Use Parakeet for live mic
streaming and this provider for post-hoc or file-backed meeting transcription.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


def _install_sigterm_handler() -> None:
    """Map SIGTERM to KeyboardInterrupt so script replay exits cleanly."""

    def _raise_keyboard_interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)


def emit(chunk: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(chunk, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def now_local_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Portolan VibeVoice-ASR ingress daemon")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--audio", type=Path, help="audio file to transcribe with VibeVoice-ASR")
    mode.add_argument("--script", type=Path, help="JSONL chunk script to replay (test fixture mode)")

    parser.add_argument("--model", default="microsoft/VibeVoice-ASR-HF",
                        help="HuggingFace model id or local path")
    parser.add_argument("--prompt", default=None,
                        help="optional VibeVoice context / hotword prompt")
    parser.add_argument("--device", default="auto",
                        choices=["auto", "cuda", "cpu", "mps", "xpu"],
                        help="device to run inference on")
    parser.add_argument("--dtype", default="auto",
                        choices=["auto", "bfloat16", "float16", "float32"],
                        help="torch dtype for model weights")
    parser.add_argument("--max-new-tokens", type=int, default=None,
                        help="optional generation max_new_tokens override")
    parser.add_argument("--acoustic-tokenizer-chunk-size", "--tokenizer-chunk-size",
                        dest="acoustic_tokenizer_chunk_size", type=int, default=None,
                        help="optional VibeVoice tokenizer chunk size override")
    parser.add_argument("--id-prefix", default="v",
                        help="utterance id prefix (default: 'v')")
    return parser.parse_args(argv)


def run_script_mode(path: Path) -> None:
    """Replay JSONL lines from PATH.

    Each line is {"delay_ms": N, ...chunk fields}. Missing `timestamp_local`
    is filled with current time and missing `status` defaults to complete.
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
                entry.setdefault("status", "complete")
                entry.setdefault("timestamp_local", now_local_iso())
                emit(entry)
    except KeyboardInterrupt:
        return


def _import_vibevoice_transformers():
    try:
        import torch  # type: ignore
        from transformers import AutoProcessor, VibeVoiceAsrForConditionalGeneration  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment dep
        sys.stderr.write(
            "VibeVoice-ASR requires torch and transformers>=5.3.0. "
            "Install in the selected Python environment with: "
            "pip install 'transformers>=5.3.0' torch\n"
        )
        raise SystemExit(2) from exc
    return torch, AutoProcessor, VibeVoiceAsrForConditionalGeneration


def _resolve_dtype(torch, requested: str, device: str):
    if requested == "float32":
        return torch.float32
    if requested == "float16":
        return torch.float16
    if requested == "bfloat16":
        return torch.bfloat16
    if device == "cuda" or (device == "auto" and torch.cuda.is_available()):
        return torch.bfloat16
    return torch.float32


def _resolve_device(torch, requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    if hasattr(torch.backends, "xpu") and torch.backends.xpu.is_available():
        return "xpu"
    return "cpu"


def _as_float(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _segment_value(segment: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in segment:
            return segment[key]
    return None


def _chunk_from_segment(segment: dict[str, Any], index: int, id_prefix: str) -> dict[str, Any]:
    text = _segment_value(segment, "Content", "content", "text") or ""
    start = _as_float(_segment_value(segment, "Start", "start", "start_time"))
    end = _as_float(_segment_value(segment, "End", "end", "end_time"))
    speaker = _segment_value(segment, "Speaker", "speaker", "speaker_id")
    speaker_label = f"Speaker {speaker}" if speaker is not None else None
    chunk = {
        "id": f"{id_prefix}{index}",
        "text": str(text),
        "status": "complete",
        "timestamp_local": now_local_iso(),
        "raw": segment,
    }
    if speaker_label:
        chunk["speaker"] = speaker_label
    if start is not None:
        chunk["start_seconds"] = start
    if end is not None:
        chunk["end_seconds"] = end
    if start is not None and end is not None and end >= start:
        chunk["duration_s"] = end - start
    return chunk


def _emit_fallback(raw_text: Any, id_prefix: str) -> None:
    text = raw_text if isinstance(raw_text, str) else json.dumps(raw_text, ensure_ascii=False)
    emit({
        "id": f"{id_prefix}1",
        "text": text,
        "status": "complete",
        "timestamp_local": now_local_iso(),
    })


def run_audio_mode(args: argparse.Namespace) -> None:
    torch, AutoProcessor, VibeVoiceAsrForConditionalGeneration = _import_vibevoice_transformers()
    device = _resolve_device(torch, args.device)
    dtype = _resolve_dtype(torch, args.dtype, device)

    sys.stderr.write(f"Loading VibeVoice-ASR model from {args.model} on {device}\n")
    processor = AutoProcessor.from_pretrained(args.model)
    model_kwargs: dict[str, Any] = {"torch_dtype": dtype}
    if args.device == "auto":
        model_kwargs["device_map"] = "auto"
    model = VibeVoiceAsrForConditionalGeneration.from_pretrained(args.model, **model_kwargs)
    if args.device != "auto":
        model = model.to(device)
    model.eval()

    request_kwargs: dict[str, Any] = {"audio": str(args.audio)}
    if args.prompt is not None:
        request_kwargs["prompt"] = args.prompt
    inputs = processor.apply_transcription_request(**request_kwargs)
    try:
        inputs = inputs.to(model.device, model.dtype)
    except TypeError:
        inputs = inputs.to(model.device)

    generate_kwargs: dict[str, Any] = {}
    if args.max_new_tokens is not None:
        generate_kwargs["max_new_tokens"] = args.max_new_tokens
    if args.acoustic_tokenizer_chunk_size is not None:
        generate_kwargs["acoustic_tokenizer_chunk_size"] = args.acoustic_tokenizer_chunk_size

    with torch.no_grad():
        output_ids = model.generate(**inputs, **generate_kwargs)
    generated_ids = output_ids[:, inputs["input_ids"].shape[1]:]

    try:
        parsed = processor.decode(generated_ids, return_format="parsed")[0]
    except Exception as exc:  # pragma: no cover - model/output dependent
        sys.stderr.write(f"Failed to parse VibeVoice structured output: {exc}\n")
        parsed = None

    if isinstance(parsed, list) and parsed:
        emitted = 0
        for index, segment in enumerate(parsed, start=1):
            if isinstance(segment, dict):
                emit(_chunk_from_segment(segment, index, args.id_prefix))
                emitted += 1
        if emitted > 0:
            return

    try:
        transcription_only = processor.decode(generated_ids, return_format="transcription_only")[0]
    except Exception:  # pragma: no cover - model/output dependent
        transcription_only = processor.decode(generated_ids)[0]
    _emit_fallback(transcription_only, args.id_prefix)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    _install_sigterm_handler()
    if args.script:
        run_script_mode(args.script)
    elif args.audio:
        run_audio_mode(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
