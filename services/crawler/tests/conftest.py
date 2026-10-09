import pytest

from fake_github import FakeGitHub
from fake_osv import FakeOSV


@pytest.fixture
def osv():
    server = FakeOSV()
    yield server
    server.close()


@pytest.fixture
def github():
    server = FakeGitHub()
    yield server
    server.close()
