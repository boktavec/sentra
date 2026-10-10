"""The bounded tool-calling loop for prompt version 2 (ADR 0009).

Everything the model emits is untrusted: a tool name is checked against the known set, arguments must parse
as a JSON object, and the API decides what they may touch. Tool results go back as `role: tool` messages
marked untrusted, never into the system prompt.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .config import Settings
from .errors import LeaseLost, RunError
from .model import SYSTEM_V2, ModelClient, ToolCall
from .tools import TOOL_NAMES, ToolClient, ToolResult

MAX_ARGS_BYTES = 8 * 1024


@dataclass(frozen=True)
class Attempt:
    """What the loop needs to know about the claimed run. Tenant scope is deliberately absent."""

    investigation_id: str
    lease_owner: str
    attempt: int
    model_id: str
    context: dict[str, Any]


def _envelope(tool: str, result: ToolResult) -> str:
    body: dict[str, Any] = {"tool": tool, "untrusted": True, "source": "sentra_api"}
    if result.error is not None:
        body["error"] = {"code": result.error}
    else:
        body["data"] = result.data
        body["truncated"] = result.truncated
    return json.dumps(body, sort_keys=True)


def _reject_constant(name: str) -> None:
    raise ValueError(f"non-finite number {name}")


def _parse_args(raw: str) -> dict[str, Any] | None:
    """The arguments as an object, or None when they cannot be sent: too large, not JSON, not an object,
    non-finite numbers, or text (lone surrogates) that does not encode as UTF-8."""
    if len(raw.encode("utf-8", "surrogatepass")) > MAX_ARGS_BYTES:
        return None
    try:
        args = json.loads(raw, parse_constant=_reject_constant) if raw.strip() else {}
        if not isinstance(args, dict):
            return None
        json.dumps(args, allow_nan=False, ensure_ascii=False).encode("utf-8")
    except ValueError, UnicodeError, RecursionError:
        return None
    return args


class Investigator:
    def __init__(
        self,
        settings: Settings,
        model: ModelClient,
        tools: ToolClient,
        tool_specs: list[dict[str, Any]],
        clock: Callable[[], float] = time.monotonic,
    ):
        self._settings = settings
        self._model = model
        self._tools = tools
        self._specs = tool_specs
        self._clock = clock

    def investigate(self, run: Attempt, renew_lease: Callable[[], bool], deadline: float) -> tuple[str, int]:
        """Returns the draft and the number of rounds used. Raises RunError or LeaseLost, never writes."""
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_V2},
            {"role": "user", "content": "Investigate this data snapshot:\n" + json.dumps(run.context, sort_keys=True)},
        ]
        calls_used = 0
        for round_number in range(1, self._settings.max_tool_rounds):
            self._begin_round(renew_lease, deadline)
            token = self._tools.exchange_token(run.investigation_id, run.lease_owner, run.attempt)
            reply = self._model.complete(run.model_id, messages, self._specs)
            if not reply.tool_calls:
                return reply.content or "", round_number
            messages.append(
                {"role": "assistant", "content": None, "tool_calls": [c.as_message() for c in reply.tool_calls]}
            )
            for call in reply.tool_calls:
                self._check_deadline(deadline)
                calls_used += 1
                result = self._run_call(run, token, round_number, call, calls_used)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": _envelope(call.name, result)})
        # The last round offers no tools, so the model has to answer; a tool call here is malformed output.
        self._begin_round(renew_lease, deadline)
        reply = self._model.complete(run.model_id, messages, None)
        if reply.tool_calls:
            raise RunError("invalid_output", False)
        return reply.content or "", self._settings.max_tool_rounds

    def _begin_round(self, renew_lease: Callable[[], bool], deadline: float) -> None:
        self._check_deadline(deadline)
        if not renew_lease():
            raise LeaseLost

    def _check_deadline(self, deadline: float) -> None:
        if self._clock() >= deadline:
            raise RunError("deadline_exceeded", True)

    def _run_call(self, run: Attempt, token: str, round_number: int, call: ToolCall, calls_used: int) -> ToolResult:
        # Calls that never reach the API still count, so a looping model cannot dodge the budget.
        if calls_used > self._settings.max_tool_calls:
            return ToolResult(error="call_limit_reached")
        if call.name not in TOOL_NAMES:
            return ToolResult(error="unknown_tool")
        args = _parse_args(call.arguments)
        if args is None:
            return ToolResult(error="invalid_args")
        return self._tools.call(run.investigation_id, run.attempt, token, call.name, round_number, args)
