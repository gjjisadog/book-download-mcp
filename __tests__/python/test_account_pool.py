"""Account selection, persistence, and bridge failover without real credentials."""

import json
import logging
import os
from unittest.mock import AsyncMock

import httpx
import pytest

from lib.account_pool import (
    Account,
    AccountAuthenticationError,
    AccountPool,
    AccountPoolExhaustedError,
    load_accounts,
)

pytestmark = pytest.mark.unit

ACCOUNTS = [
    Account("first@example.com", "private-first"),
    Account("second@example.com", "private-second"),
]


@pytest.fixture(autouse=True)
def account_env(monkeypatch, tmp_path):
    for name in ("ZLIBRARY_ACCOUNTS", "ZLIBRARY_EMAIL", "ZLIBRARY_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ZLIBRARY_ACCOUNT_STATE_FILE", str(tmp_path / "state.json"))


def configure_pool(monkeypatch):
    monkeypatch.setenv(
        "ZLIBRARY_ACCOUNTS",
        json.dumps([{"email": a.email, "password": a.password} for a in ACCOUNTS]),
    )


def client(remaining=5):
    result = AsyncMock()
    result.login.return_value = {"success": 1}
    result.get_profile.return_value = {"user": {"downloads_today_left": remaining}}
    result.remix_userid = "test-id"
    return result


def test_unconfigured_pool_keeps_legacy_mode():
    assert load_accounts() is None


def test_load_accounts_preserves_password_and_hides_credentials(monkeypatch):
    monkeypatch.setenv(
        "ZLIBRARY_ACCOUNTS", '[{"email":" first@example.com ","password":" secret "}]'
    )
    accounts = load_accounts()
    assert accounts[0].email == "first@example.com"
    assert accounts[0].password == " secret "
    assert "secret" not in repr(accounts)
    assert "first@example.com" not in repr(accounts)


@pytest.mark.parametrize(
    "raw",
    [
        "private-secret-invalid-json",
        "null",
        "{}",
        "[]",
        "[null]",
        '[{"email":true,"password":"private-secret"}]',
        '[{"email":" ","password":"private-secret"}]',
        '[{"email":"first@example.com","password":0}]',
        '[{"email":"first@example.com","password":""}]',
        '[{"email":"first@example.com","password":"private-secret"},'
        '{"email":" FIRST@example.com ","password":"private-secret"}]',
    ],
)
def test_bad_configuration_never_echoes_credentials(monkeypatch, raw):
    monkeypatch.setenv("ZLIBRARY_ACCOUNTS", raw)
    with pytest.raises(ValueError) as error:
        load_accounts()
    assert "private-secret" not in str(error.value)
    assert "first@example.com" not in str(error.value)


async def test_rejected_login_switches_and_remembers_without_secrets(tmp_path, caplog):
    state = tmp_path / "state.json"
    pool = AccountPool(ACCOUNTS, state)
    usable = client()
    factory = AsyncMock(side_effect=[AccountAuthenticationError("rejected"), usable])
    with caplog.at_level(logging.INFO):
        assert await pool.acquire(factory) is usable
    assert [call.args[0] for call in factory.await_args_list] == ACCOUNTS
    saved = json.loads(state.read_text())
    assert saved["preferred"] == 1
    for account in ACCOUNTS:
        assert account.email not in state.read_text() + caplog.text
        assert account.password not in state.read_text() + caplog.text
    if os.name == "posix":
        assert state.stat().st_mode & 0o777 == 0o600

    # A fresh instance represents the next Python subprocess or server restart.
    next_factory = AsyncMock(return_value=usable)
    await AccountPool(ACCOUNTS, state).acquire(next_factory)
    next_factory.assert_awaited_once_with(ACCOUNTS[1])


@pytest.mark.parametrize("remaining", [0, "0", -1])
async def test_download_skips_exhausted_accounts(tmp_path, remaining):
    empty, usable = client(remaining), client()
    pool = AccountPool(ACCOUNTS, tmp_path / "state.json")
    factory = AsyncMock(side_effect=[empty, usable])
    assert await pool.acquire(factory, for_download=True) is usable
    empty.close.assert_awaited_once()
    assert pool.exhausted_accounts == 1


@pytest.mark.parametrize("remaining", [None, "unknown", False])
async def test_unknown_quota_is_not_misclassified(tmp_path, remaining):
    usable = client(remaining)
    pool = AccountPool(ACCOUNTS, tmp_path / "state.json")
    factory = AsyncMock(return_value=usable)
    assert await pool.acquire(factory, for_download=True) is usable
    factory.assert_awaited_once_with(ACCOUNTS[0])


