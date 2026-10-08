import pytest

from fake_osv import FakeOSV


@pytest.fixture
def osv():
    server = FakeOSV()
    yield server
    server.close()
