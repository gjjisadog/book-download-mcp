"""Shared logging policy and redaction for diagnostics crossing the bridge."""

import json
import logging
import os
import re
from urllib.parse import quote, quote_plus

_QUERY_SECRET = re.compile(
    r"([?&](?:key|token|password|secret|remix_userkey|remix_userid|q|query|req|message)=)[^&\s\"']*",
    re.I,
)


_runtime_secrets = set()


def register_secrets(*values):
    _runtime_secrets.update(
        value for value in values if isinstance(value, str) and value
    )


def redact(text, *extra_secrets):
    text = str(text)
    secrets = list(extra_secrets) + list(_runtime_secrets)
    for name in ("ANNAS_SECRET_KEY", "ZLIBRARY_PASSWORD", "ZLIBRARY_EMAIL"):
        secrets.append(os.environ.get(name, ""))
    try:
        for account in json.loads(os.environ.get("ZLIBRARY_ACCOUNTS", "[]")):
            if isinstance(account, dict):
                secrets.extend([account.get("email"), account.get("password")])
    except (ValueError, TypeError):
        pass
    try:
        for session in json.loads(
            os.environ.get("ZLIBRARY_SESSION_CACHE", "{}")
        ).values():
            secrets.extend([session.get("userid"), session.get("userkey")])
    except (ValueError, TypeError, AttributeError):
        pass
    for secret in sorted(
        {s for s in secrets if isinstance(s, str) and s}, key=len, reverse=True
    ):
        for value in {secret, quote(secret, safe=""), quote_plus(secret)}:
            text = text.replace(value, "[redacted]")
    return _QUERY_SECRET.sub(r"\1[redacted]", text)


class RedactionFilter(logging.Filter):
    def filter(self, record):
        record.msg = redact(record.getMessage())
        record.args = ()
        return True


class RedactingFormatter(logging.Formatter):
    def format(self, record):
        return redact(super().format(record))


def configure_logging(debug=False):
    levels = {
        "silent": logging.CRITICAL + 1,
        "error": logging.ERROR,
        "warn": logging.WARNING,
        "info": logging.INFO,
        "debug": logging.DEBUG,
    }
    level = levels.get(
        os.environ.get("LOG_LEVEL", "").lower(),
        logging.DEBUG if debug else logging.INFO,
    )
    root = logging.getLogger()
    if not root.handlers:
        root.addHandler(logging.StreamHandler())
    root.setLevel(level)
    app = logging.getLogger("zlibrary")
    app.setLevel(level)
    for handler in root.handlers + app.handlers:
        handler.setLevel(level)
        handler.setFormatter(RedactingFormatter("%(levelname)s %(name)s: %(message)s"))


# Filters run before propagation, including external capture handlers.
for _name in ("httpx", "httpcore", "zlibrary", "zlibrary.sources"):
    logging.getLogger(_name).addFilter(RedactionFilter())
