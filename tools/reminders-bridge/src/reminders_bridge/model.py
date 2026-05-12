from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


FID_MARKER_PREFIX = "<!-- fid:"
FID_MARKER_SUFFIX = "-->"


@dataclass(frozen=True)
class FiberRecord:
    id: str
    name: str
    status: str
    tags: tuple[str, ...] = ()
    outcome: str = ""
    due: str | None = None
    horizon: str | None = None
    body: str = ""
    file_url: str | None = None
    evidence_attachments: tuple[Path, ...] = ()


@dataclass(frozen=True)
class ReminderSpec:
    fiber_id: str
    title: str
    notes: str
    tags: tuple[str, ...]
    due: str | None = None
    url: str | None = None
    priority: int = 0
    attachments: tuple[Path, ...] = ()


@dataclass
class ReminderRecord:
    fiber_id: str | None
    title: str
    notes: str
    due: str | None = None
    url: str | None = None
    priority: int = 0
    completed: bool = False
    raw: object | None = None


@dataclass(frozen=True)
class ReconcilePlan:
    create: tuple[ReminderSpec, ...] = ()
    update: tuple[tuple[ReminderRecord, ReminderSpec], ...] = ()
    complete: tuple[ReminderRecord, ...] = ()
    unchanged: tuple[ReminderRecord, ...] = ()
    orphan_complete: tuple[ReminderRecord, ...] = ()
    warnings: tuple[str, ...] = ()

    def summary(self) -> str:
        return (
            f"created={len(self.create)} updated={len(self.update)} "
            f"completed={len(self.complete) + len(self.orphan_complete)} "
            f"unchanged={len(self.unchanged)} warnings={len(self.warnings)}"
        )


@dataclass
class ApplyResult:
    created: int = 0
    updated: int = 0
    completed: int = 0
    unchanged: int = 0
    warnings: list[str] = field(default_factory=list)
