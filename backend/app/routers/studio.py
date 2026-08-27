"""AI Studio: generate complete single-file web pages, 3D scenes and animations.

Output is a whole HTML document, previewed in a sandboxed iframe on the client
and optionally written to backend/generated/ so it can be opened directly.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.llm import prompts
from app.llm.client import AIUnavailable, llm
from app.models import Generation, Task
from app.routers.ai import require_ai
from app.schemas import GenerationOut, GenerationSummary, StudioRequest, StudioResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/studio", tags=["studio"])

# Storage APIs throw inside the sandboxed preview iframe, so a page that uses
# them silently breaks. Warn rather than rewrite — mangling generated JS is worse.
_STORAGE_RE = re.compile(r"\b(localStorage|sessionStorage|indexedDB)\b")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    return _SLUG_RE.sub("-", value.lower()).strip("-")[:60] or "page"


def _extract_document(html: str) -> str:
    """Unwrap a markdown fence if one slipped through, and sanity-check the doc."""
    text = html.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    return text


def _lint(html: str) -> list[str]:
    """Cheap checks that catch the failure modes we've actually seen."""
    warnings: list[str] = []
    lowered = html.lower()

    if "<!doctype" not in lowered:
        warnings.append("No <!DOCTYPE html> — the browser will use quirks mode.")
    if "</html>" not in lowered:
        warnings.append("The document looks truncated. Try again, or shorten the brief.")
    if _STORAGE_RE.search(html):
        warnings.append(
            "Uses browser storage, which is blocked in the preview sandbox. "
            "It will still work in a saved file opened directly."
        )
    if "orbitcontrols" in lowered:
        warnings.append(
            "References OrbitControls, which isn't in the three.js r128 bundle — "
            "camera controls may not work. Ask for a refine to replace it."
        )
    if "capsulegeometry" in lowered:
        warnings.append("Uses CapsuleGeometry, which doesn't exist in three.js r128.")

    return warnings


@router.get("", response_model=list[GenerationSummary])
def list_generations(db: Session = Depends(get_db)):
    return list(db.scalars(select(Generation).order_by(Generation.id.desc()).limit(60)).all())


@router.get("/{generation_id}", response_model=GenerationOut)
def get_generation(generation_id: int, db: Session = Depends(get_db)):
    gen = db.get(Generation, generation_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    return gen


@router.get("/{generation_id}/raw", response_class=HTMLResponse)
def raw_generation(generation_id: int, db: Session = Depends(get_db)):
    """Serve the page itself, for opening in a real browser tab."""
    gen = db.get(Generation, generation_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    return HTMLResponse(content=gen.html)


@router.delete("/{generation_id}", status_code=204)
def delete_generation(generation_id: int, db: Session = Depends(get_db)):
    gen = db.get(Generation, generation_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    db.delete(gen)
    db.commit()


@router.post("/{generation_id}/save", response_model=GenerationOut)
def save_to_disk(generation_id: int, db: Session = Depends(get_db)):
    """Write the page to backend/generated/ as a standalone .html file."""
    gen = db.get(Generation, generation_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found")

    settings = get_settings()
    settings.generated_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = settings.generated_dir / f"{stamp}-{_slugify(gen.title)}.html"
    path.write_text(gen.html, encoding="utf-8")

    gen.saved_path = str(path)
    db.commit()
    db.refresh(gen)
    return gen


@router.post("/generate", response_model=StudioResponse, dependencies=[Depends(require_ai)])
def generate(payload: StudioRequest, db: Session = Depends(get_db)):
    settings = get_settings()
    brief = prompts.STUDIO_KIND_BRIEF.get(payload.kind, prompts.STUDIO_KIND_BRIEF["page"])

    user = f"Brief type: {payload.kind}\n{brief}\n\nWhat to build:\n{payload.prompt.strip()}"

    if payload.palette:
        user += f"\n\nColour and type direction to follow: {payload.palette.strip()}"

    # Refining: hand back the previous document so the model edits rather than
    # rebuilds. Truncated because a long page plus a long reply can exceed the
    # output budget and produce a cut-off document.
    if payload.refine_id:
        previous = db.get(Generation, payload.refine_id)
        if previous is None:
            raise HTTPException(status_code=404, detail="Generation to refine not found")
        user += (
            "\n\nThis is a revision. Keep everything that already works and change "
            "only what the instruction above asks for. Return the complete updated "
            f"document.\n\nCurrent document:\n{previous.html[:60000]}"
        )

    if payload.task_id:
        task = db.get(Task, payload.task_id)
        if task:
            user += f"\n\nThis page relates to the task: {task.title}"
            if task.notes:
                user += f"\nTask notes: {task.notes[:500]}"

    try:
        result = llm.structured(
            system=prompts.STUDIO_SYSTEM,
            user=user,
            schema=prompts.STUDIO_SCHEMA,
            tool_name="deliver_page",
            tool_description="Deliver the finished single-file HTML page.",
            max_tokens=max(settings.anthropic_max_tokens, 8000),
            temperature=0.7,  # a little room for design personality
        )
    except AIUnavailable as exc:
        raise HTTPException(status_code=503, detail={"error": str(exc), "fix": exc.hint}) from exc

    html = _extract_document(result.get("html") or "")
    if not html:
        raise HTTPException(
            status_code=502,
            detail={"error": "The model returned an empty document.", "fix": "Try again."},
        )

    warnings = _lint(html)
    notes = (result.get("notes") or "").strip()

    gen = Generation(
        title=(result.get("title") or payload.prompt[:60]).strip()[:300],
        prompt=payload.prompt.strip(),
        kind=payload.kind,
        html=html,
        notes=notes or None,
        task_id=payload.task_id,
    )
    db.add(gen)
    db.commit()
    db.refresh(gen)

    return StudioResponse(
        generation=GenerationOut.model_validate(gen),
        model=llm.resolve_model(),
        note=" ".join(warnings) if warnings else None,
    )
