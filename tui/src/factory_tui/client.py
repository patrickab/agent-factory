"""The only door to the factory: `factory <action> '<json>'`, JSON on stdout, `factory: <code>: <message>` on stderr."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from typing import Any, Protocol

TIMEOUT_SECONDS = 30
ERROR_LINE = re.compile(r"^factory: ([a-z_]+): (.*)$")


class FactoryCliError(Exception):
    """A failed call: the CLI's error code (`invalid`, `not_found`, `busy`, `refused`, `failed`) and message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message

    @property
    def unknown_action(self) -> bool:
        return self.code == "invalid" and self.message.startswith("unknown action")


def parse_error(stderr: str, returncode: int) -> FactoryCliError:
    """The last `factory: <code>: <message>` line of stderr, else the whole stderr as `failed`."""
    for line in reversed(stderr.strip().splitlines()):
        match = ERROR_LINE.match(line.strip())
        if match:
            return FactoryCliError(match.group(1), match.group(2))
    return FactoryCliError("failed", stderr.strip() or f"factory exited with {returncode}")


class Client(Protocol):
    """What the app reads: the real `FactoryClient`, or a fake in tests."""

    def repos(self) -> list[str]: ...
    def tasks(self) -> list[dict]: ...
    def waves(self) -> list[dict]: ...
    def timeline(self, task_id: str) -> list[dict]: ...


def factory_binary() -> str:
    """`FACTORY_CLI` when set, else `factory` from PATH."""
    return os.environ.get("FACTORY_CLI") or shutil.which("factory") or "factory"


class FactoryClient:
    def __init__(self, binary: str | None = None) -> None:
        self.binary = binary or factory_binary()

    def call(self, action: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        command = [self.binary, action, json.dumps(params or {})]
        try:
            done = subprocess.run(command, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, check=False)
        except FileNotFoundError:
            raise FactoryCliError("failed", f"factory CLI not found: {self.binary} (set FACTORY_CLI)") from None
        except subprocess.TimeoutExpired:
            raise FactoryCliError("failed", f"{action} timed out after {TIMEOUT_SECONDS}s") from None
        if done.returncode != 0:
            raise parse_error(done.stderr, done.returncode)
        try:
            result = json.loads(done.stdout)
        except json.JSONDecodeError as error:
            raise FactoryCliError("failed", f"{action}: output is not JSON: {error}") from None
        if not isinstance(result, dict):
            raise FactoryCliError("failed", f"{action}: output is not a JSON object")
        return result

    def repos(self) -> list[str]:
        return list(self.call("repos.list").get("repos", []))

    def tasks(self) -> list[dict]:
        return list(self.call("tasks.list").get("tasks", []))

    def waves(self) -> list[dict]:
        """Every wave; none while the installed factory has no `waves.list`."""
        try:
            return list(self.call("waves.list").get("waves", []))
        except FactoryCliError as error:
            if error.unknown_action:
                return []
            raise

    def timeline(self, task_id: str) -> list[dict]:
        return list(self.call("tasks.timeline", {"id": task_id}).get("entries", []))
