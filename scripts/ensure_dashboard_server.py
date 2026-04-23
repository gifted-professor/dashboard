#!/usr/bin/env python3
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

PORT = int(os.environ.get("PORT", "8899"))
PROJECT_DIR = Path("/Users/a1234/Desktop/dashboard")
LOG_DIR = Path.home() / ".hermes" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "dashboard-serve.log"
LOCAL_URL = f"http://127.0.0.1:{PORT}/"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def get_local_ip() -> Optional[str]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def http_ok(url: str) -> bool:
    request = Request(url, method="HEAD")
    try:
        with urlopen(request, timeout=5) as response:
            return 200 <= response.status < 400
    except HTTPError as exc:
        return 200 <= exc.code < 400
    except (URLError, OSError):
        return False


def listener_pids() -> list[int]:
    proc = subprocess.run(
        ["lsof", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t"],
        capture_output=True,
        text=True,
        check=False,
    )
    pids: list[int] = []
    for raw in proc.stdout.splitlines():
        raw = raw.strip()
        if raw.isdigit():
            pids.append(int(raw))
    return pids


def is_pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def kill_pids(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if not pids:
        return
    deadline = time.time() + 5
    while time.time() < deadline:
        remaining = [pid for pid in pids if is_pid_running(pid)]
        if not remaining:
            return
        time.sleep(0.3)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def start_server() -> int:
    with LOG_FILE.open("ab") as log_handle:
        process = subprocess.Popen(
            ["zsh", "-ic", f"cd {shlex.quote(str(PROJECT_DIR))} && npm run serve"],
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    return process.pid


def build_result(status: str, action: str, **extra: object) -> dict[str, object]:
    local_ip = get_local_ip()
    result: dict[str, object] = {
        "status": status,
        "action": action,
        "port": PORT,
        "local_url": LOCAL_URL,
        "external_url": f"http://{local_ip}:{PORT}/" if local_ip else None,
        "log_file": str(LOG_FILE),
        "checked_at": now_iso(),
    }
    result.update(extra)
    return result


def main() -> int:
    initial_pids = listener_pids()
    if http_ok(LOCAL_URL):
        print(json.dumps(build_result("ok", "already_running", listener_pids=initial_pids), ensure_ascii=False, indent=2))
        return 0

    had_listener = bool(initial_pids)
    if had_listener:
        kill_pids(initial_pids)
        time.sleep(1)

    new_pid = start_server()
    for _ in range(12):
        time.sleep(1)
        if http_ok(LOCAL_URL):
            action = "restarted" if had_listener else "started"
            print(json.dumps(build_result("ok", action, previous_listener_pids=initial_pids, started_pid=new_pid, listener_pids=listener_pids()), ensure_ascii=False, indent=2))
            return 0

    print(json.dumps(build_result("error", "start_failed", previous_listener_pids=initial_pids, started_pid=new_pid, listener_pids=listener_pids()), ensure_ascii=False, indent=2))
    return 1


if __name__ == "__main__":
    sys.exit(main())
