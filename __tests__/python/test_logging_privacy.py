import logging
import httpx
import pytest

from lib.logging_utils import configure_logging, redact
from lib.sources.annas import AnnasArchiveAdapter
from lib.sources.config import SourceConfig

pytestmark = pytest.mark.unit


def test_redacts_encoded_credentials_and_query_parameters(monkeypatch):
    monkeypatch.setenv(
        "ZLIBRARY_ACCOUNTS", '[{"email":"private@example.com","password":"a+b secret"}]'
    )
    message = redact(
        "private@example.com password=a+b secret https://x/?key=test-key&q=private-query"
    )
    assert "private@example.com" not in message
    assert "a+b secret" not in message
    assert "test-key" not in message
    assert "private-query" not in message
    assert "a%2Bb%20secret" not in redact("https://x/?password=a%2Bb%20secret")


async def test_http_logs_and_exception_do_not_expose_anna_key(caplog):
    key = "audit-only-secret-key"
    adapter = AnnasArchiveAdapter(SourceConfig(annas_secret_key=key))
    adapter._client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(503, request=request)
        ),
        trust_env=False,
    )
    try:
        with caplog.at_level(logging.INFO):
            with pytest.raises(httpx.HTTPStatusError) as error:
                await adapter.get_download_url("a" * 32)
        assert key not in str(error.value)
        assert key not in caplog.text
        assert "[redacted]" in str(error.value)
    finally:
        await adapter.close()


def test_python_respects_silent_log_level(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "silent")
    root, app = logging.getLogger(), logging.getLogger("zlibrary")
    saved = [(logger, logger.level) for logger in (root, app)]
    saved_handlers = [(h, h.level, h.formatter) for h in root.handlers + app.handlers]
    try:
        configure_logging(debug=True)
        assert not app.isEnabledFor(logging.ERROR)
    finally:
        for logger, level in saved:
            logger.setLevel(level)
        for handler, level, formatter in saved_handlers:
            handler.setLevel(level)
            handler.setFormatter(formatter)
