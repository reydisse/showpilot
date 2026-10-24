"""Retry Apple's ticket service only for explicit transient network failures."""
import subprocess
import time


def run_stapler(action, target):
    command = ["xcrun", "stapler", action, str(target)]
    for attempt in range(4):
        result = subprocess.run(command, text=True, capture_output=True)
        output = (result.stdout or "") + (result.stderr or "")
        print(output, end="", flush=True)
        if result.returncode == 0:
            return
        transient = result.returncode == 68 and any(marker in output for marker in (
            "NSURLErrorDomain Code=-1005",  # Connection lost.
            "NSURLErrorDomain Code=-1001",  # Request timed out.
            "NSURLErrorDomain Code=-1009",  # Network unavailable.
        ))
        if not transient or attempt == 3:
            result.check_returncode()
        delay = 5 * (2 ** attempt)
        print(f"Apple ticket service connection failed; retrying in {delay}s.", flush=True)
        time.sleep(delay)
