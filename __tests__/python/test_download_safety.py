from unittest.mock import AsyncMock

import httpx
import pytest
import python_bridge
from lib.sources.models import normalize_md5

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "value", ["../escape", "/tmp/escape", "a" * 31, "z" * 32, "a" * 32 + "&key=x", None]
)
async def test_bad_md5_is_rejected_before_network_or_write(tmp_path, mocker, value):
    router = mocker.patch.object(python_bridge, "get_source_router", AsyncMock())
    with pytest.raises(ValueError, match="32 hexadecimal"):
        await python_bridge._download_url_to_file(
            "https://download.invalid/file", str(tmp_path / "out"), value
        )
    assert not (tmp_path / "out").exists()
    router.assert_not_awaited()


def test_md5_normalizes_case():
    assert normalize_md5("A" * 32) == "a" * 32


async def test_bad_book_identifier_does_not_resolve_download(tmp_path, mocker):
    router = mocker.patch.object(python_bridge, "get_source_router", AsyncMock())
    with pytest.raises(ValueError, match="32 hexadecimal"):
        await python_bridge._fetch_from_source(
            {"source": "libgen", "md5": "../escape"}, str(tmp_path)
        )
    router.assert_not_awaited()


@pytest.mark.parametrize("failure", ["interrupted", "empty", "truncated", "cancelled"])
async def test_source_failure_preserves_existing_and_cleans_temp(
    tmp_path, monkeypatch, failure
):
    import asyncio
    from lib import python_bridge as bridge

    md5 = "a" * 32
    existing = tmp_path / f"{md5}.download"
    existing.write_bytes(b"existing complete book")

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            if failure == "empty":
                return
            yield b"new prefix"
            if failure == "interrupted":
                raise httpx.ReadError("interrupted")
            if failure == "cancelled":
                raise asyncio.CancelledError()

    client_class = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, stream=Body(), headers={"Content-Length": "100"}
        )
    )
    monkeypatch.setattr(
        bridge.httpx,
        "AsyncClient",
        lambda **kw: client_class(transport=transport, **kw),
    )
    with pytest.raises((ValueError, httpx.ReadError, asyncio.CancelledError)):
        await bridge._download_url_to_file(
            "https://example.org/file", str(tmp_path), md5
        )
    assert existing.read_bytes() == b"existing complete book"
    assert list(tmp_path.iterdir()) == [existing]


def test_same_title_uses_md5_and_metadata_cannot_escape():
    from lib.filename_utils import create_unified_filename

    first = {"title": "Same Title", "md5": "a" * 32, "extension": "epub"}
    second = {**first, "md5": "b" * 32}
    assert create_unified_filename(first) != create_unified_filename(second)
    unsafe = create_unified_filename(
        {**first, "id": "../../outside", "extension": "../../pdf"},
        year="../2026",
        language="../en",
    )
    assert "/" not in unsafe and "\\" not in unsafe
