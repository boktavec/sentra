"""Client for the API's internal tool listener (ADR 0009, packages/contracts/ai-tools.md).

The worker only checks that a tool name is known and its arguments parse as an object; the API validates
them against the contract and is the authority on scope. Nothing here is told which tenant a run belongs to.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .errors import LeaseLost, RunError

TOOL_NAMES = ("get_finding_risk", "list_related_findings", "get_dependency_occurrences", "lookup_advisory")


@dataclass(frozen=True)
class ToolResult:
    """`error` is a stable code the model may react to; `data` is untrusted retrieved content."""

    data: Any = None
    error: str | None = None
    truncated: bool = False
    # The number the API gave a successful call; the model cites it as call:<n>.
    call: int | None = None


def load_tool_specs(contracts_dir: Path) -> list[dict[str, Any]]:
    """The model's tool list, built from the same contract files the API validates against."""
    specs = []
    for name in TOOL_NAMES:
        contract = json.loads((contracts_dir / f"{name}.v1.json").read_text())
        if contract["tool"] != name:
            raise ValueError(f"contract {name}.v1.json names {contract['tool']}")
        specs.append(
            {
                "type": "function",
                "function": {"name": name, "description": contract["description"], "parameters": contract["arguments"]},
            }
        )
    return specs


def load_result_schema(contracts_dir: Path) -> dict[str, Any]:
    """The JSON Schema of the model-written part of the result, from the contract the API validates against."""
    schema = json.loads((contracts_dir / "investigation-result.v1.json").read_text())["model"]
    if not isinstance(schema, dict):
        raise ValueError("investigation-result.v1.json has no model schema")
    return schema


class ToolClient:
    def __init__(self, base_url: str, service_token: str, timeout_seconds: float):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + "/",
            headers={"Authorization": f"Bearer {service_token}"},
            timeout=httpx.Timeout(timeout_seconds),
        )

    def close(self) -> None:
        self._client.close()

    def _post(self, path: str, correlation_id: str, body: dict[str, Any], token: str | None = None) -> httpx.Response:
        headers = {"X-Correlation-Id": correlation_id}
        if token:
            headers["X-Investigation-Token"] = token
        try:
            response = self._client.post(path, json=body, headers=headers)
        except httpx.HTTPError as exc:  # timeouts, refused connections, resets: the API is unreachable
            raise RunError("tool_unavailable", True) from exc
        if response.status_code == 401:
            raise RunError("tool_unauthorized", False)
        if response.status_code == 409:
            raise LeaseLost
        return response

    def exchange_token(self, investigation_id: str, lease_owner: str, attempt: int) -> str:
        response = self._post(
            f"investigations/{investigation_id}/token", f"{investigation_id}.{attempt}", {"leaseOwner": lease_owner}
        )
        if response.status_code != 200:
            raise RunError("tool_unavailable", True)
        try:
            token = response.json()["token"]
        except (ValueError, KeyError, TypeError) as exc:
            raise RunError("tool_unavailable", True) from exc
        if not isinstance(token, str) or not token:
            raise RunError("tool_unavailable", True)
        return token

    def call(
        self, investigation_id: str, attempt: int, token: str, tool: str, round_number: int, args: dict[str, Any]
    ) -> ToolResult:
        response = self._post(
            f"investigations/{investigation_id}/tools/{tool}",
            f"{investigation_id}.{attempt}",
            {"round": round_number, "args": args},
            token,
        )
        if response.status_code == 404:
            return ToolResult(error="unknown_tool")
        if response.status_code != 200:
            # 5xx is an outage. Any other status means the envelope was wrong: a worker bug that a retry repeats.
            raise (
                RunError("tool_unavailable", True)
                if response.status_code >= 500
                else RunError("processing_error", False)
            )
        try:
            body = response.json()
            if body["outcome"] == "ok":
                return ToolResult(data=body["data"], truncated=bool(body.get("truncated")), call=body.get("call"))
            return ToolResult(error=str(body["error"]["code"]))
        except (ValueError, KeyError, TypeError) as exc:
            raise RunError("tool_unavailable", True) from exc

    def complete(self, investigation_id: str, attempt: int, token: str, round_number: int, result: Any) -> list[str]:
        """Hands the model's answer to the API, which validates and stores it. Returns the violation codes, or an
        empty list when the result was stored."""
        response = self._post(
            f"investigations/{investigation_id}/complete",
            f"{investigation_id}.{attempt}",
            {"round": round_number, "result": result},
            token,
        )
        if response.status_code != 200:
            raise (
                RunError("tool_unavailable", True)
                if response.status_code >= 500
                else RunError("processing_error", False)
            )
        try:
            body = response.json()
            if body["outcome"] == "ok":
                return []
            violations = body["violations"]
            if body["outcome"] != "invalid_result" or not violations or not all(isinstance(v, str) for v in violations):
                raise ValueError("unexpected complete response")
            return violations
        except (ValueError, KeyError, TypeError) as exc:
            raise RunError("tool_unavailable", True) from exc
