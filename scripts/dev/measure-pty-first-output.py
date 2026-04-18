#!/usr/bin/env python3
import argparse
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time


def parse_args():
    parser = argparse.ArgumentParser(
        description="Measure time to first terminal output for an interactive command."
    )
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    parser.add_argument(
        "--settle-seconds",
        type=float,
        default=0.35,
        help="Stop after output has gone quiet for this long after the first byte.",
    )
    parser.add_argument(
        "--sample-bytes",
        type=int,
        default=512,
        help="Maximum number of observed bytes to keep in the sample output.",
    )
    parser.add_argument(
        "--match-regex",
        default="",
        help="Optional regex to detect a later readiness marker in the observed output.",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
      args.command = args.command[1:]
    if not args.command:
        parser.error("missing command")
    return args


def safe_decode(data):
    return data.decode("utf-8", errors="replace")


def terminate_process(proc):
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        if proc.poll() is not None:
            return
        try:
            proc.send_signal(sig)
        except ProcessLookupError:
            return
        time.sleep(0.2)


def main():
    args = parse_args()
    compiled_regex = re.compile(args.match_regex) if args.match_regex else None

    master_fd, slave_fd = pty.openpty()
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")

    start = time.monotonic()
    proc = subprocess.Popen(
        args.command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    first_byte_ms = None
    matched_ms = None
    sample_chunks = []
    total_bytes = 0
    timed_out = False
    last_output_at = None

    try:
        while True:
            now = time.monotonic()
            if now - start >= args.timeout_seconds:
                timed_out = True
                break

            if first_byte_ms is not None and last_output_at is not None:
                if now - last_output_at >= args.settle_seconds:
                    break

            wait_seconds = min(0.1, max(0.0, args.timeout_seconds - (now - start)))
            ready, _, _ = select.select([master_fd], [], [], wait_seconds)
            if master_fd in ready:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    chunk = b""

                if chunk:
                    observed_at = time.monotonic()
                    last_output_at = observed_at
                    total_bytes += len(chunk)
                    if first_byte_ms is None:
                        first_byte_ms = round((observed_at - start) * 1000.0, 3)

                    if sum(len(part) for part in sample_chunks) < args.sample_bytes:
                        remaining = args.sample_bytes - sum(len(part) for part in sample_chunks)
                        sample_chunks.append(chunk[:remaining])

                    if compiled_regex and matched_ms is None:
                        sample_text = safe_decode(b"".join(sample_chunks))
                        if compiled_regex.search(sample_text):
                            matched_ms = round((observed_at - start) * 1000.0, 3)

            if proc.poll() is not None and first_byte_ms is None:
                break
            if proc.poll() is not None and first_byte_ms is not None:
                break
    finally:
        terminate_process(proc)
        try:
            os.close(master_fd)
        except OSError:
            pass

    end = time.monotonic()
    result = {
        "command": args.command,
        "first_output_ms": first_byte_ms,
        "matched_output_ms": matched_ms,
        "total_runtime_ms": round((end - start) * 1000.0, 3),
        "bytes_observed": total_bytes,
        "timed_out": timed_out,
        "settle_seconds": args.settle_seconds,
        "timeout_seconds": args.timeout_seconds,
        "sample": safe_decode(b"".join(sample_chunks)),
        "exit_code": proc.returncode,
    }
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    sys.exit(main())
