"""Anthropic client wrapper.

Three jobs:

1. Hold one lazily-built SDK client so a missing key never crashes import.
2. Resolve which model to call. ``ANTHROPIC_MODEL=auto`` asks the API what the
   key can actually access, so the app keeps working after a model ID retires.
3. Give the rest of the app two calling styles: ``structured()`` for JSON that
   must match a schema, and ``converse()`` for a tool-using agent loop.

Structured output uses forced tool-use rather than "reply with JSON" prompting.
The API validates the arguments against the schema before we ever see them,
which removes the whole class of markdown-fenced-JSON parsing bugs.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any, Callable

from app.config import get_settings

logger = logging.getLogger(__name__)

# Used only if ANTHROPIC_MODEL=auto and the models list call fails (offline,
# proxy, restricted key). Any valid ID works here; it is a last resort.
FALLBACK_MODEL = "claude-sonnet-4-20250514"

# Families we know how to rank, best-first within the preference order.
_FAMILY_PATTERNS = {
    "opus": re.compile(r"opus", re.I),
    "sonnet": re.compile(r"sonnet", re.I),
    "haiku": re.compile(r"haiku", re.I),
}


# Tool results are plain strings as far as the API is concerned, so clipping
# mid-JSON is not a protocol error — but an unmarked cut makes the model think
# it saw the whole result. Say so explicitly instead.
_TOOL_RESULT_LIMIT = 6000


def _clip(payload: str, limit: int = _TOOL_RESULT_LIMIT) -> str:
    if len(payload) <= limit:
        return payload
    return payload[:limit] + f"\n\n[truncated at {limit} characters — narrow the query to see the rest]"


class AIUnavailable(RuntimeError):
    """Raised when an AI call cannot be made. Routers turn this into HTTP 503.

    ``hint`` is written for the person running the app, not for a log file.
    """

    def __init__(self, message: str, hint: str | None = None):
        super().__init__(message)
        self.hint = hint


class ToolSpec:
    """A tool the assistant can call, plus the Python that runs it."""

    def __init__(
        self,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        handler: Callable[..., Any],
        summarize: Callable[[dict[str, Any], Any], str] | None = None,
    ):
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler
        self.summarize = summarize

    def as_api_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


class LLM:
    def __init__(self) -> None:
        self._client = None
        self._resolved_model: str | None = None
        self._model_source = "unresolved"
        # Reentrant: resolve_model() holds this lock and then calls
        # _require_client(), which needs it too. A plain Lock self-deadlocks
        # and hangs the server on the first AI call.
        self._lock = threading.RLock()

    # -- plumbing ---------------------------------------------------------
    @property
    def settings(self):
        return get_settings()

    @property
    def enabled(self) -> bool:
        return self.settings.ai_enabled

    def _require_client(self):
        if not self.enabled:
            raise AIUnavailable(
                "No Anthropic API key configured.",
                hint=(
                    "Copy backend/.env.example to backend/.env, paste your key into "
                    "ANTHROPIC_API_KEY, then restart the server."
                ),
            )
        if self._client is None:
            with self._lock:
                if self._client is None:
                    try:
                        from anthropic import Anthropic
                    except ImportError as exc:  # pragma: no cover
                        raise AIUnavailable(
                            "The anthropic package is not installed.",
                            hint="Run: pip install -r backend/requirements.txt",
                        ) from exc
                    self._client = Anthropic(api_key=self.settings.anthropic_api_key.strip())
        return self._client

    # -- model resolution -------------------------------------------------
    def _family_rank(self, model_id: str, preference: list[str]) -> int:
        """Index of this model's family in the preference list.

        Returns ``len(preference)`` for families we do not recognise, so
        unknown models sort last but are still usable as a last resort.
        """
        for idx, family in enumerate(preference):
            pattern = _FAMILY_PATTERNS.get(family)
            if pattern and pattern.search(model_id):
                return idx
        return len(preference)

    def _pick_model(self, available: list[str], preference: list[str]) -> str | None:
        """Best model: preferred family first, newest release within it.

        Two passes, relying on Python's stable sort. First sort every ID
        descending, which puts newer releases ahead of older ones because
        Anthropic IDs embed a version and date that compare correctly as
        strings ('claude-sonnet-4-5-20250929' > 'claude-sonnet-4-20250514' >
        'claude-3-5-sonnet-20241022'). Then stable-sort by family rank, which
        reorders families without disturbing the newest-first order inside
        each one. A single ascending sort would pick the OLDEST model in the
        preferred family, which is the opposite of what we want.
        """
        if not available:
            return None
        newest_first = sorted(available, reverse=True)
        ranked = sorted(newest_first, key=lambda m: self._family_rank(m, preference))
        return ranked[0]

    def resolve_model(self) -> str:
        configured = self.settings.anthropic_model.strip()

        if configured and configured.lower() != "auto":
            self._resolved_model = configured
            self._model_source = "pinned in .env"
            return configured

        if self._resolved_model:
            return self._resolved_model

        with self._lock:
            if self._resolved_model:
                return self._resolved_model

            preference = self.settings.model_preference_list or ["sonnet"]
            try:
                client = self._require_client()
                available = [m.id for m in client.models.list(limit=100).data]
                best = self._pick_model(available, preference)
                if not best:
                    raise ValueError("models.list returned no models")
                self._resolved_model = best
                self._model_source = "auto-detected from your API key"
                logger.info("Resolved Anthropic model: %s", best)
            except AIUnavailable:
                raise
            except Exception as exc:
                logger.warning("Model auto-detection failed (%s); using %s", exc, FALLBACK_MODEL)
                self._resolved_model = FALLBACK_MODEL
                self._model_source = f"fallback ({exc.__class__.__name__} during auto-detect)"

        return self._resolved_model

    def status(self) -> dict[str, str | bool]:
        if not self.enabled:
            return {
                "ai_enabled": False,
                "model": "none",
                "model_source": "no key",
                "detail": (
                    "Running without AI. Tasks, subtasks and filters all work. "
                    "Add ANTHROPIC_API_KEY to backend/.env to switch the AI features on."
                ),
            }
        try:
            model = self.resolve_model()
            return {
                "ai_enabled": True,
                "model": model,
                "model_source": self._model_source,
                "detail": f"AI features ready, calling {model}.",
            }
        except Exception as exc:
            return {
                "ai_enabled": False,
                "model": "unknown",
                "model_source": "error",
                "detail": f"Key present but the API is not reachable: {exc}",
            }

    def _translate_error(self, exc: Exception) -> AIUnavailable:
        """Turn SDK exceptions into something actionable."""
        name = exc.__class__.__name__
        text = str(exc)

        if "Authentication" in name or "401" in text:
            return AIUnavailable(
                "Anthropic rejected the API key.",
                hint="Check ANTHROPIC_API_KEY in backend/.env — it should start with 'sk-ant-'.",
            )
        if "RateLimit" in name or "429" in text:
            return AIUnavailable(
                "Rate limited by Anthropic.",
                hint="Wait a few seconds and try again.",
            )
        if "NotFound" in name or "404" in text:
            return AIUnavailable(
                f"Model '{self._resolved_model}' is not available to this key.",
                hint="Set ANTHROPIC_MODEL=auto in backend/.env to detect a working model.",
            )
        if "Connection" in name or "Timeout" in name:
            return AIUnavailable(
                "Could not reach the Anthropic API.",
                hint="Check your network connection or proxy settings.",
            )
        if "Overloaded" in name or "529" in text:
            return AIUnavailable(
                "Anthropic is overloaded right now.",
                hint="Retry in a moment.",
            )
        return AIUnavailable(f"AI request failed: {text}", hint=None)

    # -- calling styles ---------------------------------------------------
    def structured(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        tool_name: str = "respond",
        tool_description: str = "Return the structured result.",
        max_tokens: int | None = None,
        temperature: float = 0.2,
    ) -> dict[str, Any]:
        """Force one tool call and hand back its validated arguments."""
        client = self._require_client()
        model = self.resolve_model()
        try:
            message = client.messages.create(
                model=model,
                max_tokens=max_tokens or min(self.settings.anthropic_max_tokens, 4096),
                temperature=temperature,
                system=system,
                tools=[
                    {
                        "name": tool_name,
                        "description": tool_description,
                        "input_schema": schema,
                    }
                ],
                tool_choice={"type": "tool", "name": tool_name},
                messages=[{"role": "user", "content": user}],
            )
        except Exception as exc:
            raise self._translate_error(exc) from exc

        for block in message.content:
            if getattr(block, "type", None) == "tool_use":
                return dict(block.input)

        raise AIUnavailable(
            "The model did not return structured data.",
            hint="Try rephrasing your input, or retry — this is usually transient.",
        )

    def text(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int | None = None,
        temperature: float = 0.6,
        prefill: str | None = None,
        stop_sequences: list[str] | None = None,
    ) -> str:
        """Plain text completion. ``prefill`` seeds the assistant's reply."""
        client = self._require_client()
        model = self.resolve_model()
        messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
        if prefill:
            messages.append({"role": "assistant", "content": prefill})

        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens or self.settings.anthropic_max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": messages,
        }
        if stop_sequences:
            kwargs["stop_sequences"] = stop_sequences

        try:
            message = client.messages.create(**kwargs)
        except Exception as exc:
            raise self._translate_error(exc) from exc

        parts = [b.text for b in message.content if getattr(b, "type", None) == "text"]
        body = "".join(parts)
        return (prefill + body) if prefill else body

    def converse(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[ToolSpec],
        max_rounds: int = 6,
        max_tokens: int | None = None,
        temperature: float = 0.3,
    ) -> tuple[str, list[dict[str, str]]]:
        """Agent loop: let the model call tools until it writes a final answer.

        Returns ``(reply_text, actions)`` where actions describe what ran, so
        the UI can show the user which tasks the assistant touched.
        """
        client = self._require_client()
        model = self.resolve_model()
        by_name = {t.name: t for t in tools}
        convo = list(messages)
        actions: list[dict[str, str]] = []

        for _ in range(max_rounds):
            try:
                message = client.messages.create(
                    model=model,
                    max_tokens=max_tokens or min(self.settings.anthropic_max_tokens, 4096),
                    temperature=temperature,
                    system=system,
                    tools=[t.as_api_dict() for t in tools],
                    messages=convo,
                )
            except Exception as exc:
                raise self._translate_error(exc) from exc

            tool_uses = [b for b in message.content if getattr(b, "type", None) == "tool_use"]

            if not tool_uses:
                reply = "".join(
                    b.text for b in message.content if getattr(b, "type", None) == "text"
                ).strip()
                return reply, actions

            # Echo the assistant turn back, then answer every tool call.
            # Pass the SDK's own block objects straight through rather than
            # model_dump()-ing them: the dump includes optional fields the
            # request schema may reject (citations=None and friends), while the
            # objects round-trip cleanly and keep thinking-block signatures.
            convo.append({"role": "assistant", "content": message.content})

            results = []
            for block in tool_uses:
                spec = by_name.get(block.name)
                args = dict(block.input)
                if spec is None:
                    payload, is_error = f"Unknown tool: {block.name}", True
                else:
                    try:
                        outcome = spec.handler(**args)
                        payload = _clip(json.dumps(outcome, default=str))
                        is_error = False
                        actions.append(
                            {
                                "tool": spec.name,
                                "summary": (
                                    spec.summarize(args, outcome)
                                    if spec.summarize
                                    else f"Ran {spec.name}"
                                ),
                            }
                        )
                    except Exception as exc:  # surface tool errors to the model
                        logger.exception("Tool %s failed", block.name)
                        payload, is_error = f"{exc.__class__.__name__}: {exc}", True

                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": payload,
                        "is_error": is_error,
                    }
                )

            convo.append({"role": "user", "content": results})

        return (
            "I ran out of steps working on that. Try breaking the request into smaller pieces.",
            actions,
        )


llm = LLM()
