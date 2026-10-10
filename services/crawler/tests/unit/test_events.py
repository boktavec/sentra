import pytest

from crawler import contracts, events

RUN = "2f6b6c9e-4f0a-4d57-8d0e-0c7c1f6a8a11"


@pytest.mark.parametrize("kind", ["transient", "permanent"])
def test_crawl_failed_is_v2_and_carries_the_failure_kind(kind):
    event = events.crawl_failed(RUN, "c-1", "osv", "npm", "http 503", 3, kind)
    contracts.validate("crawl.failed", event, version=2)
    assert event["version"] == 2 and event["failureKind"] == kind


def test_v2_requires_a_known_failure_kind():
    event = events.crawl_failed(RUN, "c-1", "osv", "npm", "http 503", 3, "transient")
    contracts.validate("crawl.failed", {**event, "failureKind": "transient"}, version=2)
    with pytest.raises(contracts.InvalidEvent, match="failureKind"):
        contracts.validate("crawl.failed", {**event, "failureKind": "flaky"}, version=2)
    with pytest.raises(contracts.InvalidEvent, match="failureKind"):
        contracts.validate("crawl.failed", {k: v for k, v in event.items() if k != "failureKind"}, version=2)


def test_a_v1_failure_without_a_kind_is_still_valid_v1():
    v1 = dict(events.crawl_failed(RUN, "c-1", "osv", "npm", "x", 1, "permanent"))
    del v1["failureKind"]
    v1["version"] = 1
    contracts.validate("crawl.failed", v1, version=1)
