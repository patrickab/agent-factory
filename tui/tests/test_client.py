import json
import stat
import subprocess

import pytest

from factory_tui.client import FactoryClient, FactoryCliError, parse_error


def fake_cli(tmp_path, script: str):
    """A fake `factory` executable: a python script that sees argv and writes its answer."""
    path = tmp_path / "factory"
    path.write_text(
        "#!/usr/bin/env python3\nimport json, sys\n"
        "assert sys.argv[3:] == ['--json'], sys.argv  # the full view, never the agent text\n"
        f"action, params = sys.argv[1], json.loads(sys.argv[2])\n{script}\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_call_passes_action_and_json_and_reads_stdout(tmp_path):
    binary = fake_cli(tmp_path, "print(json.dumps({'action': action, 'params': params, 'rest': sys.argv[3:]}))")
    # `--json`: the CLI prints the full view, not the agent view.
    assert FactoryClient(binary).call("tasks.timeline", {"id": "abc"}) == {
        "action": "tasks.timeline",
        "params": {"id": "abc"},
        "rest": ["--json"],
    }


def test_error_line_becomes_code_and_message(tmp_path):
    binary = fake_cli(tmp_path, "sys.stderr.write('factory: not_found: no task abc\\n'); sys.exit(1)")
    with pytest.raises(FactoryCliError) as raised:
        FactoryClient(binary).call("tasks.get", {"id": "abc"})
    assert (raised.value.code, raised.value.message) == ("not_found", "no task abc")
    assert not raised.value.unknown_action


def test_unknown_waves_list_means_no_waves(tmp_path):
    binary = fake_cli(tmp_path, "sys.stderr.write('factory: invalid: unknown action \"waves.list\"\\n'); sys.exit(2)")
    assert FactoryClient(binary).waves() == []


def test_other_waves_list_errors_are_raised(tmp_path):
    binary = fake_cli(tmp_path, "sys.stderr.write('factory: failed: disk on fire\\n'); sys.exit(1)")
    with pytest.raises(FactoryCliError, match="disk on fire"):
        FactoryClient(binary).waves()


def test_stderr_without_error_line_is_failed():
    error = parse_error("Traceback\nboom\n", 3)
    assert (error.code, error.message) == ("failed", "Traceback\nboom")
    assert parse_error("", 3).message == "factory exited with 3"


def test_non_json_output_and_missing_binary(tmp_path):
    with pytest.raises(FactoryCliError, match="not JSON"):
        FactoryClient(fake_cli(tmp_path, "print('hello')")).call("repos.list")
    with pytest.raises(FactoryCliError, match="not found"):
        FactoryClient(str(tmp_path / "missing")).call("repos.list")


def test_binary_from_env(monkeypatch, tmp_path):
    binary = fake_cli(tmp_path, "print(json.dumps({'repos': ['/r']}))")
    monkeypatch.setenv("FACTORY_CLI", binary)
    assert FactoryClient().repos() == ["/r"]
    assert json.loads(json.dumps(FactoryClient().binary)) == binary


def test_fake_cli_refuses_a_call_without_json(tmp_path):
    binary = fake_cli(tmp_path, "print(json.dumps({}))")
    done = subprocess.run([binary, "repos.list", "{}"], capture_output=True, text=True, check=False)
    assert done.returncode != 0 and "AssertionError" in done.stderr


def test_cli_that_cannot_start_is_a_cli_error(tmp_path):
    binary = tmp_path / "factory"
    binary.write_text("#!/bin/sh\n")  # not executable: PermissionError, an OSError
    with pytest.raises(FactoryCliError) as raised:
        FactoryClient(str(binary)).call("repos.list")
    assert raised.value.code == "failed" and "cannot start" in raised.value.message
    with pytest.raises(FactoryCliError, match="cannot start"):
        FactoryClient(str(tmp_path)).call("repos.list")  # a directory


def test_list_of_wrong_shape_is_a_cli_error(tmp_path):
    binary = fake_cli(tmp_path, "print(json.dumps({'waves': 7}))")
    with pytest.raises(FactoryCliError, match="waves is not a list"):
        FactoryClient(binary).waves()
