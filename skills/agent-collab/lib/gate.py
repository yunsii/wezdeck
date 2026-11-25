#!/usr/bin/env python3
"""ticket run gate — a standalone (Mode 3) run waits for a global slot and memory.

  gate.py --id ID [--backend B] -- CMD…

`ticket run` (create --run, reply --continue, watch, the web console's 新工单)
goes through here unless a fan-out scheduler already gated it
(TICKET_PARENT_SCHEDULER). Same pool and budget as the scheduler (fanout.py):
a free slot in `.locks/slots/` (TICKET_MAX_PARALLEL, 8) and
MemAvailable − reserved − estimate ≥ TICKET_MEM_FLOOR_MB (2048), where the
reservation covers every in-flight run in any slot. While it waits it writes a
`queued` event (gate slot|mem) and a `queued` progress step on the ticket; once
through, it records its pid in the slot and execs CMD with the lock fd
inherited, so the slot is held exactly as long as the run lives.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fanout  # noqa: E402
import ticket_fs  # noqa: E402


def main(argv: list[str]) -> int:
    if "--" not in argv:
        print("usage: gate.py --id ID [--backend B] -- CMD…", file=sys.stderr)
        return 1
    cut = argv.index("--")
    opts, cmd = argv[:cut], argv[cut + 1:]
    tid = fanout.opt(opts, "--id") or ""
    backend = fanout.opt(opts, "--backend") or "claude"
    pool = int(os.environ.get("TICKET_MAX_PARALLEL", "8"))
    floor = int(os.environ.get("TICKET_MEM_FLOOR_MB", "2048"))
    tick = float(os.environ.get("TICKET_GATE_TICK", "15"))
    est = fanout.mem_estimate_mb(backend)
    t0, last = time.time(), None
    while True:
        slot = fanout.try_slot(pool)
        detail: dict[str, object] = {}
        if slot is None:
            gate = "slot"
            msg = f"queued: all {pool} run slots busy"
        else:
            avail = fanout.mem_available_mb()
            reserved = fanout.reserved_mb(est["mb"], pool, skip=slot.index)
            if avail is None or avail - reserved - est["mb"] >= floor:
                break
            slot.release()
            gate = "mem"
            detail = {"mem_available_mb": avail, "reserved_mb": reserved, "est_mb": est["mb"]}
            msg = f"queued: {avail} MB free, {reserved} MB reserved, needs ~{est['mb']} MB + {floor} MB floor"
        if gate != last:  # one row per reason change, not per tick
            fanout.event(tid, "queued", gate=gate, **detail)
            ticket_fs.write_progress(tid, "queued", msg, extra={"gate": gate, **detail})
            print(f"[ticket] progress · {msg}", file=sys.stderr, flush=True)
            last = gate
        time.sleep(tick)
    slot.claim(os.getpid())
    os.set_inheritable(slot.fh.fileno(), True)
    if last is not None:
        fanout.event(tid, "dispatched", slot=slot.index, queue_wait_ms=int((time.time() - t0) * 1000),
                     est_mb=est["mb"], mem_available_mb=fanout.mem_available_mb())
    os.environ["TICKET_RUN_GATED"] = "1"
    os.execvp(cmd[0], cmd)
    return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
