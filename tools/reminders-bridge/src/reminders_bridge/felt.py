from __future__ import annotations

from contextlib import contextmanager
import json
import os
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

from .model import FiberRecord


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"}


class FeltCommandError(RuntimeError):
    pass


class FeltClient:
    def __init__(self, felt_store: Path, felt_bin: str = "felt", exclude_roots: tuple[str, ...] = ()):
        self.felt_store = felt_store
        self.felt_bin = felt_bin
        self.exclude_roots = tuple(root.strip("/") for root in exclude_roots if root.strip("/"))

    def list_open_fibers(self, *, include_body: bool = True, limit: int | None = None) -> list[FiberRecord]:
        by_id: dict[str, FiberRecord] = {}
        with self._command_store() as command_store:
            for status in ("open", "active"):
                for raw in self._ls(command_store, status):
                    if not raw.get("id") or raw["id"] in by_id:
                        continue
                    body = self.body(raw["id"], command_store=command_store) if include_body else ""
                    by_id[raw["id"]] = self._record(raw, body)
                    if limit is not None and len(by_id) >= limit:
                        return list(by_id.values())
        return list(by_id.values())

    def _ls(self, command_store: Path, status: str) -> list[dict]:
        proc = subprocess.run(
            [self.felt_bin, "-C", str(command_store), "ls", "--json", "-s", status],
            check=False,
            text=True,
            capture_output=True,
        )
        if proc.returncode != 0:
            raise FeltCommandError(
                f"felt ls -s {status} failed with exit {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
        return json.loads(proc.stdout or "[]")

    def body(self, fiber_id: str, *, command_store: Path | None = None) -> str:
        command_store = command_store or self.felt_store
        proc = subprocess.run(
            [self.felt_bin, "-C", str(command_store), "show", fiber_id, "--body"],
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

    @contextmanager
    def _command_store(self) -> Iterator[Path]:
        if not self.exclude_roots:
            yield self.felt_store
            return

        source_felt = self.felt_store / ".felt"
        with tempfile.TemporaryDirectory(prefix="reminders-bridge-felt-") as tmp:
            root = Path(tmp)
            target_felt = root / ".felt"
            target_felt.mkdir()
            for child in source_felt.iterdir():
                if child.name in self.exclude_roots:
                    continue
                os.symlink(child, target_felt / child.name)
            yield root
