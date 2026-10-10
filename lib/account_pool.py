"""User-configured accounts with bounded failover and a persistent preference."""

import hashlib
import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("zlibrary")


class AccountAuthenticationError(RuntimeError):
    """The server explicitly rejected an account's login."""


class AccountPoolExhaustedError(RuntimeError):
    """Every configured account was rejected or has no download quota."""


@dataclass(frozen=True)
class Account:
    email: str = field(repr=False)
    password: str = field(repr=False)


def load_accounts():
    """Return the configured pool, or None to retain legacy single-account mode."""
    raw = os.environ.get("ZLIBRARY_ACCOUNTS", "").strip()
    if not raw:
        return None
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("ZLIBRARY_ACCOUNTS must be a JSON array of accounts") from None
    if not isinstance(entries, list) or not entries:
        raise ValueError("ZLIBRARY_ACCOUNTS must be a non-empty JSON array")

    accounts = []
    seen = set()
    for index, entry in enumerate(entries, start=1):
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("email"), str)
            or not entry["email"].strip()
            or not isinstance(entry.get("password"), str)
            or not entry["password"]
        ):
            raise ValueError(
                f"ZLIBRARY_ACCOUNTS account #{index} requires non-empty email and password strings"
            )
        email = entry["email"].strip()
        if email.lower() in seen:
            raise ValueError(f"ZLIBRARY_ACCOUNTS account #{index} duplicates an email")
        seen.add(email.lower())
        accounts.append(Account(email, entry["password"]))
    return accounts


def quota_exhausted(profile):
    """Only a known zero/negative quota triggers switching; unknown is allowed."""
    user = profile.get("user", profile)
    remaining = user.get("downloads_today_left")
    if remaining is None or isinstance(remaining, bool):
        return False
    try:
        return float(remaining) <= 0
    except (TypeError, ValueError):
        return False


class AccountPool:
    def __init__(self, accounts, state_path):
        self.accounts = accounts
        self.state_path = Path(state_path)
        # A reordered/replaced list must not inherit another pool's preference.
        self.fingerprint = hashlib.sha256(
            json.dumps([a.email.lower() for a in accounts]).encode()
        ).hexdigest()
        preferred = 0
        try:
            state = json.loads(self.state_path.read_text())
            index = state.get("preferred")
            if (
                state.get("pool") == self.fingerprint
                and type(index) is int
                and 0 <= index < len(accounts)
            ):
                preferred = index
        except (OSError, ValueError, AttributeError):
            pass
        self.pending = list(range(preferred, len(accounts))) + list(range(preferred))
        self.authentication_failures = 0
        self.exhausted_accounts = 0

    def _remember(self, index):
        temporary_path = None
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_path = tempfile.mkstemp(dir=self.state_path.parent)
            with os.fdopen(fd, "w") as handle:
                json.dump({"pool": self.fingerprint, "preferred": index}, handle)
            os.replace(temporary_path, self.state_path)
        except OSError:
            logger.warning("Cannot save account preference; next call will reselect an account")
        finally:
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    async def acquire(self, create_client, *, for_download=False):
        """Try each account once; network errors propagate without rotating."""
        while self.pending:
            index = self.pending.pop(0)
            try:
                client = await create_client(self.accounts[index])
            except AccountAuthenticationError:
                self.authentication_failures += 1
                logger.warning("Account #%s login rejected; trying next account", index + 1)
                continue
            if for_download:
                try:
                    exhausted = quota_exhausted(await client.get_profile())
                except BaseException:
                    await client.close()
                    raise
                if exhausted:
                    self.exhausted_accounts += 1
                    await client.close()
                    logger.info("Account #%s download quota exhausted; trying next account", index + 1)
                    continue
            self._remember(index)
            return client
        raise AccountPoolExhaustedError(
            "No usable Z-Library accounts: "
            f"{self.authentication_failures} login(s) rejected, "
            f"{self.exhausted_accounts} download quota(s) exhausted. "
            "Update ZLIBRARY_ACCOUNTS or wait for the download quota to reset."
        )
