"""Pydantic request/response schemas."""

from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
)

Status = Literal["inbox", "todo", "doing", "done", "archived"]
Priority = Annotated[int, Field(ge=1, le=4)]
Score = Annotated[int, Field(ge=1, le=5)]


# --------------------------------------------------------------------------
# Timezone handling
#
# SQLite has no timezone-aware column type: SQLAlchemy writes the wall time and
# silently drops the offset, then hands back a naive datetime on read. Left
# alone that corrupts data twice over. On the way in, an aware
# "2026-08-27T17:00+05:30" would be stored as 17:00 and later read as 17:00 UTC
# — off by five and a half hours. On the way out, a naive ISO string with no
# "Z" is parsed by JavaScript's Date as *local* time, so every timestamp in the
# UI shifts by the browser's offset.
#
# Both halves are fixed here rather than in each route, so there is one place to
# reason about it. Validation normalises to aware UTC before the value can reach
# the database, which means the wall time SQLite stores really is UTC.
# Serialisation stamps UTC back on, so the JSON always carries an explicit
# offset and the client never has to guess.
# --------------------------------------------------------------------------
def _to_utc(value: datetime) -> datetime:
    """Normalise to aware UTC. Naive input is assumed to already be UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _utc_iso(value: datetime | None) -> str | None:
    return None if value is None else _to_utc(value).isoformat()


UtcDatetime = Annotated[
    datetime,
    PlainSerializer(_utc_iso, return_type=str, when_used="json"),
]

# For fields that arrive from a client and get written to the database: convert
# to UTC during validation as well, so the naive value SQLite ends up storing is
# unambiguous.
UtcDatetimeIn = Annotated[
    datetime,
    AfterValidator(_to_utc),
    PlainSerializer(_utc_iso, return_type=str, when_used="json"),
]


# --------------------------------------------------------------------------
# Subtasks
# --------------------------------------------------------------------------
class SubtaskBase(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    done: bool = False
    position: int = 0


class SubtaskCreate(SubtaskBase):
    pass


class SubtaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    done: bool | None = None
    position: int | None = None


class SubtaskOut(SubtaskBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_id: int
    created_at: UtcDatetime


# --------------------------------------------------------------------------
# Tasks
# --------------------------------------------------------------------------
class TaskBase(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    notes: str | None = None
    status: Status = "inbox"
    priority: Priority = 3
    effort_minutes: int | None = Field(default=None, ge=1, le=100_000)
    due_date: UtcDatetimeIn | None = None
    tags: list[str] = Field(default_factory=list)

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, v: list[str]) -> list[str]:
        """Lowercase, strip, de-dupe, cap at 10 — keeps the UI from overflowing."""
        seen, out = set(), []
        for tag in v:
            t = tag.strip().lower().lstrip("#")
            if t and t not in seen:
                seen.add(t)
                out.append(t)
        return out[:10]


class TaskCreate(TaskBase):
    subtasks: list[SubtaskCreate] = Field(default_factory=list)


class TaskUpdate(BaseModel):
    """Every field optional — this is a PATCH body."""

    title: str | None = Field(default=None, min_length=1, max_length=500)
    notes: str | None = None
    status: Status | None = None
    priority: Priority | None = None
    effort_minutes: int | None = Field(default=None, ge=1, le=100_000)
    due_date: UtcDatetimeIn | None = None
    tags: list[str] | None = None
    order_index: int | None = None


class TaskOut(TaskBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    order_index: int
    ai_urgency: int | None = None
    ai_importance: int | None = None
    ai_reasoning: str | None = None
    ai_scored_at: UtcDatetime | None = None
    created_at: UtcDatetime
    updated_at: UtcDatetime
    completed_at: UtcDatetime | None = None
    subtasks: list[SubtaskOut] = Field(default_factory=list)


class TaskStats(BaseModel):
    total: int
    inbox: int
    todo: int
    doing: int
    done: int
    overdue: int
    unscored: int
    minutes_open: int


# --------------------------------------------------------------------------
# AI: natural-language capture
# --------------------------------------------------------------------------
class CaptureRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    # False lets the UI show a confirm step before anything is written.
    autosave: bool = True


class CaptureRequestPreview(BaseModel):
    """The confirm step posts the edited drafts back for saving."""

    tasks: list[TaskCreate]


class CapturedTask(TaskBase):
    reason: str | None = None


class CaptureResponse(BaseModel):
    tasks: list[CapturedTask]
    saved: list[TaskOut] = Field(default_factory=list)
    model: str
    note: str | None = None


# --------------------------------------------------------------------------
# AI: prioritisation
# --------------------------------------------------------------------------
class ScoreRequest(BaseModel):
    task_ids: list[int] | None = None
    """None means: score every open task that has not been scored yet."""
    context: str | None = Field(default=None, max_length=2000)
    """Optional free text, e.g. "shipping Friday, ignore marketing work"."""


class ScoredTask(BaseModel):
    id: int
    title: str
    priority: Priority
    urgency: Score
    importance: Score
    effort_minutes: int
    reasoning: str


class ScoreResponse(BaseModel):
    scored: list[ScoredTask]
    model: str
    note: str | None = None


# --------------------------------------------------------------------------
# AI: subtask breakdown
# --------------------------------------------------------------------------
class BreakdownRequest(BaseModel):
    task_id: int
    max_steps: int = Field(default=6, ge=2, le=12)
    guidance: str | None = Field(default=None, max_length=1000)
    autosave: bool = True


class BreakdownResponse(BaseModel):
    task_id: int
    steps: list[str]
    approach: str | None = None
    saved: list[SubtaskOut] = Field(default_factory=list)
    model: str
    note: str | None = None


# --------------------------------------------------------------------------
# AI: daily plan
# --------------------------------------------------------------------------
class PlanRequest(BaseModel):
    available_minutes: int = Field(default=240, ge=15, le=1440)
    context: str | None = Field(default=None, max_length=2000)
    energy: Literal["low", "medium", "high"] = "medium"


class PlanBlock(BaseModel):
    task_id: int | None = None
    title: str
    minutes: int
    why: str


class PlanResponse(BaseModel):
    headline: str
    blocks: list[PlanBlock]
    deferred: list[str] = Field(default_factory=list)
    total_minutes: int
    model: str
    note: str | None = None


# --------------------------------------------------------------------------
# AI: assistant chat
# --------------------------------------------------------------------------
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class ChatAction(BaseModel):
    tool: str
    summary: str


class ChatMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    actions: list[ChatAction] = Field(default_factory=list)
    created_at: UtcDatetime


class ChatResponse(BaseModel):
    reply: str
    actions: list[ChatAction] = Field(default_factory=list)
    model: str
    note: str | None = None


# --------------------------------------------------------------------------
# AI Studio
# --------------------------------------------------------------------------
StudioKind = Literal["page", "scene3d", "animation"]


class StudioRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    kind: StudioKind = "page"
    palette: str | None = Field(default=None, max_length=300)
    refine_id: int | None = None
    """Pass an existing generation id to iterate on it instead of starting over."""
    task_id: int | None = None


class GenerationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    prompt: str
    kind: str
    html: str
    notes: str | None = None
    saved_path: str | None = None
    task_id: int | None = None
    created_at: UtcDatetime


class GenerationSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    kind: str
    task_id: int | None = None
    saved_path: str | None = None
    created_at: UtcDatetime


class StudioResponse(BaseModel):
    generation: GenerationOut
    model: str
    note: str | None = None


# --------------------------------------------------------------------------
# Meta
# --------------------------------------------------------------------------
class AIStatus(BaseModel):
    ai_enabled: bool
    model: str
    model_source: str
    detail: str
