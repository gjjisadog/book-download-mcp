"""Short-lived sessions passed privately by the parent process, never stored on disk."""

import hashlib
import json
import os
import time
from lib.logging_utils import register_secrets

SESSION_TTL = 600
_sessions = {}


def account_key(account):
    return hashlib.sha256(
        json.dumps(
            [
                account.email,
                account.password,
                os.environ.get("ZLIBRARY_EAPI_DOMAIN", "").strip(),
            ],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def load_sessions():
    global _sessions
    try:
        raw = json.loads(os.environ.get("ZLIBRARY_SESSION_CACHE", "{}"))
        _sessions = {
            key: value
            for key, value in raw.items()
            if isinstance(value, dict) and valid(value)
        }
    except (ValueError, TypeError, AttributeError):
        _sessions = {}


def valid(session):
    return (
        isinstance(session.get("expires"), (int, float))
        and time.time() < session["expires"] <= time.time() + SESSION_TTL
        and all(
            isinstance(session.get(key), str) and session[key]
            for key in ("domain", "userid", "userkey")
        )
    )


def get_session(account):
    session = _sessions.get(account_key(account))
    return session if session and valid(session) else None


def forget_session(account):
    _sessions.pop(account_key(account), None)


def remember_session(account, client):
    session = {
        "domain": client.domain,
        "userid": client.remix_userid,
        "userkey": client.remix_userkey,
        "expires": time.time() + SESSION_TTL,
    }
    if valid(session):
        register_secrets(session["userid"], session["userkey"])
        _sessions[account_key(account)] = session


def export_sessions():
    return {key: value for key, value in _sessions.items() if valid(value)}
