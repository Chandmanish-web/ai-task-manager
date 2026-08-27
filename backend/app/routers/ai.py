"""The four AI features: capture, scoring, breakdown, plan + chat assistant.

Every route here goes through ``require_ai``, so a missing key produces a clear
503 with a fix instead of a stack trace.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.llm import prompts
from app.llm.client import AIUnavailable, llm
from app.llm.tools import build_task_tools
from app.models import ChatMessage, Subtask, Task
from app.schemas import (
    AIStatus,
    BreakdownRequest,
    BreakdownResponse,
    CaptureRequest,
    CaptureRequestPreview,
    CaptureResponse,
    ChatMessageOut,
    ChatRequest,
    ChatResponse,
    PlanRequest,
    PlanResponse,
    ScoreRequest,
    ScoreResponse,
    TaskOut,
)
from app.utils import context_header, parse_date, render_task_lines, task_brief, utcnow

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai", tags=["ai"])

OPEN_STATUSES = ("inbox", "todo", "doing")
VALID_STATUSES = {"inbox", "todo", "doing", "done", "archived"}

# The response schemas are strict on purpose — priority is 1-4, urgency and
# importance are 1-5, effort_minutes is a required positive int. A model is
# free to hand back 0, 7, null or "pending" anyway. Without clamping, those
# values write cleanly into SQLite (the columns are untyped ints and strings)
# and then blow up during response validation, which surfaces as an opaque 500
# *after* the data has already been committed. Coercing at the boundary keeps
# the stored state and the response schema in agreement.
DEFAULT_EFFORT_MINUTES = 30


def _clamp(value, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _clamp_optional(value, low: int, high: int) -> int | None:
    """Like _clamp but preserves 'not provided' as None."""
    if value is None or value == "":
        return None
    return _clamp(value, low, high, low)



def require_ai() -> None:
    """Dependency: fail fast and helpfully when AI can't run."""
    if not llm.enabled:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "AI features are switched off because no API key is set.",
                "fix": (
                    "Copy backend/.env.example to backend/.env, paste your Anthropic key "
                    "into ANTHROPIC_API_KEY, then restart the server."
                ),
            },
        )


def _ai_error(exc: AIUnavailable) -> HTTPException:
    return HTTPException(status_code=503, detail={"error": str(exc), "fix": exc.hint})


@router.get("/status", response_model=AIStatus)
def ai_status():
    """Called on app load so the UI can show a banner instead of failing later."""
    return AIStatus(**llm.status())


# ---------------------------------------------------------------------------
# 1. Natural-language capture
# ---------------------------------------------------------------------------
def _existing_tags(db: Session) -> list[str]:
    tasks = db.scalars(select(Task).where(Task.status.in_(OPEN_STATUSES))).all()
    return sorted({tag for t in tasks for tag in (t.tags or [])})[:30]


def _sanitize_draft(draft: dict) -> dict | None:
    """Coerce one model-produced task draft into something the schema accepts.

    Returns None for drafts with no usable title. Applied before both the
    preview response and the save, so what the user confirms is exactly what
    gets written.
    """
    title = str(draft.get("title") or "").strip()
    if not title:
        return None

    status = str(draft.get("status") or "inbox").strip().lower()
    if status not in VALID_STATUSES:
        status = "inbox"

    tags = [
        str(t).strip().lower().lstrip("#")
        for t in (draft.get("tags") or [])
        if str(t).strip()
    ]

    notes = draft.get("notes")
    return {
        "title": title[:500],
        "notes": str(notes) if notes else None,
        "status": status,
        "priority": _clamp(draft.get("priority"), 1, 4, 3),
        "effort_minutes": _clamp_optional(draft.get("effort_minutes"), 1, 100_000),
        "due_date": parse_date(draft.get("due_date")),
        "tags": tags[:10],
        "reason": draft.get("reason") or None,
    }