async def test_search_does_not_require_download_quota(tmp_path):
    usable = client(0)
    pool = AccountPool(ACCOUNTS, tmp_path / "state.json")
    assert await pool.acquire(AsyncMock(return_value=usable)) is usable
    usable.get_profile.assert_not_awaited()


async def test_all_unusable_accounts_fail_once_per_account(tmp_path):
    empty = client(0)
    pool = AccountPool(ACCOUNTS, tmp_path / "state.json")
    factory = AsyncMock(side_effect=[AccountAuthenticationError("rejected"), empty])
    with pytest.raises(
        AccountPoolExhaustedError, match=r"1 login\(s\) rejected, 1 download quota"
    ):
        await pool.acquire(factory, for_download=True)
    assert factory.await_count == 2
    empty.close.assert_awaited_once()


async def test_network_error_does_not_rotate(tmp_path):
    pool = AccountPool(ACCOUNTS, tmp_path / "state.json")
    factory = AsyncMock(side_effect=httpx.ConnectError("connection unavailable"))
    with pytest.raises(httpx.ConnectError):
        await pool.acquire(factory)
    factory.assert_awaited_once_with(ACCOUNTS[0])


async def test_profile_network_error_closes_client_without_rotation(tmp_path):
    unusable = client()
    unusable.get_profile.side_effect = httpx.ReadTimeout("profile timeout")
    factory = AsyncMock(return_value=unusable)
    with pytest.raises(httpx.ReadTimeout):
        await AccountPool(ACCOUNTS, tmp_path / "state.json").acquire(
            factory, for_download=True
        )
    factory.assert_awaited_once_with(ACCOUNTS[0])
    unusable.close.assert_awaited_once()


@pytest.mark.parametrize(
    "saved", ["invalid-json", "[]", '{"preferred":900}', '{"preferred":true}']
)
async def test_corrupt_or_stale_state_starts_with_first_account(tmp_path, saved):
    state = tmp_path / "state.json"
    state.write_text(saved)
    factory = AsyncMock(return_value=client())
    await AccountPool(ACCOUNTS, state).acquire(factory)
    factory.assert_awaited_once_with(ACCOUNTS[0])


async def test_changed_pool_invalidates_preference(tmp_path):
    state = tmp_path / "state.json"
    await AccountPool(ACCOUNTS, state).acquire(
        AsyncMock(side_effect=[AccountAuthenticationError(), client()])
    )
    replaced = [Account("other@example.com", "other"), ACCOUNTS[1]]
    factory = AsyncMock(return_value=client())
    await AccountPool(replaced, state).acquire(factory)
    factory.assert_awaited_once_with(replaced[0])


async def test_unwritable_state_does_not_prevent_selection(tmp_path):
    parent_file = tmp_path / "file"
    parent_file.write_text("not a directory")
    usable = client()
    assert (
        await AccountPool(ACCOUNTS, parent_file / "state.json").acquire(
            AsyncMock(return_value=usable)
        )
        is usable
    )


@pytest.fixture
def bridge(monkeypatch, mocker):
    import python_bridge

    monkeypatch.setenv("ZLIBRARY_EAPI_DOMAIN", "pinned.example")
    mocker.patch.object(python_bridge, "_account_pool", None)
    mocker.patch.object(python_bridge, "_eapi_client", None)
    mocker.patch.object(python_bridge, "_account_client_factory", None)
    return python_bridge


async def test_bridge_authentication_failure_switches(
    monkeypatch, mocker, bridge, caplog
):
    configure_pool(monkeypatch)
    rejected, usable = client(), client()
    rejected.login.return_value = {
        "success": 0,
        "error": "private-first first@example.com",
    }
    mocker.patch.object(bridge, "EAPIClient", side_effect=[rejected, usable])
    assert await bridge.initialize_eapi_client() is usable
    rejected.close.assert_awaited_once()
    usable.login.assert_awaited_once_with(ACCOUNTS[1].email, ACCOUNTS[1].password)
    assert "private-first" not in caplog.text


async def test_bridge_http_401_switches(monkeypatch, mocker, bridge):
    configure_pool(monkeypatch)
    rejected, usable = client(), client()
    request = httpx.Request("POST", "https://pinned.example/eapi/user/login")
    rejected.login.side_effect = httpx.HTTPStatusError(
        "unauthorized", request=request, response=httpx.Response(401)
    )
    mocker.patch.object(bridge, "EAPIClient", side_effect=[rejected, usable])
    assert await bridge.initialize_eapi_client() is usable
    rejected.close.assert_awaited_once()


