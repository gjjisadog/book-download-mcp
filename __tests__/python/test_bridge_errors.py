import httpx
import pytest
from lib.bridge_errors import error_record
from lib.account_pool import AccountAuthenticationError, AccountPoolExhaustedError
from zlibrary.eapi import DownloadLimitError

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "error,code,retryable",
    [
        (ValueError("computer network"), "INVALID_INPUT", False),
        (AccountAuthenticationError("login rejected"), "AUTH_ERROR", False),
        (AccountPoolExhaustedError("all depleted"), "ACCOUNT_POOL_EXHAUSTED", False),
        (DownloadLimitError("quota"), "QUOTA_EXHAUSTED", False),
        (httpx.ReadTimeout("slow"), "TIMEOUT", True),
        (httpx.ConnectError("network"), "NETWORK_ERROR", True),
        (FileNotFoundError("missing"), "NOT_FOUND", False),
        (RuntimeError("network in a book title"), "PYTHON_ERROR", False),
    ],
)
def test_error_classification_is_independent_of_text(error, code, retryable):
    result = error_record(error)
    assert result["code"] == code and result["retryable"] is retryable


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (401, "AUTH_ERROR", False),
        (403, "AUTH_ERROR", False),
        (429, "RATE_LIMITED", True),
        (503, "SERVER_ERROR", True),
        (404, "INVALID_INPUT", False),
    ],
)
def test_http_errors_are_classified_by_status(status, code, retryable):
    request = httpx.Request("GET", "https://example.org/?key=private")
    error = httpx.HTTPStatusError(
        "failed https://example.org/?key=private",
        request=request,
        response=httpx.Response(status),
    )
    result = error_record(error)
    assert result["code"] == code and result["retryable"] is retryable
    assert "private" not in result["error"]
