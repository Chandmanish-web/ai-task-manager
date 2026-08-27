"""FastAPI application entry point.

Run from the backend/ folder:
    uvicorn app.main:app --reload
Interactive API docs: http://127.0.0.1:8000/docs
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import BACKEND_DIR, get_settings
from app.database import init_db
from app.llm.client import llm
from app.routers import ai, studio, tasks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("aitasks")

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    logger.info("Database ready at %s", settings.database_url)

    if settings.ai_enabled:
        status = llm.status()
        logger.info("AI enabled — model: %s (%s)", status["model"], status["model_source"])
    else:
        logger.warning(
            "No ANTHROPIC_API_KEY found. Task management works; AI endpoints will "
            "return 503. Add your key to %s to switch them on.",
            BACKEND_DIR / ".env",
        )
    yield


app = FastAPI(
    title="AI Task Manager",
    description=(
        "Task management with Claude doing the triage: natural-language capture, "
        "priority and effort scoring, subtask breakdown, session planning, a "
        "tool-using assistant, and a single-file web page generator."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tasks.router)
app.include_router(ai.router)
app.include_router(studio.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {
        "status": "ok",
        "ai_enabled": settings.ai_enabled,
        "database": settings.database_url.rsplit("/", 1)[-1],
    }


# --- Optionally serve the built frontend ----------------------------------
# After `npm run build` in frontend/, this makes the whole app available on
# http://127.0.0.1:8000 with no second server. In development you'd normally
# use the Vite dev server on :5173 instead.
FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"

if FRONTEND_DIST.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=str(FRONTEND_DIST / "assets")),
        name="assets",
    )

    @app.get("/", include_in_schema=False)
    def spa_root():
        return FileResponse(str(FRONTEND_DIST / "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_catchall(full_path: str):
        # Real routes are registered above and win, so anything reaching here is
        # either a static file or a client-side route. One exception: a mistyped
        # API path would otherwise be answered with index.html and a 200, which
        # looks like the endpoint exists and returns garbage. Let those 404.
        if full_path.startswith("api/") or full_path == "api":
            raise HTTPException(status_code=404, detail={"error": f"No such endpoint: /{full_path}"})
        # Resolve before trusting the path: '../../etc/passwd' would otherwise
        # escape dist/ and hand out arbitrary files from disk. Anything that
        # lands outside dist/ falls back to index.html.
        candidate = (FRONTEND_DIST / full_path).resolve()
        if candidate.is_file() and candidate.is_relative_to(FRONTEND_DIST.resolve()):
            return FileResponse(str(candidate))
        return FileResponse(str(FRONTEND_DIST / "index.html"))

else:

    @app.get("/", include_in_schema=False)
    def docs_redirect():
        return RedirectResponse("/docs")
