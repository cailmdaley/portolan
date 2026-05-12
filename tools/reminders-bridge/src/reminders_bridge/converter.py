from __future__ import annotations

import re
import textwrap
from pathlib import Path
from urllib.parse import quote

from .model import FID_MARKER_PREFIX, FID_MARKER_SUFFIX, FiberRecord, ReminderSpec


DEFAULT_SKIP_PATH_TAGS = frozenset({"ai-futures", "loom"})
MAX_LEDE_CHARS = 500


def fiber_to_reminder_spec(fiber: FiberRecord) -> ReminderSpec:
    tags = canonical_tags(fiber)
    notes = build_notes(fiber, tags)
    return ReminderSpec(
        fiber_id=fiber.id,
        title=fiber.name or fiber.id,
        notes=notes,
        tags=tags,
        due=fiber.due,
        url=fiber.file_url or f"portolan://fiber/{quote(fiber.id, safe='/')}",
        priority=0,
        attachments=fiber.evidence_attachments[:1],
    )


def canonical_tags(fiber: FiberRecord) -> tuple[str, ...]:
    tags: list[str] = ["fiber", f"fid-{_tagify(fiber.id)}"]
    tags.extend(_tagify(tag) for tag in fiber.tags if tag)
    if fiber.horizon in {"now", "soon", "later", "someday"}:
        tags.append(f"h-{fiber.horizon}")
    tags.extend(f"path-{token}" for token in path_tokens(fiber.id))
    return tuple(dict.fromkeys(tag for tag in tags if tag))


def path_tokens(fiber_id: str, skip: frozenset[str] = DEFAULT_SKIP_PATH_TAGS) -> tuple[str, ...]:
    parts = [part for part in fiber_id.split("/")[:-1] if part and part not in skip]
    return tuple(_tagify(part) for part in parts)


def build_notes(fiber: FiberRecord, tags: tuple[str, ...]) -> str:
    chunks: list[str] = []
    outcome = _single_line(fiber.outcome)
    if outcome:
        chunks.append(f"-> {outcome}")

    lede = first_body_paragraph(fiber.body)
    if lede:
        chunks.append(truncate(lede, MAX_LEDE_CHARS))

    tag_line = " ".join(f"#{tag}" for tag in tags)
    if tag_line:
        chunks.append(tag_line)

    if fiber.file_url:
        chunks.append(fiber.file_url)

    chunks.append(fid_marker(fiber.id))
    return "\n\n".join(chunks)


def first_body_paragraph(body: str) -> str:
    paragraphs: list[str] = []
    current: list[str] = []
    in_fence = False
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if line.startswith("```") or line.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence or not line:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            continue
        if line.startswith("#"):
            continue
        current.append(line)
    if current:
        paragraphs.append(" ".join(current))
    return _single_line(paragraphs[0]) if paragraphs else ""


def fid_marker(fiber_id: str) -> str:
    return f"{FID_MARKER_PREFIX} {fiber_id} {FID_MARKER_SUFFIX}"


def extract_fid(notes: str | None) -> str | None:
    if not notes:
        return None
    match = re.search(r"<!--\s*fid:\s*([^>]+?)\s*-->", notes)
    return match.group(1).strip() if match else None


def truncate(text: str, limit: int) -> str:
    normalized = _single_line(text)
    if len(normalized) <= limit:
        return normalized
    return textwrap.shorten(normalized, width=limit, placeholder="...")


def _single_line(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _tagify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"^\[(.*)\]$", r"\1", value)
    value = value.replace("_", "-")
    value = re.sub(r"[^a-z0-9-]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value
