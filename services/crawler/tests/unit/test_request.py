from crawler import contracts, signing
from crawler.request import build

KEYS = {"k1": b"secret-one", "k2": b"secret-two"}


def test_manual_request_is_signed_with_the_first_key_and_valid_for_kev():
    event = build("cisa-kev", "none", KEYS)
    contracts.validate("crawl.requested", event)
    assert event["keyId"] == "k1" and signing.verify(event, KEYS)
    assert (event["source"], event["ecosystem"]) == ("cisa-kev", "none")


def test_scheduler_requests_carry_the_run_id_and_correlation_id_it_recorded():
    event = build("osv", "npm", KEYS, run_id="2f6b6c9e-4f0a-4d57-8d0e-0c7c1f6a8a11", correlation_id="schedule-2f6b6c9e")
    contracts.validate("crawl.requested", event)
    assert (event["runId"], event["correlationId"]) == ("2f6b6c9e-4f0a-4d57-8d0e-0c7c1f6a8a11", "schedule-2f6b6c9e")
    assert signing.verify(event, KEYS)
