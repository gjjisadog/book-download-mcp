"""Machine-readable bridge failures; never infer retries from user text."""

import httpx
from lib.account_pool import AccountAuthenticationError, AccountPoolExhaustedError
from zlibrary.eapi import DownloadLimitError
from lib.logging_utils import redact


def error_record(error):
    code = "PYTHON_ERROR"
    if isinstance(error, AccountAuthenticationError):
        code = "AUTH_ERROR"
    elif isinstance(error, AccountPoolExhaustedError):
        code = "ACCOUNT_POOL_EXHAUSTED"
    elif isinstance(error, DownloadLimitError):
        code = "QUOTA_EXHAUSTED"
    elif isinstance(error, httpx.TimeoutException):
        code = "TIMEOUT"
    elif isinstance(error, httpx.RequestError):
        code = "NETWORK_ERROR"
    elif isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        code = (
            "AUTH_ERROR"
            if status in (401, 403)
            else "RATE_LIMITED"
            if status == 429
            else "SERVER_ERROR"
            if status >= 500
            else "INVALID_INPUT"
        )
    elif isinstance(error, (ValueError, TypeError, KeyError)):
        code = "INVALID_INPUT"
    elif isinstance(error, FileNotFoundError):
        code = "NOT_FOUND"
    return {
        "error": redact(str(error)),
        "type": type(error).__name__,
        "code": code,
        "retryable": code
        in ("TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR", "RATE_LIMITED"),
    }
