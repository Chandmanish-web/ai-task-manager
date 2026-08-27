"""Shared helpers: date coercion and the compact task view sent to the model."""

from __future__ import annotations

from datetime import date, datetime, timezone

from dateutil import parser as date_parser

from app.models import Task

PRIORITY_LABEL = {1: "urgent+important", 2: "important", 3: "urgent only", 4: "neither"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def today_iso() -> str:
    return utcnow().date().isoformat()


def context_header() -> str:
    """Every prompt gets today's date — models have no clock of their own."""
    now = utcnow()
    return f"Today is {now.strftime('%A, %d %B %Y')} ({now.date().isoformat()}, UTC)."


def parse_date(value: str | datetime | date | None) -> datetime | None:
    """Accept whatever the model or client sends; return tz-aware UTC or None."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    try:
        parsed = date_parser.parse(str(value))
    except (ValueError, OverflowError, TypeError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def as_aware(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; make them comparable again."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def is_overdue(task: Task) -> bool:
    """Overdue means the due *day* has passed, not the due instant.

    Due dates come from a date picker and are stored as midnight UTC, so an
    instant comparison would flag a task due today as overdue from 00:01
    onwards. Comparing calendar dates also keeps this in step with the
    frontend's day-based badge, which otherwise disagreed with the row styling.
    """
    due = as_aware(task.due_date)
    if due is None or task.status in ("done", "archived"):
        return False
    return due.date() < utcnow().date()


def task_brief(task: Task, *, include_notes: bool = True) -> dict:
    """Compact dict for LLM context. Trimmed to keep prompts cheap and focused."""
    due = as_aware(task.due_date)
    brief: dict = {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "priority": task.priority,
        "priority_meaning": PRIORITY_LABEL.get(task.priority, "unknown"),
        "effort_minutes": task.effort_minutes,
        "due_date": due.date().isoformat() if due else None,
        "tags": task.tags or [],
    }
    if due:
        brief["days_until_due"] = (due.date() - utcnow().date()).days
    if include_notes and task.notes:
        brief["notes"] = task.notes[:400]
    if task.subtasks:
        brief["open_subtasks"] = [s.title for s in task.subtasks if not s.done][:8]
    return brief


def render_task_lines(tasks: list[Task]) -> str:
    """Human-readable list for prompts that don't need full JSON."""
    if not tasks:
        return "(no tasks)"
    lines = []
    for t in tasks:
        due = as_aware(t.due_date)
        bits = [f"#{t.id}", t.title, f"P{t.priority}", f"status={t.status}"]
        if t.effort_minutes:
            bits.append(f"~{t.effort_minutes}m")
        if due:
            days = (due.date() - utcnow().date()).days
            when = "today" if days == 0 else (f"in {days}d" if days > 0 else f"{abs(days)}d overdue")
            bits.append(f"due {due.date().isoformat()} ({when})")
        if t.tags:
            bits.append("tags=" + ",".join(t.tags))
        lines.append(" | ".join(bits))
    return "\n".join(lines)
