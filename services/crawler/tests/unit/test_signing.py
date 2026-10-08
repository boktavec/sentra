from crawler import contracts, signing

KEYS = {"k1": b"secret-one", "k2": b"secret-two"}


def request(**over):
    event = {
        "eventId": "6f0c1c3e-7a53-4a4c-9d27-0a3d2f1b8e11",
        "type": "crawl.requested",
        "version": 1,
        "timestamp": "2026-10-07T12:00:00Z",
        "correlationId": "corr-1",
        "runId": "0b6a8c1e-2c1e-4b0e-9f64-1d9a0a7a8a10",
        "source": "osv",
        "ecosystem": "npm",
        "keyId": "k1",
    }
    event.update(over)
    event["signature"] = signing.sign(event, KEYS[event["keyId"]])
    return event


def test_signed_request_verifies_and_matches_schema():
    event = request()
    assert signing.verify(event, KEYS)
    contracts.validate("crawl.requested", event)


def test_signature_ignores_key_order_but_not_content():
    event = request()
    assert signing.verify(dict(reversed(event.items())), KEYS)
    assert not signing.verify({**event, "ecosystem": "PyPI"}, KEYS)


def test_unknown_key_id_and_wrong_secret_are_rejected():
    assert not signing.verify(request(), {"other": b"secret-one"})
    assert not signing.verify(request(), {"k1": b"not-the-secret"})


def test_rotation_accepts_either_configured_key():
    assert signing.verify(request(keyId="k1"), KEYS)
    assert signing.verify(request(keyId="k2"), KEYS)


def test_schema_rejects_smuggled_url_and_bad_fields():
    for bad in ({**request(), "url": "http://evil"}, request(source="OSV!"), {**request(), "signature": "zz"}):
        try:
            contracts.validate("crawl.requested", bad)
        except contracts.InvalidEvent:
            continue
        raise AssertionError(f"accepted {bad}")


def test_unencodable_string_is_just_a_bad_signature_not_an_exception():
    # A lone surrogate is valid JSON and passes the schema, but cannot be encoded as UTF-8. A hostile
    # publisher only needs a (non-secret) configured keyId to reach canonical().
    event = {**request(), "ecosystem": "\ud800"}
    assert signing.verify(event, KEYS) is False
