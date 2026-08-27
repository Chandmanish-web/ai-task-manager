"""Insert a handful of tasks so the UI has something to show on first run.

    python seed.py            # add sample tasks
    python seed.py --reset    # wipe everything first
"""

from __future__ import annotations

import sys
from datetime import timedelta

from app.database import SessionLocal, init_db
from app.models import ChatMessage, Generation, Subtask, Task
from app.utils import utcnow

SAMPLES = [
    {
        "title": "Ship the billing webhook retry fix",
        "notes": "Stripe events are dropped when our handler 500s. Needs idempotency keys.",
        "status": "doing",
        "priority": 1,
        "effort_minutes": 120,
        "due_in_days": 1,
        "tags": ["engineering", "billing"],
        "subtasks": ["Reproduce the dropped event locally", "Add idempotency key column", "Backfill last 7 days"],
    },
    {
        "title": "Write Q3 board update",
        "notes": "Two pages. Revenue, churn, hiring, one ask.",
        "status": "todo",
        "priority": 2,
        "effort_minutes": 90,
        "due_in_days": 4,
        "tags": ["writing", "leadership"],
    },
    {
        "title": "Review Priya's design system PR",
        "status": "todo",
        "priority": 1,
        "effort_minutes": 30,
        "due_in_days": 0,
        "tags": ["review"],
    },
    {
        "title": "Renew the SSL certificate",
        "notes": "Expired last cycle and took the marketing site down for 40 minutes.",
        "status": "todo",
        "priority": 1,
        "effort_minutes": 20,
        "due_in_days": -2,
        "tags": ["ops"],
    },
    {
        "title": "Build the animated landing page for the launch",
        "notes": "Hero needs a 3D product spin. Try AI Studio for a first pass.",
        "status": "todo",
        "priority": 2,
        "effort_minutes": 240,
        "due_in_days": 9,
        "tags": ["design", "marketing"],
    },
    {
        "title": "Cancel the unused analytics subscription",
        "status": "inbox",
        "priority": 4,
        "effort_minutes": 10,
        "tags": ["finance"],
    },
    {
        "title": "Book flights for the Berlin conference",
        "status": "inbox",
        "priority": 3,
        "effort_minutes": 25,
        "due_in_days": 12,
        "tags": ["travel"],
    },
    {
        "title": "Refactor the export job to stream instead of buffering",
        "notes": "Falls over on tenants with more than ~200k rows.",
        "status": "inbox",
        "priority": 2,
        "effort_minutes": 180,
        "tags": ["engineering"],
    },
]


def main() -> None:
    reset = "--reset" in sys.argv
    init_db()
    db = SessionLocal()
    try:
        if reset:
            for model in (Subtask, ChatMessage, Generation, Task):
                for row in db.query(model).all():
                    db.delete(row)
            db.commit()
            print("Cleared existing data.")

        if db.query(Task).count() and not reset:
            print("Tasks already exist — nothing added. Use --reset to start clean.")
            return

        now = utcnow()
        for sample in SAMPLES:
            steps = sample.pop("subtasks", [])
            due_in = sample.pop("due_in_days", None)
            task = Task(
                **sample,
                due_date=(now + timedelta(days=due_in)) if due_in is not None else None,
                source="manual",
            )
            db.add(task)
            db.flush()
            for i, step in enumerate(steps):
                db.add(Subtask(task_id=task.id, title=step, position=i))

        db.commit()
        print(f"Added {len(SAMPLES)} sample tasks.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
