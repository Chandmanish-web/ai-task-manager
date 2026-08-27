"""Tools the chat assistant can call against the live task database.

Each ToolSpec closes over the request's SQLAlchemy session, so the assistant
reads and writes the same data the UI is looking at.
"""

from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.llm.client import ToolSpec
from app.models import Subtask, Task
from app.utils import is_overdue, parse_date, task_brief, utcnow

OPEN_STATUSES = ("inbox", "todo", "doing")
_STATUS_VALUES = ["inbox", "todo", "doing", "done", "archived"]


def build_task_tools(db: Session) -> list[ToolSpec]:
    # ---- read -----------------------------------------------------------
    def list_tasks(status: str | None = None, limit: int = 40) -> dict:
        stmt = select(Task)
        if status == "open" or status is None:
            stmt = stmt.where(Task.status.in_(OPEN_STATUSES))
        elif status != "all":
            stmt = stmt.where(Task.status == status)
        stmt = stmt.order_by(Task.priority, Task.due_date.is_(None), Task.due_date, Task.id)
        tasks = db.scalars(stmt.limit(min(limit, 100))).all()
        return {
            "count": len(tasks),
            "tasks": [task_brief(t, include_notes=False) for t in tasks],
        }

    def search_tasks(query: str, include_done: bool = False, limit: int = 15) -> dict:
        like = f"%{query.strip()}%"
        stmt = select(Task).where(or_(Task.title.ilike(like), Task.notes.ilike(like)))
        if not include_done:
            stmt = stmt.where(Task.status.in_(OPEN_STATUSES))
        tasks = db.scalars(stmt.order_by(Task.priority, Task.id).limit(min(limit, 50))).all()
        if not tasks:
            return {"count": 0, "tasks": [], "hint": f"Nothing matches '{query}'."}
        return {"count": len(tasks), "tasks": [task_brief(t) for t in tasks]}

    def get_task(task_id: int) -> dict:
        task = db.get(Task, task_id)
        if not task:
            return {"error": f"No task with id {task_id}."}
        data = task_brief(task)
        data["subtasks"] = [
            {"id": s.id, "title": s.title, "done": s.done} for s in task.subtasks
        ]
        data["ai_reasoning"] = task.ai_reasoning
        return data

    def summarize_list() -> dict:
        counts = dict(
            db.execute(select(Task.status, func.count(Task.id)).group_by(Task.status)).all()
        )
        open_tasks = db.scalars(select(Task).where(Task.status.in_(OPEN_STATUSES))).all()
        return {
            "by_status": counts,
            "open_count": len(open_tasks),
            "overdue": [t.title for t in open_tasks if is_overdue(t)],
            "open_minutes": sum(t.effort_minutes or 0 for t in open_tasks),
            "tags_in_use": sorted({tag for t in open_tasks for tag in (t.tags or [])}),
        }

    # ---- write ----------------------------------------------------------
    def create_task(
        title: str,
        notes: str | None = None,
        priority: int = 3,
        effort_minutes: int | None = None,
        due_date: str | None = None,
        tags: list[str] | None = None,
        status: str = "todo",
    ) -> dict:
        task = Task(
            title=title.strip()[:500],
            notes=notes,
            priority=max(1, min(4, priority)),
            effort_minutes=effort_minutes,
            due_date=parse_date(due_date),
            tags=[t.strip().lower().lstrip("#") for t in (tags or []) if t.strip()][:10],
            status=status if status in _STATUS_VALUES else "todo",
            source="ai_capture",
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        return {"created": task_brief(task)}

    def update_task(
        task_id: int,
        title: str | None = None,
        notes: str | None = None,
        status: str | None = None,
        priority: int | None = None,
        effort_minutes: int | None = None,
        due_date: str | None = None,
        tags: list[str] | None = None,
    ) -> dict:
        task = db.get(Task, task_id)
        if not task:
            return {"error": f"No task with id {task_id}."}

        if title is not None:
            task.title = title.strip()[:500]
        if notes is not None:
            task.notes = notes
        if priority is not None:
            task.priority = max(1, min(4, priority))
        if effort_minutes is not None:
            task.effort_minutes = effort_minutes
        if due_date is not None:
            task.due_date = parse_date(due_date)
        if tags is not None:
            task.tags = [t.strip().lower().lstrip("#") for t in tags if t.strip()][:10]
        if status is not None:
            if status not in _STATUS_VALUES:
                return {"error": f"status must be one of {_STATUS_VALUES}"}
            task.status = status
            task.completed_at = utcnow() if status == "done" else None

        db.commit()
        db.refresh(task)
        return {"updated": task_brief(task)}

    def complete_task(task_id: int) -> dict:
        return update_task(task_id, status="done")

    def delete_task(task_id: int) -> dict:
        task = db.get(Task, task_id)
        if not task:
            return {"error": f"No task with id {task_id}."}
        title = task.title
        db.delete(task)
        db.commit()
        return {"deleted": {"id": task_id, "title": title}}

    def add_subtasks(task_id: int, steps: list[str]) -> dict:
        task = db.get(Task, task_id)
        if not task:
            return {"error": f"No task with id {task_id}."}
        start = len(task.subtasks)
        created = []
        for i, step in enumerate(steps):
            text = step.strip()
            if not text:
                continue
            sub = Subtask(task_id=task.id, title=text[:500], position=start + i)
            db.add(sub)
            created.append(text)
        db.commit()
        return {"task": task.title, "added": created}

    # ---- specs ----------------------------------------------------------
    return [
        ToolSpec(
            name="list_tasks",
            description=(
                "List tasks. Use status='open' (default) for inbox+todo+doing, "
                "'all' for everything, or an exact status. Start here for "
                "questions like 'what's on my plate'."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["open", "all", *_STATUS_VALUES],
                        "description": "Which tasks to include. Defaults to open.",
                    },
                    "limit": {"type": "integer", "description": "Max tasks, default 40."},
                },
            },
            handler=list_tasks,
            summarize=lambda a, r: f"Listed {r['count']} tasks",
        ),
        ToolSpec(
            name="search_tasks",
            description=(
                "Find tasks by keyword in title or notes. Always use this to get a "
                "task id before updating or deleting — never guess an id."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Keyword or phrase."},
                    "include_done": {"type": "boolean", "description": "Search completed too."},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
            handler=search_tasks,
            summarize=lambda a, r: f"Searched \"{a.get('query')}\" — {r['count']} match(es)",
        ),
        ToolSpec(
            name="get_task",
            description="Read one task in full, including its subtasks and AI reasoning.",
            input_schema={
                "type": "object",
                "properties": {"task_id": {"type": "integer"}},
                "required": ["task_id"],
            },
            handler=get_task,
            summarize=lambda a, r: f"Read task #{a.get('task_id')}",
        ),
        ToolSpec(
            name="summarize_list",
            description=(
                "Counts by status, overdue titles, total open minutes, and tags in "
                "use. Use for 'how am I doing' or workload questions."
            ),
            input_schema={"type": "object", "properties": {}},
            handler=summarize_list,
            summarize=lambda a, r: f"Summarised the list ({r['open_count']} open)",
        ),
        ToolSpec(
            name="create_task",
            description="Add a new task. Only fields the person actually specified or clearly implied.",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Action-first title."},
                    "notes": {"type": "string"},
                    "priority": {"type": "integer", "minimum": 1, "maximum": 4},
                    "effort_minutes": {"type": "integer"},
                    "due_date": {"type": "string", "description": "ISO date YYYY-MM-DD."},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "status": {"type": "string", "enum": _STATUS_VALUES},
                },
                "required": ["title"],
            },
            handler=create_task,
            summarize=lambda a, r: f"Created \"{a.get('title')}\"",
        ),
        ToolSpec(
            name="update_task",
            description=(
                "Change fields on an existing task. Pass only the fields that "
                "change. Set status='done' to complete it."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "notes": {"type": "string"},
                    "status": {"type": "string", "enum": _STATUS_VALUES},
                    "priority": {"type": "integer", "minimum": 1, "maximum": 4},
                    "effort_minutes": {"type": "integer"},
                    "due_date": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["task_id"],
            },
            handler=update_task,
            summarize=lambda a, r: (
                f"Updated #{a.get('task_id')}"
                + (f" to {a['status']}" if a.get("status") else "")
            ),
        ),
        ToolSpec(
            name="complete_task",
            description="Mark a task done. Shorthand for update_task with status='done'.",
            input_schema={
                "type": "object",
                "properties": {"task_id": {"type": "integer"}},
                "required": ["task_id"],
            },
            handler=complete_task,
            summarize=lambda a, r: f"Completed #{a.get('task_id')}",
        ),
        ToolSpec(
            name="delete_task",
            description=(
                "Permanently delete a task and its subtasks. Confirm with the "
                "person before calling this — it cannot be undone."
            ),
            input_schema={
                "type": "object",
                "properties": {"task_id": {"type": "integer"}},
                "required": ["task_id"],
            },
            handler=delete_task,
            summarize=lambda a, r: f"Deleted #{a.get('task_id')}",
        ),
        ToolSpec(
            name="add_subtasks",
            description="Append ordered steps to a task. Each step is one concrete action.",
            input_schema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer"},
                    "steps": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["task_id", "steps"],
            },
            handler=add_subtasks,
            summarize=lambda a, r: f"Added {len(a.get('steps', []))} step(s) to #{a.get('task_id')}",
        ),
    ]
