import logging

import pytest

from crawler import scheduler


def test_kill_switch_exits_cleanly_without_touching_the_database_or_the_broker(monkeypatch, caplog):
    for name in ("SCHEDULER_DATABASE_URL", "CRAWLER_SIGNING_KEYS", "SCHEDULER_CONFIG"):
        monkeypatch.delenv(name, raising=False)  # a disabled scheduler needs no configuration at all
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    monkeypatch.setattr(scheduler, "Producer", None)  # would raise if the broker client were created
    with caplog.at_level(logging.INFO, logger="crawler"):
        assert scheduler.main() == 0
    assert "disabled" in caplog.text


def test_an_enabled_scheduler_without_configuration_fails_loudly(monkeypatch):
    monkeypatch.setenv("SCHEDULER_ENABLED", "true")
    monkeypatch.delenv("SCHEDULER_DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="SCHEDULER_DATABASE_URL"):
        scheduler.main()