async def test_bridge_network_login_failure_does_not_rotate(
    monkeypatch, mocker, bridge
):
    configure_pool(monkeypatch)
    failed = client()
    failed.login.side_effect = httpx.ConnectError("connection failed")
    cls = mocker.patch.object(bridge, "EAPIClient", return_value=failed)
    with pytest.raises(httpx.ConnectError):
        await bridge.initialize_eapi_client()
    cls.assert_called_once()
    failed.close.assert_awaited_once()


async def test_bridge_download_quota_change_switches(monkeypatch, mocker, bridge):
    configure_pool(monkeypatch)
    first, second = client(), client()
    first.download_file.side_effect = bridge.DownloadLimitError("quota exhausted")
    second.download_file.return_value = "/downloads/book.epub"
    mocker.patch.object(bridge, "EAPIClient", side_effect=[first, second])
    await bridge.initialize_eapi_client(for_download=True)
    assert (
        await bridge._download_eapi_book("123", "hash", "/downloads")
        == "/downloads/book.epub"
    )
    first.download_file.assert_awaited_once()
    first.close.assert_awaited_once()
    second.download_file.assert_awaited_once_with(
        book_id=123, book_hash="hash", output_dir="/downloads", temporary=True
    )


async def test_bridge_quota_rejection_is_bounded(monkeypatch, mocker, bridge):
    configure_pool(monkeypatch)
    clients = [client(), client()]
    for instance in clients:
        instance.download_file.side_effect = bridge.DownloadLimitError(
            "quota exhausted"
        )
    cls = mocker.patch.object(bridge, "EAPIClient", side_effect=clients)
    await bridge.initialize_eapi_client(for_download=True)
    with pytest.raises(AccountPoolExhaustedError, match="2 download quota"):
        await bridge._download_eapi_book("123", "hash", "/downloads")
    assert cls.call_count == 2
    for instance in clients:
        instance.download_file.assert_awaited_once()
        instance.close.assert_awaited_once()


@pytest.mark.parametrize(
    "failure",
    [httpx.ReadTimeout("download interrupted"), RuntimeError("book not found")],
)
async def test_bridge_download_failure_does_not_rotate(
    monkeypatch, mocker, bridge, failure
):
    configure_pool(monkeypatch)
    first = client()
    first.download_file.side_effect = failure
    cls = mocker.patch.object(bridge, "EAPIClient", return_value=first)
    await bridge.initialize_eapi_client(for_download=True)
    with pytest.raises(type(failure)) as error:
        await bridge._download_eapi_book("123", "hash", "/downloads")
    assert error.value is failure
    cls.assert_called_once()
    first.download_file.assert_awaited_once()


async def test_legacy_download_does_not_add_profile_check(monkeypatch, mocker, bridge):
    monkeypatch.setenv("ZLIBRARY_EMAIL", "legacy@example.com")
    monkeypatch.setenv("ZLIBRARY_PASSWORD", "legacy-private")
    usable = client()
    mocker.patch.object(bridge, "EAPIClient", return_value=usable)
    assert await bridge.initialize_eapi_client(for_download=True) is usable
    usable.login.assert_awaited_once_with("legacy@example.com", "legacy-private")
    usable.get_profile.assert_not_awaited()


async def test_legacy_rejected_login_is_sanitized(monkeypatch, mocker, bridge):
    monkeypatch.setenv("ZLIBRARY_EMAIL", "legacy@example.com")
    monkeypatch.setenv("ZLIBRARY_PASSWORD", "legacy-private")
    rejected = client()
    rejected.login.return_value = {"success": 0, "error": "legacy-private"}
    mocker.patch.object(bridge, "EAPIClient", return_value=rejected)
    with pytest.raises(AccountAuthenticationError) as error:
        await bridge.initialize_eapi_client()
    assert "legacy-private" not in str(error.value)
    rejected.close.assert_awaited_once()


async def test_source_download_does_not_initialize_pool(
    monkeypatch, mocker, bridge, capsys
):
    monkeypatch.setattr(
        "sys.argv",
        [
            "python_bridge.py",
            "download_book",
            json.dumps(
                {
                    "book_details": {"md5": "test-md5", "source": "libgen"},
                    "output_dir": "/downloads",
                }
            ),
        ],
    )
    initialize = mocker.patch.object(bridge, "initialize_eapi_client", AsyncMock())
    mocker.patch.object(
        bridge,
        "download_book",
        AsyncMock(return_value={"file_path": "/downloads/book.pdf"}),
    )
    await bridge.main()
    initialize.assert_not_awaited()
    response = json.loads(capsys.readouterr().out)
    assert (
        json.loads(response["content"][0]["text"])["file_path"] == "/downloads/book.pdf"
    )