def _persist_captured(db: Session, drafts: list[dict], source: str) -> list[Task]:
    saved = []
    for draft in drafts:
        clean = _sanitize_draft(draft)
        if clean is None:
            continue
        task = Task(
            title=clean["title"],
            notes=clean["notes"],
            status=clean["status"],
            priority=clean["priority"],
            effort_minutes=clean["effort_minutes"],
            due_date=clean["due_date"],
            tags=clean["tags"],
            source=source,
        )
        db.add(task)
        saved.append(task)
    db.commit()
    for task in saved:
        db.refresh(task)
    return saved


@router.post("/capture", response_model=CaptureResponse, dependencies=[Depends(require_ai)])
def capture(payload: CaptureRequest, db: Session = Depends(get_db)):
    """Brain-dump in, structured tasks out."""
    tags = _existing_tags(db)
    user = (
        f"{context_header()}\n\n"
        f"Tags already in use (reuse when they fit): {', '.join(tags) if tags else '(none yet)'}\n\n"
        f"Brain-dump to convert:\n---\n{payload.text.strip()}\n---"
    )

    try:
        result = llm.structured(
            system=prompts.CAPTURE_SYSTEM,
            user=user,
            schema=prompts.CAPTURE_SCHEMA,
            tool_name="save_tasks",
            tool_description="Record the tasks extracted from the brain-dump.",
        )
    except AIUnavailable as exc:
        raise _ai_error(exc) from exc

    drafts = [d for d in (_sanitize_draft(d) for d in (result.get("tasks") or [])) if d]
    if not drafts:
        return CaptureResponse(
            tasks=[],
            saved=[],
            model=llm.resolve_model(),
            note="No actionable tasks found in that text.",
        )

    saved = _persist_captured(db, drafts, "ai_capture") if payload.autosave else []

    return CaptureResponse(
        tasks=drafts,
        saved=[TaskOut.model_validate(t) for t in saved],
        model=llm.resolve_model(),
        note=(
            f"Saved {len(saved)} task(s)."
            if payload.autosave
            else "Preview only — nothing saved yet."
        ),
    )


@router.post("/capture/confirm", response_model=list[TaskOut])
def capture_confirm(payload: CaptureRequestPreview, db: Session = Depends(get_db)):
    """Save drafts the user reviewed and possibly edited. No AI call needed."""
    saved = _persist_captured(db, [t.model_dump() for t in payload.tasks], "ai_capture")
    return [TaskOut.model_validate(t) for t in saved]


# ---------------------------------------------------------------------------
# 2. Priority + effort scoring
# ---------------------------------------------------------------------------
@router.post("/score", response_model=ScoreResponse, dependencies=[Depends(require_ai)])
def score(payload: ScoreRequest, db: Session = Depends(get_db)):
    if payload.task_ids:
        tasks = list(db.scalars(select(Task).where(Task.id.in_(payload.task_ids))).all())
    else:
        tasks = list(
            db.scalars(
                select(Task).where(
                    Task.status.in_(OPEN_STATUSES), Task.ai_scored_at.is_(None)
                )
            ).all()
        )

    if not tasks:
        return ScoreResponse(
            scored=[],
            model=llm.resolve_model(),
            note="Nothing to score — every open task already has a score.",
        )

    tasks = tasks[:40]  # keep the prompt bounded
    payload_json = json.dumps([task_brief(t) for t in tasks], indent=2, default=str)
    user = f"{context_header()}\n\n"
    if payload.context:
        user += f"What matters to this person right now: {payload.context.strip()}\n\n"
    user += f"Tasks to triage:\n{payload_json}"

    try:
        result = llm.structured(
            system=prompts.SCORE_SYSTEM,
            user=user,
            schema=prompts.SCORE_SCHEMA,
            tool_name="save_scores",
            tool_description="Record urgency, importance, priority and effort for each task.",
        )
    except AIUnavailable as exc:
        raise _ai_error(exc) from exc

    by_id = {t.id: t for t in tasks}
    out = []
    now = utcnow()

    for row in result.get("scored") or []:
        task = by_id.get(row.get("id"))
        if task is None:
            continue  # model hallucinated an id; drop it rather than crash
        task.priority = _clamp(row.get("priority"), 1, 4, task.priority or 3)
        task.ai_urgency = _clamp(row.get("urgency"), 1, 5, 3)
        task.ai_importance = _clamp(row.get("importance"), 1, 5, 3)
        task.ai_reasoning = str(row.get("reasoning") or "").strip() or None
        task.effort_minutes = _clamp(
            row.get("effort_minutes"),
            1,
            100_000,
            task.effort_minutes or DEFAULT_EFFORT_MINUTES,
        )
        task.ai_scored_at = now
        out.append(
            {
                "id": task.id,
                "title": task.title,
                "priority": task.priority,
                "urgency": task.ai_urgency,
                "importance": task.ai_importance,
                "effort_minutes": task.effort_minutes,
                "reasoning": task.ai_reasoning or "",
            }
        )

    db.commit()
    return ScoreResponse(
        scored=out,
        model=llm.resolve_model(),
        note=f"Scored {len(out)} task(s).",
    )


