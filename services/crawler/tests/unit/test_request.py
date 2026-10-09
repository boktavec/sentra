from crawler import contracts, signing
from crawler.request import build

KEYS = {"k1": b"secret-one", "k2": b"secret-two"}


def test_manual_request_is_signed_with_the_first_key_and_valid_for_kev():
    event = build("cisa-kev", "none", KEYS)
    contracts.validate("crawl.requested", event)
    assert event["keyId"] == "k1" and signing.verify(event, KEYS)
    assert (event["source"], event["ecosystem"]) == ("cisa-kev", "none")
