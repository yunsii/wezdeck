#!/usr/bin/env python3
"""Analyze a web-frame-probe run: DOM samples (every animation frame) and
painted frames (pixels). Prints findings, writes summary.json, exits 1 when
a switch flashed.

  analyze.py OUT_DIR --scenario sessions|tickets [--region L,R]

Checks, per press (marks in samples.json):
  loading    a frame titled Loading… / 加载中 (the pane collapsed)
  transition a view transition ran (the pane faded through)
  sticky     the sticky prompt showed within 800 ms of the press
  row-fill   the open row painted a saturated background or an opaque
             box-shadow wider than the 3 px bar (the solid-blue flash)
  landing    sessions: the first frame of the new item is not at its
             bottom; tickets: not at its top
  pixels     painted frames whose accent-coloured area in the list
             column (default x 17%..44%) jumps far above the run's median
"""
from __future__ import annotations

import argparse
import colorsys
import glob
import json
import os
import re
import statistics
import sys

RGB = re.compile(r"rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)")


def saturated(css: str) -> bool:
    m = RGB.search(css or "")
    if not m:
        return False
    r, g, b = (int(m.group(i)) / 255 for i in (1, 2, 3))
    a = float(m.group(4)) if m.group(4) else 1.0
    _h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return a > 0.5 and s > 0.45 and v > 0.4


def wide_opaque_shadow(css: str) -> bool:
    if not css or css == "none":
        return False
    for part in re.split(r",\s*(?=rgb)", css):
        m = RGB.search(part)
        if not m or (m.group(4) and float(m.group(4)) < 0.3):
            continue
        sizes = [float(x) for x in re.findall(r"(-?[\d.]+)px", part)]
        if any(abs(x) > 3.5 for x in sizes):
            return True
    return False


def accent_count(path: str, region: tuple[float, float]) -> int:
    from PIL import Image  # only for the pixel pass

    im = Image.open(path).convert("RGB")
    w, h = im.size
    crop = im.crop((int(w * region[0]), 0, int(w * region[1]), h)).resize((120, 300))
    data = crop.get_flattened_data() if hasattr(crop, "get_flattened_data") else crop.getdata()
    return sum(1 for p in data if p[2] > 180 and p[0] < 110 and p[1] < 170 and p[2] - p[0] > 90)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--scenario", required=True, choices=["sessions", "tickets"])
    ap.add_argument("--region", default="0.17,0.44")
    args = ap.parse_args()
    region = tuple(float(x) for x in args.region.split(","))
    samples = json.load(open(os.path.join(args.out, "samples.json")))
    frames, marks = samples["frames"], samples["marks"]
    findings: list[dict] = []

    def add(kind: str, mark: int, t: int, detail: str) -> None:
        findings.append({"kind": kind, "press": mark, "t": t, "detail": detail})

    for i, mark in enumerate(marks):
        t0 = mark["t"]
        t1 = marks[i + 1]["t"] if i + 1 < len(marks) else 10**9
        window = [f for f in frames if t0 <= f["t"] < t1]
        if not window:
            continue
        before = window[0]["title"]
        for f in window:
            if f["loading"]:
                add("loading", i, f["t"], f["title"])
                break
        if window[-1]["vt"] > window[0]["vt"] or (i == 0 and window[-1]["vt"] > 0):
            add("transition", i, window[-1]["t"], f"{window[-1]['vt']} view transition(s)")
        for f in window:
            if f["sticky"] and f["t"] - t0 < 800:
                add("sticky", i, f["t"], "sticky prompt shown during the switch")
                break
        for f in window:
            if saturated(f["rowBg"]) or wide_opaque_shadow(f["rowShadow"]):
                add("row-fill", i, f["t"], f"bg={f['rowBg']} shadow={f['rowShadow']}")
                break
        new = next((f for f in window if f["title"] and f["title"] != before and not f["loading"]), None)
        if new:
            if args.scenario == "sessions" and new["bottom"] - new["scroll"] > 4:
                add("landing", i, new["t"], f"first frame {new['bottom'] - new['scroll']}px above the bottom")
            if args.scenario == "tickets" and new["scroll"] > 0:
                add("landing", i, new["t"], f"first frame at scroll {new['scroll']}, not the top")

    pix = []
    try:
        for path in sorted(glob.glob(os.path.join(args.out, "frames", "*.jpg"))):
            pix.append((os.path.basename(path), accent_count(path, region)))
    except ImportError:
        print("pixels: skipped (python3 -m pip install pillow)")
    if pix:
        base = statistics.median(c for _p, c in pix)
        limit = base * 4 + 400
        hot = [(p, c) for p, c in pix if c > limit]
        for p, c in hot[:20]:
            add("pixels", -1, -1, f"{p}: {c} accent px (median {base:.0f})")

    summary = {
        "scenario": args.scenario,
        "presses": len(marks),
        "dom_frames": len(frames),
        "painted_frames": len(pix),
        "accent_median": statistics.median(c for _p, c in pix) if pix else None,
        "accent_max": max((c for _p, c in pix), default=None),
        "findings": findings,
    }
    json.dump(summary, open(os.path.join(args.out, "summary.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{args.scenario}: {len(marks)} presses, {len(frames)} DOM frames, {len(pix)} painted frames,"
          f" accent px median {summary['accent_median']} max {summary['accent_max']}")
    for f in findings:
        print(f"  FLASH {f['kind']:10} press {f['press']} t={f['t']}ms  {f['detail']}")
    print("  no flash" if not findings else f"  {len(findings)} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
