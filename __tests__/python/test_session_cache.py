import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from lib import session_cache as cache
from lib.account_pool import Account
import python_bridge as bridge

pytestmark = pytest.mark.unit
ACCOUNT = Account("test@example.com", "private-password")


def session():
    return {
        "domain": "pinned.example",
        "userid": "test-id",
        "userkey": "private-key",
        "expires": time.time() + 590,
    }


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setenv("ZLIBRARY_EAPI_DOMAIN", "pinned.example")
    monkeypatch.delenv("ZLIBRARY_SESSION_CACHE", raising=False)
    cache.load_sessions()


def test_expired_and_malformed_sessions_are_discarded(monkeypatch):
    for raw in ["bad json", "[]", json.dumps({"a": {**session(), "expires": 0}})]:
        monkeypatch.setenv("ZLIBRARY_SESSION_CACHE", raw)
        cache.load_sessions()
        assert not cache.export_sessions()


def test_password_domain_changes_invalidate_and_tokens_do_not_extend_ttl(monkeypatch):
    client = SimpleNamespace(
        domain="pinned.example", remix_userid="id", remix_userkey="key"
    )
    cache.remember_session(ACCOUNT, client)
    saved = cache.get_session(ACCOUNT)
    assert saved and cache.get_session(Account(ACCOUNT.email, "different")) is None
    monkeypatch.setenv("ZLIBRARY_EAPI_DOMAIN", "different.example")
    assert cache.get_session(ACCOUNT) is None
    monkeypatch.setenv("ZLIBRARY_EAPI_DOMAIN", "pinned.example")
    saved["expires"] = 0
    assert cache.get_session(ACCOUNT) is None


async def test_cached_session_skips_login_and_domain_discovery(mocker):
    cache._sessions = {cache.account_key(ACCOUNT): session()}
    client = SimpleNamespace(
        get_profile=AsyncMock(return_value={"success": 1}),
        close=AsyncMock(),
        login=AsyncMock(),
    )
    cls = mocker.patch.object(bridge, "EAPIClient", return_value=client)
    result = await bridge._authenticate_account(ACCOUNT, "pinned.example", True)
    assert result is client
    client.login.assert_not_called()
    cls.assert_called_once_with(
        "pinned.example", remix_userid="test-id", remix_userkey="private-key"
    )


async def test_invalid_session_reauthenticates_once(mocker):
    cache._sessions = {cache.account_key(ACCOUNT): session()}
    stale = SimpleNamespace(
        get_profile=AsyncMock(return_value={"success": 0}), close=AsyncMock()
    )
    fresh = SimpleNamespace(
        domain="pinned.example",
        remix_userid="id",
        remix_userkey="new-key",
        login=AsyncMock(return_value={"success": 1}),
        close=AsyncMock(),
    )
    mocker.patch.object(bridge, "EAPIClient", side_effect=[stale, fresh])
    assert await bridge._authenticate_account(ACCOUNT, "pinned.example", True) is fresh
    stale.close.assert_awaited_once()
    fresh.login.assert_awaited_once_with(ACCOUNT.email, ACCOUNT.password)
    assert cache.get_session(ACCOUNT)["userkey"] == "new-key"
