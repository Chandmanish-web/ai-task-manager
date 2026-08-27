"""Task and subtask CRUD. No AI in this module — it works without a key."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Subtask, Task
from app.schemas import (
    SubtaskCreate,
    SubtaskOut,
    SubtaskUpdate,
    TaskCreate,
    TaskOut,
    TaskStats,
    TaskUpdate,
)
from app.utils import is_overdue, utcnow

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

OPEN_STATUSES = ("inbox", "todo", "doing")


def _get_task_or_404(db: Session, task_id: int) -> Task:
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return task


@router.get("", response_model=list[TaskOut])
def list_tasks(
    db: Session = Depends(get_db),
    task_status: str | None = Query(
        default=None,
        alias="status",
        description="Exact status, or 'open' for inbox+todo+doing.",
    ),
    tag: str | None = Query(default=None),
    q: str | None = Query(default=None, description="Keyword in title or notes."),
    overdue_only: bool = Query(default=False),
    unscored_only: bool = Query(default=False, description="Tasks the AI hasn't scored."),
    sort: str = Query(default="smart", pattern="^(smart|created|due|priority|title)$"),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    stmt = select(Task)

    if task_status == "open":
        stmt = stmt.where(Task.status.in_(OPEN_STATUSES))
    elif task_status:
        stmt = stmt.where(Task.status == task_status)

    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Task.title.ilike(like), Task.notes.ilike(like)))

    if unscored_only:
        stmt = stmt.where(Task.ai_scored_at.is_(None))

    if sort == "smart":
        # Priority first, then soonest due (nulls last), then newest.
        stmt = stmt.order_by(
            Task.priority.asc(), Task.due_date.is_(None), Task.due_date.asc(), Task.id.desc()
        )
    elif sort == "created":
        stmt = stmt.order_by(Task.created_at.desc())
    elif sort == "due":
        stmt = stmt.order_by(Task.due_date.is_(None), Task.due_date.asc())
    elif sort == "priority":
        stmt = stmt.order_by(Task.priority.asc(), Task.id.desc())
    else:
        stmt = stmt.order_by(func.lower(Task.title).asc())

    tasks = list(db.scalars(stmt.limit(limit).offset(offset)).all())

    # Tag and overdue filters run in Python: tags is a JSON column, and overdue
    # needs timezone-aware comparison that SQLite can't do reliably.
    if tag:
        needle = tag.strip().lower().lstrip("#")
        tasks = [t for t in tasks if needle in (t.tags or [])]
    if overdue_only:
        tasks = [t for t in tasks if is_overdue(t)]

    return tasks


@router.get("/stats", response_model=TaskStats)
def task_stats(db: Session = Depends(get_db)):
    counts = dict(db.execute(select(Task.status, func.count(Task.id)).group_by(Task.status)).all())
    open_tasks = list(db.scalars(select(Task).where(Task.status.in_(OPEN_STATUSES))).all())
    unscored = db.scalar(
        select(func.count(Task.id)).where(
            Task.ai_scored_at.is_(None), Task.status.in_(OPEN_STATUSES)
        )
    )
    return TaskStats(
        total=sum(counts.values()),
        inbox=counts.get("inbox", 0),
        todo=counts.get("todo", 0),
        doing=counts.get("doing", 0),
        done=counts.get("done", 0),
        overdue=sum(1 for t in open_tasks if is_overdue(t)),
        unscored=unscored or 0,
        minutes_open=sum(t.effort_minutes or 0 for t in open_tasks),
    )


@router.get("/tags", response_model=list[str])
def list_tags(db: Session = Depends(get_db)):
    tasks = db.scalars(select(Task)).all()
    return sorted({tag for t in tasks for tag in (t.tags or [])})


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(payload: TaskCreate, db: Session = Depends(get_db)):
    data = payload.model_dump(exclude={"subtasks"})
    task = Task(**data, source="manual")
    if task.status == "done":
        task.completed_at = utcnow()
    db.add(task)
    db.flush()

    for i, sub in enumerate(payload.subtasks):
        db.add(Subtask(task_id=task.id, title=sub.title, done=sub.done, position=i))

    db.commit()
    db.refresh(task)
    return task


@router.get("/{task_id}", response_model=TaskOut)
def get_task(task_id: int, db: Session = Depends(get_db)):
    return _get_task_or_404(db, task_id)


@router.patch("/{task_id}", response_model=TaskOut)
def update_task(task_id: int, payload: TaskUpdate, db: Session = Depends(get_db)):
    task = _get_task_or_404(db, task_id)
    changes = payload.model_dump(exclude_unset=True)

    if "status" in changes:
        task.completed_at = utcnow() if changes["status"] == "done" else None

    for field, value in changes.items():
        setattr(task, field, value)

    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    db.delete(_get_task_or_404(db, task_id))
    db.commit()


@router.post("/{task_id}/subtasks", response_model=SubtaskOut, status_code=status.HTTP_201_CREATED)
def add_subtask(task_id: int, payload: SubtaskCreate, db: Session = Depends(get_db)):
    task = _get_task_or_404(db, task_id)
    sub = Subtask(
        task_id=task.id,
        title=payload.title,
        done=payload.done,
        position=payload.position or len(task.subtasks),
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


@router.patch("/{task_id}/subtasks/{subtask_id}", response_model=SubtaskOut)
def update_subtask(
    task_id: int, subtask_id: int, payload: SubtaskUpdate, db: Session = Depends(get_db)
):
    sub = db.get(Subtask, subtask_id)
    if sub is None or sub.task_id != task_id:
        raise HTTPException(status_code=404, detail="Subtask not found on that task")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(sub, field, value)
    db.commit()
    db.refresh(sub)
    return sub


@router.delete("/{task_id}/subtasks/{subtask_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subtask(task_id: int, subtask_id: int, db: Session = Depends(get_db)):
    sub = db.get(Subtask, subtask_id)
    if sub is None or sub.task_id != task_id:
        raise HTTPException(status_code=404, detail="Subtask not found on that task")
    db.delete(sub)
    db.commit()
