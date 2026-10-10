"""The bounded tool-calling loop for prompt versions 2 and 3 (ADR 0009, ADR 0010).

Everything the model emits is untrusted: a tool name is checked against the known set, arguments must parse
as a JSON object, and the API decides what they may touch. Tool results go back as `role: tool` messages
marked untrusted, never into the system prompt. In version 3 the final answer is a JSON object that the
API validates and stores; this module never decides whether it is acceptable.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from prometheus_client import Counter

from .config import Settings
from .errors import LeaseLost, RunError
from .model import RESULT_MAX_TOKENS, SYSTEM_V2, ModelClient, ToolCall, system_v3
from .tools import TOOL_NAMES, ToolClient, ToolResult

MAX_ARGS_BYTES = 8 * 1024
REPAIR_TURNS = Counter("investigation_repair_turns_total", "Repair turns after a rejected result", ["outcome"])

# Fixed wording for the API's violation codes. The repair message is built only from this table, so nothing
# the model or a tenant wrote is ever echoed back to the model as an instruction.
REPAIR_HINTS = {
    "schema_invalid": "the answer is not one JSON object that matches the schema",
    "forbidden_field": "the answer contains a field that only the system writes",
    "unknown_evidence_ref": "a claim cites a ref that was not given to you",
    "cross_attempt_ref": "a claim cites a ref from an earlier attempt",
    "evidence_not_ok": "a claim cites a tool result that failed",
    "uncited_claim": "a claim has no evidence",
    "missing_uncertainty_reason": "uncertainties is empty and noUncertaintyReason is missing",
}


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
        if result.call is not None:
            body["ref"] = f"call:{result.call}"
    return json.dumps(body, sort_keys=True)


def _reject_constant(name: str) -> None:
    raise ValueError(f"non-finite number {name}")


def _loads(raw: str) -> Any:
    """Parses JSON that can be sent on: no non-finite numbers, and no text (lone surrogates) that does not
    encode as UTF-8. Raises ValueError (UnicodeError is one) otherwise."""
    value = json.loads(raw, parse_constant=_reject_constant)
    json.dumps(value, allow_nan=False, ensure_ascii=False).encode("utf-8")
    return value


def _parse_args(raw: str) -> dict[str, Any] | None:
    """The arguments as an object, or None when they cannot be sent: too large, not JSON, not an object."""
    if len(raw.encode("utf-8", "surrogatepass")) > MAX_ARGS_BYTES:
        return None
    try:
        args = _loads(raw) if raw.strip() else {}
    except ValueError, RecursionError:
        return None
    return args if isinstance(args, dict) else None


def _parse_answer(content: str) -> tuple[bool, Any]:
    """The model's answer as JSON, tolerating one surrounding Markdown code fence. (False, None) when it is not."""
    text = content.strip()
    if text.startswith("```") and text.endswith("```"):
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```")
    try:
        return True, _loads(text)
    except ValueError, RecursionError:
        return False, None


def _repair_message(violations: list[str]) -> str:
    hints = "; ".join(sorted({REPAIR_HINTS.get(code, "the answer was rejected") for code in violations}))
    return f"Your answer was rejected: {hints}. Reply with the corrected JSON object only."


class Investigator:
    def __init__(
        self,
        settings: Settings,
        model: ModelClient,
        tools: ToolClient,
        tool_specs: list[dict[str, Any]],
        result_schema: dict[str, Any],
        clock: Callable[[], float] = time.monotonic,
    ):
        self._settings = settings
        self._model = model
        self._tools = tools
        self._specs = tool_specs
        self._system_v3 = system_v3(result_schema)
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

    def investigate_v3(self, run: Attempt, renew_lease: Callable[[], bool], deadline: float) -> int:
        """Prompt version 3. Returns the rounds used once the API has stored the result. Raises RunError or
        LeaseLost. The model gets tools in rounds 1 to N-2 and must answer in round N-1 at the latest, so one
        repair turn always fits in round N: the API's round budget is the same as in version 2.
        """
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self._system_v3},
            {"role": "user", "content": "Investigate this data snapshot:\n" + json.dumps(run.context, sort_keys=True)},
        ]
        max_rounds = self._settings.max_tool_rounds
        calls_used = 0
        repaired = False
        for round_number in range(1, max_rounds + 1):
            self._begin_round(renew_lease, deadline)
            token = self._tools.exchange_token(run.investigation_id, run.lease_owner, run.attempt)
            offer_tools = round_number <= max_rounds - 2 and not repaired
            reply = self._model.complete(
                run.model_id, messages, self._specs if offer_tools else None, max_tokens=RESULT_MAX_TOKENS
            )
            if reply.tool_calls:
                if not offer_tools:
                    raise self._invalid_output(repaired)
                messages.append(
                    {"role": "assistant", "content": None, "tool_calls": [c.as_message() for c in reply.tool_calls]}
                )
                for call in reply.tool_calls:
                    self._check_deadline(deadline)
                    calls_used += 1
                    result = self._run_call(run, token, round_number, call, calls_used)
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": _envelope(call.name, result)})
                continue
            content = reply.content or ""
            violations = self._submit(run, token, round_number, content)
            if not violations:
                if repaired:
                    REPAIR_TURNS.labels("recovered").inc()
                return round_number
            if repaired or round_number == max_rounds:
                raise self._invalid_output(repaired)
            repaired = True
            messages += [
                {"role": "assistant", "content": content},
                {"role": "user", "content": _repair_message(violations)},
            ]
        raise RunError("invalid_output", False)

    @staticmethod
    def _invalid_output(repaired: bool) -> RunError:
        if repaired:
            REPAIR_TURNS.labels("failed").inc()
        return RunError("invalid_output", False)

    def _submit(self, run: Attempt, token: str, round_number: int, content: str) -> list[str]:
        """The violation codes for the model's answer; empty once the API has stored it."""
        parsed, answer = _parse_answer(content)
        if not parsed:
            return ["schema_invalid"]
        return self._tools.complete(run.investigation_id, run.attempt, token, round_number, answer)

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