# ---------------------------------------------------------------------------
# 3. Subtask breakdown
# ---------------------------------------------------------------------------
@router.post("/breakdown", response_model=BreakdownResponse, dependencies=[Depends(require_ai)])
def breakdown(payload: BreakdownRequest, db: Session = Depends(get_db)):
    task = db.get(Task, payload.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {payload.task_id} not found")

    user = f"{context_header()}\n\nTask to break down:\n{json.dumps(task_brief(task), indent=2, default=str)}\n\n"
    user += f"Produce at most {payload.max_steps} steps."
    if payload.guidance:
        user += f"\nExtra direction from the person: {payload.guidance.strip()}"
    if task.subtasks:
        existing = "; ".join(s.title for s in task.subtasks)
        user += f"\nSteps already on this task (don't repeat these): {existing}"

    try:
        result = llm.structured(
            system=prompts.BREAKDOWN_SYSTEM,
            user=user,
            schema=prompts.BREAKDOWN_SCHEMA,
            tool_name="save_steps",
            tool_description="Record the ordered steps for this task.",
        )
    except AIUnavailable as exc:
        raise _ai_error(exc) from exc

    steps = [str(s).strip() for s in (result.get("steps") or []) if str(s).strip()]
    steps = steps[: payload.max_steps]

    saved: list[Subtask] = []
    if payload.autosave and steps:
        start = len(task.subtasks)
        for i, step in enumerate(steps):
            sub = Subtask(task_id=task.id, title=step[:500], position=start + i)
            db.add(sub)
            saved.append(sub)
        db.commit()
        for sub in saved:
            db.refresh(sub)

    return BreakdownResponse(
        task_id=task.id,
        steps=steps,
        approach=result.get("approach"),
        saved=[s for s in saved],
        model=llm.resolve_model(),
        note=(f"Added {len(saved)} step(s)." if saved else "Preview only — nothing saved."),
    )


# ---------------------------------------------------------------------------
# 4a. Daily plan
# ---------------------------------------------------------------------------
@router.post("/plan", response_model=PlanResponse, dependencies=[Depends(require_ai)])
def plan(payload: PlanRequest, db: Session = Depends(get_db)):
    tasks = list(
        db.scalars(
            select(Task)
            .where(Task.status.in_(OPEN_STATUSES))
            .order_by(Task.priority.asc(), Task.due_date.is_(None), Task.due_date.asc())
        ).all()
    )[:50]

    user = (
        f"{context_header()}\n\n"
        f"Time available this session: {payload.available_minutes} minutes.\n"
        f"Energy level: {payload.energy}.\n"
    )
    if payload.context:
        user += f"Context from the person: {payload.context.strip()}\n"
    user += f"\nOpen tasks:\n{render_task_lines(tasks)}"

    try:
        result = llm.structured(
            system=prompts.PLAN_SYSTEM,
            user=user,
            schema=prompts.PLAN_SCHEMA,
            tool_name="save_plan",
            tool_description="Record the focus plan for this session.",
        )
    except AIUnavailable as exc:
        raise _ai_error(exc) from exc

    valid_ids = {t.id for t in tasks}
    blocks = []
    for b in result.get("blocks") or []:
        tid = b.get("task_id")
        blocks.append(
            {
                "task_id": tid if tid in valid_ids else None,
                "title": str(b.get("title") or "Untitled block")[:500],
                "minutes": _clamp(b.get("minutes"), 5, 1440, 15),
                "why": str(b.get("why") or ""),
            }
        )

    total = sum(b["minutes"] for b in blocks)
    note = None
    if total > payload.available_minutes:
        note = (
            f"This plan totals {total} minutes against {payload.available_minutes} available — "
            "the last block will likely spill over."
        )

    return PlanResponse(
        headline=result.get("headline") or "Here's your session plan.",
        blocks=blocks,
        deferred=[str(d) for d in (result.get("deferred") or [])],
        total_minutes=total,
        model=llm.resolve_model(),
        note=note,
    )


# ---------------------------------------------------------------------------
# 4b. Chat assistant (tool-using)
# ---------------------------------------------------------------------------
CHAT_HISTORY_TURNS = 12


def _as_conversation(history: list[ChatMessage], new_message: str) -> list[dict]:
    """Build a message list the Messages API will actually accept.

    Two things make stored history unsafe to send as-is. It is a tail slice, so
    it can begin mid-turn with an assistant message, and the API requires the
    conversation to start with a user turn. And when an AI call fails we still
    keep the user's message so it is not lost, which leaves a user turn with no
    reply — the next request would then send two user turns in a row. The API
    rejects both shapes, and the second one would wedge the chat permanently
    after a single rate-limit blip.

    So: drop any leading assistant turns, then merge consecutive same-role runs.
    """
    rows = [
        (m.role, m.content.strip())
        for m in history
        if m.role in ("user", "assistant") and m.content and m.content.strip()
    ]
    rows.append(("user", new_message))

    while rows and rows[0][0] != "user":
        rows.pop(0)

    merged: list[dict] = []
    for role, content in rows:
        if merged and merged[-1]["role"] == role:
            merged[-1]["content"] = f"{merged[-1]['content']}\n\n{content}"
        else:
            merged.append({"role": role, "content": content})
    return merged


@router.get("/chat", response_model=list[ChatMessageOut])
def chat_history(db: Session = Depends(get_db)):
    rows = list(
        db.scalars(select(ChatMessage).order_by(ChatMessage.id.desc()).limit(60)).all()
    )
    return list(reversed(rows))


@router.delete("/chat", status_code=204)
def clear_chat(db: Session = Depends(get_db)):
    for row in db.scalars(select(ChatMessage)).all():
        db.delete(row)
    db.commit()


@router.post("/chat", response_model=ChatResponse, dependencies=[Depends(require_ai)])
def chat(payload: ChatRequest, db: Session = Depends(get_db)):
    history = list(
        reversed(
            list(
                db.scalars(
                    select(ChatMessage).order_by(ChatMessage.id.desc()).limit(CHAT_HISTORY_TURNS)
                ).all()
            )
        )
    )

    messages = _as_conversation(history, payload.message.strip())

    db.add(ChatMessage(role="user", content=payload.message.strip(), actions=[]))
    db.commit()

    system = f"{prompts.CHAT_SYSTEM}\n\n{context_header()}"

    try:
        reply, actions = llm.converse(
            system=system,
            messages=messages,
            tools=build_task_tools(db),
        )
    except AIUnavailable as exc:
        raise _ai_error(exc) from exc

    if not reply:
        reply = "Done." if actions else "I'm not sure what to do with that — can you rephrase?"

    db.add(ChatMessage(role="assistant", content=reply, actions=actions))
    db.commit()

    return ChatResponse(reply=reply, actions=actions, model=llm.resolve_model())
