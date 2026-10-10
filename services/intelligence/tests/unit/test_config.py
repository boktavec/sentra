import pytest

from intelligence.config import Settings, load


def settings(**overrides: object) -> Settings:
    base = {"database_url": "u", "kafka_bootstrap": "k", "model_url": "m", "model_api_key": "", "tools_token": "t" * 32}
    return Settings(**{**base, **overrides})  # type: ignore[arg-type]


def test_defaults_satisfy_the_lease_invariant():
    settings().validate()  # 180 > 90 + 8 * 5


@pytest.mark.parametrize(
    "overrides",
    [
        {"tools_token": "short"},
        {"max_concurrent": 0},
        {"max_tool_rounds": 0},
        {"max_tool_rounds": 5},  # the API accepts rounds 1..4
        {"lease_seconds": 130},  # 90 + 8 * 5 = 130, not strictly less
        {"max_tool_calls": 40},
        {"tool_timeout_seconds": 20},
    ],
)
def test_rejects_unsafe_configuration(overrides: dict[str, object]):
    with pytest.raises(ValueError):
        settings(**overrides).validate()


def test_load_requires_the_database_and_the_tool_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("INTELLIGENCE_DATABASE_URL", raising=False)
    monkeypatch.delenv("INTELLIGENCE_TOOL_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="INTELLIGENCE_DATABASE_URL"):
        load()
    monkeypatch.setenv("INTELLIGENCE_DATABASE_URL", "postgresql://x")
    with pytest.raises(RuntimeError, match="INTELLIGENCE_TOOL_TOKEN"):
        load()
    monkeypatch.setenv("INTELLIGENCE_TOOL_TOKEN", "t" * 32)
    assert load().max_tool_calls == 8
