#!/usr/bin/env python3
"""Run a command on a PTY while stripping terminal focus reports from stdin.

tmux with `focus-events on` injects CSI FocusIn (`\\x1b[I`) and FocusOut
(`\\x1b[O`) into the pane's input when the pane gains or loses focus. Grok
Build's TUI treats FocusGained as a cue to repaint a large region of the
conversation surface; under WezTerm + tmux that full-content redraw flashes
visibly (whole transcript, not just a background tint).

This relay keeps the outer session's `focus-events` enabled (Vim / Claude /
attention hooks still need them) while Grok never sees the focus CSI. Bare Esc
is never held — only an incomplete ``ESC [`` prefix waits for its final byte
(see `_strip_focus`).

Usage:
  grok-focus-filter.py [--] grok [args...]
  GROK_REAL_BIN=~/.grok/bin/grok grok-focus-filter.py --resume <id>

Env:
  GROK_FOCUS_FILTER=0  — disable stripping (pass-through relay still runs)
"""
from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import tty

FOCUS_IN = b"\x1b[I"
FOCUS_OUT = b"\x1b[O"


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def _get_winsize(fd: int) -> tuple[int, int]:
    try:
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\x00" * 8))
        return int(rows), int(cols)
    except OSError:
        return 24, 80


def _strip_focus(buf: bytearray, enabled: bool) -> bytes:
    """Remove FocusIn/Out CSI from *buf*, leaving at most an incomplete prefix.

    Hold policy (deliberate — do not "improve" by buffering a bare Esc):

    - A lone ``ESC`` is forwarded immediately. Holding it made Grok's
      ``/settings`` need several Esc presses to close, and left a pending Esc
      that made the next ``/`` appear to need two presses. Bare Esc is not a
      Focus CSI prefix until ``[`` also arrives.
    - Only an incomplete ``ESC [`` suffix is held (one more byte decides
      ``I``/``O`` vs other CSI). tmux FocusIn/Out is almost always one 3-byte
      write; a pathological split that starts with a lone Esc would forward
      Esc and then ``[I``/``[O`` as ordinary input (Focus CSI not recognized
      across that split) — far cheaper than breaking every Esc keypress.
    """
    if not enabled or not buf:
        out = bytes(buf)
        buf.clear()
        return out

    out = bytearray()
    i = 0
    n = len(buf)
    while i < n:
        if buf[i] != 0x1B:
            out.append(buf[i])
            i += 1
            continue

        # Bare ESC at end of chunk → forward now (never hold lone Esc).
        if i + 1 >= n:
            out.append(buf[i])
            i += 1
            break

        # ESC not followed by '[' → Esc / meta lead-in; forward Esc only.
        if buf[i + 1] != ord("["):
            out.append(buf[i])
            i += 1
            continue

        # Incomplete "ESC [" → hold for the deciding final byte.
        if i + 2 >= n:
            break

        # FocusIn / FocusOut → drop the three-byte CSI.
        if buf[i + 2] in (ord("I"), ord("O")):
            i += 3
            continue

        # Other CSI (arrows, etc.): forward Esc and continue; the loop emits
        # '[' and the final byte on later iterations so the sequence stays intact.
        out.append(buf[i])
        i += 1

    del buf[:i]
    return bytes(out)


def main(argv: list[str]) -> int:
    args = argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print(
            "usage: grok-focus-filter.py [--] <command> [args...]",
            file=sys.stderr,
        )
        return 2

    filter_on = os.environ.get("GROK_FOCUS_FILTER", "1") not in ("0", "false", "off", "no")

    if not sys.stdin.isatty() or not sys.stdout.isatty():
        # Non-interactive: no focus CSI expected; avoid PTY overhead.
        os.execvp(args[0], args)

    pid, master = pty.fork()
    if pid == 0:
        os.execvp(args[0], args)
        raise SystemExit(127)

    rows, cols = _get_winsize(sys.stdin.fileno())
    _set_winsize(master, rows, cols)

    old = termios.tcgetattr(sys.stdin.fileno())
    tty.setraw(sys.stdin.fileno())

    def on_winch(_signum: int, _frame: object) -> None:
        r, c = _get_winsize(sys.stdin.fileno())
        _set_winsize(master, r, c)
        try:
            os.kill(pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGWINCH, on_winch)

    stdin_pending: bytearray = bytearray()
    status = 0
    try:
        while True:
            try:
                readable, _, _ = select.select([sys.stdin, master], [], [])
            except (InterruptedError, select.error) as exc:
                if getattr(exc, "args", [None])[0] == errno.EINTR:
                    continue
                raise

            if sys.stdin in readable:
                try:
                    chunk = os.read(sys.stdin.fileno(), 8192)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if not chunk:
                    break
                stdin_pending.extend(chunk)
                cleaned = _strip_focus(stdin_pending, filter_on)
                if cleaned:
                    os.write(master, cleaned)

            if master in readable:
                try:
                    chunk = os.read(master, 8192)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if not chunk:
                    break
                os.write(sys.stdout.fileno(), chunk)
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)
        try:
            os.close(master)
        except OSError:
            pass
        try:
            _, wait_status = os.waitpid(pid, 0)
            if os.WIFEXITED(wait_status):
                status = os.WEXITSTATUS(wait_status)
            elif os.WIFSIGNALED(wait_status):
                status = 128 + os.WTERMSIG(wait_status)
        except ChildProcessError:
            pass

    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
