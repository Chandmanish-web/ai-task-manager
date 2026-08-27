# AI Task Manager

A task manager where the AI does real work rather than decorating the UI. You dump a
paragraph of half-formed thoughts into one box and get structured tasks back; Claude
scores what matters, breaks big items into steps, builds a plan that fits the hours you
actually have, and edits your list when you talk to it. There is also an AI Studio tab
that generates complete standalone web pages — including 3D and animated ones — from a
description.

Python + FastAPI + SQLite on the back, React + Tailwind on the front, Anthropic Claude
for the intelligence.

## What it does

**Quick capture.** Type `finish the investor deck before Friday, call the vendor about
pricing, and I keep forgetting to renew the domain` and Claude returns three separate
tasks with due dates, priorities and time estimates attached. Nothing is saved until you
review it — the extraction opens in a sheet where you can edit any field or drop a row
before committing.

**Priority and effort scoring.** Claude rates urgency and importance separately, maps
them onto an Eisenhower-style P1–P4, estimates how many minutes each task will take, and
writes a sentence explaining the call. The reasoning is stored and shown in the detail
panel, so a score you disagree with is arguable rather than opaque.

**Subtask breakdown.** Turn "launch the new pricing page" into an ordered checklist. You
can steer it with a note like "assume I'm starting from scratch" before it runs.

**Session planner.** Tell it how long you have and whether your energy is low, medium or
high. It fills the time from your open list and — this is the useful half — reports what
it deliberately left out and why.

**Chat assistant.** A conversation with tool access to your own task list. It can search,
create, update and complete tasks on request, so "mark the deck as done and push the
vendor call to Monday" just works. Conversation history persists in the database.

**AI Studio.** Describe a page and Claude writes a complete, self-contained HTML document
with its CSS and JS inline, using Three.js and GSAP when the request calls for 3D or
animation. Output renders live in a sandboxed iframe, and you can save it to disk or
download it. Deliberately kept separate from the task UI, which stays plain and fast.

## Setup

