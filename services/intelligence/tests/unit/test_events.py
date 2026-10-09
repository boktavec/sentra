from copy import deepcopy

from intelligence.events import valid_requested

EVENT = {
    "eventId": "9f3227da-7417-4e2f-9ee0-bddcb860fdc2",
    "type": "investigation.requested",
    "version": 1,
    "timestamp": "2026-10-08T12:00:00Z",
    "correlationId": "request-1",
    "investigationId": "a75d5fd1-4484-4c0d-af70-fb40f7a56a60",
    "orgId": "d26a9420-a199-4b92-b926-703114ece608",
    "projectId": "3945de53-e877-44d1-ae2d-763106899dae",
}


def test_requested_envelope_accepts_contract() -> None:
    assert valid_requested(EVENT)


def test_requested_envelope_rejects_poisoned_data() -> None:
    for key, value in (
        ("type", "sbom.uploaded"),
        ("version", 2),
        ("orgId", "not-a-uuid"),
        ("correlationId", "secret\nline"),
        ("timestamp", "yesterday"),
    ):
        changed = deepcopy(EVENT)
        changed[key] = value
        assert not valid_requested(changed)
    missing = deepcopy(EVENT)
    del missing["projectId"]
    assert not valid_requested(missing)
