from pipeline.normalize.cvss_score import score

V3 = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
V4 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:N"


def test_scores_reference_vectors_and_prefers_v4():
    assert score([{"type": "CVSS_V3", "vector": V3}]) == (9.8, "3.1")
    assert score([{"type": "CVSS_V3", "vector": V3.replace("3.1", "3.0", 1)}]) == (9.8, "3.0")
    assert score([{"type": "CVSS_V4", "vector": V4}]) == (9.9, "4.0")
    assert score([{"type": "CVSS_V3", "vector": V3}, {"type": "CVSS_V4", "vector": V4}]) == (9.9, "4.0")


def test_invalid_newer_vector_falls_back_without_hiding_the_advisory():
    assert score([{"type": "CVSS_V4", "vector": "CVSS:4.0/AV:N"}, {"type": "CVSS_V3", "vector": V3}]) == (
        9.8,
        "3.1",
    )
    assert score([{"type": "CVSS_V4", "vector": "CVSS:4.0/AV:N"}]) == (None, None)
    assert score([]) == (None, None)
