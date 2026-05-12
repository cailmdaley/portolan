from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .model import FiberRecord


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"}


class FeltClient:
    def __init__(self, felt_store: Path, felt_bin: str = "felt"):
        self.felt_store = felt_store
        self.felt_bin = felt_bin

    def list_open_fibers(self, *, include_body: bool = True, limit: int | None = None) -> list[FiberRecord]:
        by_id: dict[str, FiberRecord] = {}
        for status in ("open", "active"):
            for raw in self._ls(status):
                if not raw.get("id") or raw["id"] in by_id:
                    continue
                body = self.body(raw["id"]) if include_body else ""
                by_id[raw["id"]] = self._record(raw, body)
                if limit is not None and len(by_id) >= limit:
                    return list(by_id.values())
        return list(by_id.values())

    def _ls(self, status: str) -> list[dict]:
        proc = subprocess.run(
            [self.felt_bin, "-C", str(self.felt_store), "ls", "--json", "-s", status],
            check=True,
            text=True,
            capture_output=True,
        )
        return json.loads(proc.stdout or "[]")

    def body(self, fiber_id: str) -> str:
        proc = subprocess.run(
            [self.felt_bin, "-C", str(self.felt_store), "show", fiber_id, "--body"],
            check=False,
            text=True,
            capture_output=True,
        )
        if proc.returncode != 0:
            return ""
        lines = proc.stdout.splitlines()
        if lines and lines[0].startswith("Body start line:"):
            lines = lines[2:] if len(lines) > 1 and lines[1] == "" else lines[1:]
        return "\n".join(lines).strip()

    def _record(self, raw: dict, body: str) -> FiberRecord:
        fiber_id = raw["id"]
        return FiberRecord(
            id=fiber_id,
            name=raw.get("name") or fiber_id,
            status=raw.get("status") or "",
            tags=tuple(raw.get("tags") or ()),
            outcome=raw.get("outcome") or "",
            due=raw.get("due"),
            horizon=raw.get("horizon"),
            body=body,
            file_url=self._file_url(fiber_id),
            evidence_attachments=self._evidence_attachments(fiber_id),
        )

    def _fiber_dir(self, fiber_id: str) -> Path:
        return self.felt_store / ".felt" / fiber_id

    def _file_url(self, fiber_id: str) -> str:
        leaf = fiber_id.rstrip("/").split("/")[-1]
        path = self._fiber_dir(fiber_id) / f"{leaf}.md"
        if path.exists():
            return path.resolve().as_uri()
        return f"portolan://fiber/{fiber_id}"

    def _evidence_attachments(self, fiber_id: str) -> tuple[Path, ...]:
        evidence_dir = self._fiber_dir(fiber_id) / "evidence"
        if not evidence_dir.exists():
            return ()
        return tuple(
            sorted(path for path in evidence_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)
        )[:1]