You need [Python 3.10+](https://www.python.org/downloads/) and
[Node.js 18+](https://nodejs.org/). On Windows, tick **"Add python.exe to PATH"** in the
Python installer.

### Windows

From the project root, in Command Prompt:

```bat
setup.bat
```

That creates the virtual environment, installs both dependency sets, creates
`backend\.env` from the example, and seeds a few sample tasks.

### macOS / Linux

```bash
bash setup.sh
```

### Add your API key

Get a key at <https://console.anthropic.com/settings/keys> — it starts with `sk-ant-`.
Open `backend/.env` in any text editor and paste it in:

```ini
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

That file is git-ignored, and `.env.example` ships blank, so your key stays on your
machine. Nothing else needs to change: `ANTHROPIC_MODEL=auto` asks the API which models
your key can reach and picks the best available one, which means the app does not break
when a model ID is eventually retired.

Running without a key is supported and does something sensible: task CRUD, filtering,
search, subtasks and stats all work, the AI buttons are disabled with a tooltip
explaining why, and the AI endpoints return `503` with a message telling you which file
to edit rather than a stack trace.

### Run it

There are two ways, and the first is probably what you want.

**One window, one port.** Builds the frontend, then starts the backend, which serves that
build itself:

```bat
start-app.bat          REM Windows
bash start-app.sh      # macOS / Linux
```

Everything is then at <http://127.0.0.1:8000> — the app at `/`, the interactive API docs
at `/docs`. This is the mode to use when you just want to *use* the app.

**Two windows, with hot reload.** Better for editing the frontend, since Vite reloads
changes instantly:

```bat
start-backend.bat     REM keep this window open
start-frontend.bat    REM new window
```

On macOS/Linux:

```bash
cd backend  && ./.venv/bin/python -m uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev
```

Then open <http://localhost:5173>.

Both modes use the same code and the same API. The frontend always calls `/api/...`
relative to wherever it's served from — Vite proxies that to port 8000 in development, and
in single-server mode it's already the same origin. CORS never enters the picture either
way.

## Keyboard

`Ctrl/Cmd+K` jumps to the capture box from anywhere. `1`–`4` switch between List, Plan,
Ask and Studio. `Escape` closes the task panel — it works while your cursor is still in
one of that panel's fields, and an open dialog claims `Escape` for itself so one keypress
never dismisses two things.

## Architecture

```
setup.bat / setup.sh       one-time install, creates .env, seeds sample tasks
start-app.bat / .sh        build frontend + run everything on one port
start-backend.bat          backend only, with reload
start-frontend.bat         Vite dev server only
backend/
  app/
    main.py          app factory, CORS, lifespan, /api/health, serves frontend/dist
    config.py        settings from .env (pydantic-settings)
    database.py      SQLAlchemy engine + session; WAL and foreign_keys pragmas
    models.py        Task, Subtask, ChatMessage, Generation
    schemas.py       Pydantic v2 request/response models
    utils.py         date parsing, timezone helpers, overdue logic
    llm/
      client.py      Anthropic wrapper: model resolution, structured output, tool loop
      prompts.py     system prompts, one per feature
      tools.py       tool schemas for structured output and the chat agent
    routers/
      tasks.py       CRUD, subtasks, stats, tags
      ai.py          capture, score, breakdown, plan, chat
      studio.py      page generation, save, list, fetch raw
  seed.py            sample tasks
frontend/
  src/
    App.jsx          shell, routing, task list, keyboard, data fetching
    components/      QuickCapture, TaskRow, TaskDetail, PlanPanel,
                     AssistantPanel, StudioPanel, ui.jsx (Modal, Notice, toasts)
    lib/api.js       fetch wrapper; turns error payloads into readable messages
    lib/format.js    priority/status labels, minutes, due-date maths
  check-imports.mjs  offline import + syntax check (see Verification)
```

A few decisions worth knowing about:

**Structured output uses forced tool use, not JSON parsing.** Every feature that needs
machine-readable output declares a tool schema and sets
`tool_choice={"type": "tool", "name": ...}`. The model fills in the schema, so there is no
prose-wrapped JSON to salvage with a regex.

**LLM values are clamped before they touch the database.** A model that returns
`priority: 7` or `effort_minutes: -3` writes cleanly into SQLite and then fails response
validation, which surfaces as an opaque 500 *after* the data is already committed. Every
numeric field from the model goes through a clamp and every status through an allowlist,
so bad output degrades to a sane default instead of a broken row.

**Dates are calendar dates, not instants.** Due dates are stored as midnight UTC and read
back in UTC; "today" is the user's own local day. That keeps the "Today" badge honest for
someone in Auckland instead of shifting everyone's dates west, and both places the UI
shows lateness share one helper, so the list and the detail panel can't disagree.

**Errors carry a fix.** When AI is unavailable the API responds with
`{"error": ..., "fix": ...}`, and the UI renders the fix line. Missing key says which file
to edit; a rate limit says to wait.

**One deployable, two dev modes.** `main.py` mounts `frontend/dist` and serves the SPA
itself when that folder exists, falling back to a `/docs` redirect when it doesn't. The
catch-all that makes client-side routing work deliberately excludes `/api/*` — otherwise a
mistyped endpoint returns `index.html` with a 200, which looks like a working endpoint
returning garbage — and it resolves paths before serving them, so `../../` can't escape
`dist/`.

## API

All routes are under `/api`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/tasks` | List. Filter by `status` (or `open`), `tag`, `q`, `overdue_only`, `unscored_only`; `sort` = smart\|created\|due\|priority\|title; `limit`/`offset` |
| `POST` | `/api/tasks` | Create |
| `GET` | `/api/tasks/stats` | Counts, overdue total, estimated minutes |
| `GET` | `/api/tasks/tags` | Every tag in use |
| `GET` | `/api/tasks/{id}` | One task with subtasks |
| `PATCH` | `/api/tasks/{id}` | Partial update |
| `DELETE` | `/api/tasks/{id}` | Delete |
| `POST` | `/api/tasks/{id}/subtasks` | Add a step |
| `PATCH` | `/api/tasks/{id}/subtasks/{sid}` | Update a step |
| `DELETE` | `/api/tasks/{id}/subtasks/{sid}` | Delete a step |
| `GET` | `/api/ai/status` | Whether AI is on, and which model resolved |
| `POST` | `/api/ai/capture` | Text → draft tasks (`autosave` optional) |
| `POST` | `/api/ai/capture/confirm` | Commit reviewed drafts |
| `POST` | `/api/ai/score` | Priority, urgency, importance, effort, reasoning |
| `POST` | `/api/ai/breakdown` | Task → ordered subtasks |
| `POST` | `/api/ai/plan` | Time + energy → session plan with deferrals |
| `GET` | `/api/ai/chat` | Conversation history |
| `POST` | `/api/ai/chat` | Send a message; may act on your tasks |
| `DELETE` | `/api/ai/chat` | Clear history |
| `POST` | `/api/studio/generate` | Description → complete HTML page |
| `GET` | `/api/studio` | Past generations |
| `GET` | `/api/studio/{id}` | One generation with its HTML |
| `GET` | `/api/studio/{id}/raw` | Serve the HTML directly |
| `POST` | `/api/studio/{id}/save` | Write it to `backend/generated/` |
| `DELETE` | `/api/studio/{id}` | Delete |

## Verification — please read

This project was written in a sandbox with no access to PyPI or the npm registry (the
proxy returns 403 for both). **`pip install -r requirements.txt`, `npm install`, the
server boot and `npm run build` were never executed.** So the first run on your machine
is genuinely the first run, and I'd expect the usual first-run friction rather than a
guaranteed clean start.

What *was* verified, statically:

- Every backend module compiles: `python3 -m compileall app seed.py` passes.
- Every relative import in the frontend resolves to a name the target module actually
  exports, and braces, parens and brackets balance in all 11 source files —
  `cd frontend && node check-imports.mjs`. That checker is self-tested against
  deliberately broken and deliberately tricky-but-valid files, because its first two
  versions produced false positives on JSX and on apostrophes inside double-quoted
  strings.
- Model auto-selection was proved correct with a standalone script: preferred family
  first, newest release within it.
- Date round-tripping was proved stable across five timezones including UTC+13 and
  UTC+14, where a naive local-time implementation shifts the day on every save.

If something does fail on first run, the two likeliest causes are a Python or Node
version below the minimum, and `python`/`npm` not being on your PATH. The error output
from `setup.bat` will say which.

## Troubleshooting

**"AI features are off."** `backend/.env` has no `ANTHROPIC_API_KEY`, or the backend was
started before you saved the file. Add the key and restart the backend window.

**"Can't reach the backend."** The frontend is up but nothing is serving port 8000 — the
backend window probably exited. Look at it for the error.

**A model ID error.** Set `ANTHROPIC_MODEL=auto` in `backend/.env` and restart, which
lets the app discover a model your key can actually use.

**Start over.** Delete `backend/taskmanager.db` and run `python seed.py` from `backend/`
with the venv's Python. Nothing outside that file is persistent state.
