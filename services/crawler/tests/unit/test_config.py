import importlib

import pytest

from crawler import config
from crawler.config import Limits


def test_importing_the_entrypoint_module_does_not_start_the_service(monkeypatch):
    for name in ("CRAWLER_DATABASE_URL", "CRAWLER_S3_ENDPOINT", "CRAWLER_SIGNING_KEYS"):
        monkeypatch.delenv(name, raising=False)
    importlib.import_module("crawler.__main__")  # must not load config, connect, or block


def test_lease_and_poll_interval_outlast_the_worst_case_run():
    limits = Limits()
    worst_case = limits.total_timeout + 10 * 60  # whole download budget plus upload/db overhead
    assert limits.claim_lease_seconds >= worst_case
    assert limits.poll_interval_ms / 1000 >= limits.claim_lease_seconds


def test_runtime_settings_come_from_validated_config(monkeypatch):
    env = {
        "CRAWLER_DATABASE_URL": "postgresql://x",
        "CRAWLER_S3_ENDPOINT": "http://s3",
        "CRAWLER_S3_ACCESS_KEY": "a",
        "CRAWLER_S3_SECRET_KEY": "b",
        "CRAWLER_SIGNING_KEYS": "k1=s",
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    defaults = config.load()
    assert (defaults.metrics_host, defaults.metrics_port) == ("127.0.0.1", 9102)
    monkeypatch.setenv("CRAWLER_METRICS_HOST", "0.0.0.0")  # noqa: S104 - what a container deployment sets
    monkeypatch.setenv("CRAWLER_METRICS_PORT", "9200")
    monkeypatch.setenv("CRAWLER_KAFKA_BOOTSTRAP", "broker:9092")
    tuned = config.load()
    assert (tuned.metrics_host, tuned.metrics_port, tuned.kafka_bootstrap) == ("0.0.0.0", 9200, "broker:9092")  # noqa: S104
    monkeypatch.setenv("CRAWLER_METRICS_PORT", "not-a-port")
    with pytest.raises(RuntimeError, match="CRAWLER_METRICS_PORT"):
        config.load()


def test_github_token_is_optional_and_redacted_everywhere_it_could_be_printed(monkeypatch):
    for k, v in {
        "CRAWLER_DATABASE_URL": "postgresql://x",
        "CRAWLER_S3_ENDPOINT": "http://s3",
        "CRAWLER_S3_ACCESS_KEY": "a",
        "CRAWLER_S3_SECRET_KEY": "b",
        "CRAWLER_SIGNING_KEYS": "k1=s",
    }.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("CRAWLER_GITHUB_TOKEN", raising=False)
    assert config.load().github_token is None
    monkeypatch.setenv("CRAWLER_GITHUB_TOKEN", "  ")
    assert config.load().github_token is None

    token = "ghp_exampleTOKEN0123456789"
    monkeypatch.setenv("CRAWLER_GITHUB_TOKEN", token)
    settings = config.load()
    assert settings.github_token is not None and settings.github_token.reveal() == token
    for rendering in (
        repr(settings),
        str(settings),
        repr(settings.github_token),
        f"{settings.github_token}",
        f"{settings!r}",
    ):
        assert token not in rendering


@pytest.mark.parametrize("bad", ["two words", "line\nbreak", "tab\there", "café"])
def test_a_malformed_github_token_is_refused_without_echoing_it(bad):
    with pytest.raises(RuntimeError, match="CRAWLER_GITHUB_TOKEN") as e:
        config.parse_github_token(bad)
    assert bad.strip() not in str(e.value)
