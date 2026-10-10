import os
from dataclasses import dataclass
from pathlib import Path

MIN_TOOL_TOKEN_BYTES = 32
# The API accepts rounds 1..4 only (packages/contracts/ai-tools.md).
API_MAX_ROUNDS = 4
# In a checkout, the repo's contract directory (services/intelligence/src/intelligence/ is four levels below
# the root). The image has no such layout; compose mounts the files and sets INTELLIGENCE_TOOL_CONTRACTS_DIR.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
DEFAULT_CONTRACTS_DIR = REPO_ROOT / "packages" / "contracts" / "ai-tools"


@dataclass(frozen=True)
class Settings:
    database_url: str
    kafka_bootstrap: str
    model_url: str
    model_api_key: str
    tools_token: str
    max_attempts: int = 3
    model_timeout_seconds: float = 90
    lease_seconds: int = 180
    max_concurrent: int = 1
    tools_url: str = "http://host.docker.internal:4001/internal/v1"
    contracts_dir: Path = DEFAULT_CONTRACTS_DIR
    max_tool_rounds: int = 4
    max_tool_calls: int = 8
    tool_timeout_seconds: float = 5
    attempt_deadline_seconds: int = 600

    def validate(self) -> None:
        if self.max_concurrent < 1:
            raise ValueError("INTELLIGENCE_MAX_CONCURRENT must be at least 1")
        if len(self.tools_token.encode()) < MIN_TOOL_TOKEN_BYTES:
            raise ValueError(f"INTELLIGENCE_TOOL_TOKEN must be at least {MIN_TOOL_TOKEN_BYTES} bytes")
        if not 1 <= self.max_tool_rounds <= API_MAX_ROUNDS:
            raise ValueError(f"INTELLIGENCE_MAX_TOOL_ROUNDS must be between 1 and {API_MAX_ROUNDS}")
        # One lease renewal covers a round: its model call plus every tool call that could follow it.
        if self.lease_seconds <= self.model_timeout_seconds + self.max_tool_calls * self.tool_timeout_seconds:
            raise ValueError("lease must outlast the model timeout plus all tool timeouts")


def load() -> Settings:
    url = os.environ.get("INTELLIGENCE_DATABASE_URL")
    if not url:
        raise RuntimeError("INTELLIGENCE_DATABASE_URL is required")
    token = os.environ.get("INTELLIGENCE_TOOL_TOKEN")
    if not token:
        raise RuntimeError("INTELLIGENCE_TOOL_TOKEN is required")
    settings = Settings(
        database_url=url,
        kafka_bootstrap=os.environ.get("INTELLIGENCE_KAFKA_BOOTSTRAP", "127.0.0.1:19092"),
        model_url=os.environ.get("INTELLIGENCE_MODEL_URL", "http://host.docker.internal:8000/v1"),
        model_api_key=os.environ.get("INTELLIGENCE_MODEL_API_KEY", ""),
        tools_token=token,
        max_attempts=int(os.environ.get("INTELLIGENCE_MAX_ATTEMPTS", "3")),
        model_timeout_seconds=float(os.environ.get("INTELLIGENCE_MODEL_TIMEOUT_SECONDS", "90")),
        lease_seconds=int(os.environ.get("INTELLIGENCE_LEASE_SECONDS", "180")),
        max_concurrent=int(os.environ.get("INTELLIGENCE_MAX_CONCURRENT", "1")),
        tools_url=os.environ.get("INTELLIGENCE_TOOLS_URL", Settings.tools_url),
        contracts_dir=Path(os.environ.get("INTELLIGENCE_TOOL_CONTRACTS_DIR", str(DEFAULT_CONTRACTS_DIR))),
        max_tool_rounds=int(os.environ.get("INTELLIGENCE_MAX_TOOL_ROUNDS", "4")),
        max_tool_calls=int(os.environ.get("INTELLIGENCE_MAX_TOOL_CALLS", "8")),
        tool_timeout_seconds=float(os.environ.get("INTELLIGENCE_TOOL_TIMEOUT_SECONDS", "5")),
        attempt_deadline_seconds=int(os.environ.get("INTELLIGENCE_ATTEMPT_DEADLINE_SECONDS", "600")),
    )
    settings.validate()
    return settings
