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
  grey-step  the pressed row showed a dark press veil (white → grey → blue)
  snap       the pressed row's fill (over white) moved > 20 (sum of RGB)
             between two sampled frames, or its tint layer's opacity > 0.035
             between two adjacent ones, instead of easing
Warning (not a flash): jank — the main thread skipped > 50 ms of frames after
a press (opacity / transform transitions still run on the compositor).
  glide      sessions: after the switch, two or more painted frames in a row
             not at the bottom (a scroll animation to the bottom)
  landing    sessions: the first frame of the new item is not at its
             bottom; tickets: not at its top
  pixels     painted frames whose accent-coloured area in the list
             column (default x 17%..44%) jumps far above the run's median
  blank      sessions: a painted frame whose pane (x 47%..100%, between
             header and composer) is flat — no text: a switch that cut the
             thread off at a stale height, or a fade starting at opacity 0
             (2026-11-25)
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
SRGB = re.compile(r"color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: / ([\d.]+))?\)")


def rgba(css: str) -> tuple[float, float, float, float] | None:
    """0..255 channels + alpha from rgb()/rgba()/color(srgb …) (color-mix)."""
    m = RGB.search(css or "")
    if m:
        return (*(float(m.group(i)) for i in (1, 2, 3)), float(m.group(4) or 1))
    m = SRGB.search(css or "")
    if m:
        return (*(float(m.group(i)) * 255 for i in (1, 2, 3)), float(m.group(4) or 1))
    return None


def saturated(css: str) -> bool:
    c = rgba(css)
    if not c:
        return False
    r, g, b = (x / 255 for x in c[:3])
    a = c[3]
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


def pane_flat(path: str) -> bool:
    from PIL import Image, ImageStat  # only for the pixel pass

    im = Image.open(path).convert("L")
    w, h = im.size
    return ImageStat.Stat(im.crop((int(w * 0.47), 40, w, int(h * 0.75)))).stddev[0] < 6


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
    warns: list[dict] = []

    def add(kind: str, mark: int, t: int, detail: str) -> None:
        findings.append({"kind": kind, "press": mark, "t": t, "detail": detail})

    for i, mark in enumerate(marks):
        t0 = mark["t"]
        # up to the next press, at most 1.5 s: the end of the run (Tracing.end
        # flushing screenshots) stalls the page and is not the app
        t1 = min(marks[i + 1]["t"] if i + 1 < len(marks) else 10**9, t0 + 1500)
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
        # the pressed row's own fill, hover → press → open: no grey step
        # (the old .key-press veil) and no snap between two frames — a state
        # change eases over several frames (motion short, 150 ms)
        for f in window:
            sh = f.get("targetShadow") or ""
            veil = re.search(r"rgba\(0, 0, 0, ([\d.]+)\)", sh)
            if veil and float(veil.group(1)) >= 0.03:
                add("grey-step", i, f["t"], f"press veil {sh}")
                break
        # a step between two sampled frames: the fill composited over white
        # (any gap), and the tint layer's opacity (.list-row::after, adjacent
        # frames only)
        def over_white(c):
            return tuple(x * c[3] + 255 * (1 - c[3]) for x in c[:3])
        prev = None
        for f in window:
            c = rgba(f.get("targetBg", ""))
            cur = (over_white(c) if c else None, f.get("targetTint", -1))
            if prev and prev[2] != f.get("tgt"):
                prev = None  # the probe moved on to the next row
            if prev:
                (pc, pt), (cc, ct) = prev[1], cur
                adjacent = f["t"] - prev[0] <= 34
                # a background is painted by the main thread: a jump across a
                # stall is what the eye sees too; the tint layer's opacity
                # runs on the compositor, so only adjacent frames count
                jump = sum(abs(x - y) for x, y in zip(pc, cc)) if pc and cc else 0
                tint = abs(ct - pt) if adjacent and ct >= 0 and pt >= 0 else 0
                if jump > 20 or tint > 0.035:
                    add("snap", i, f["t"], f"fill moved {jump:.0f} / tint {tint:.3f} in one frame")
                    break
            prev = (f["t"], cur, f.get("tgt"))
        gaps = [(b["t"], b["t"] - a["t"]) for a, b in zip(window, window[1:]) if b["t"] - a["t"] > 50]
        if gaps:
            t, g = max(gaps, key=lambda x: x[1])
            warns.append({"kind": "jank", "press": i, "t": t, "detail": f"main thread blocked {g} ms (CSS on the compositor still moves)"})
        # sessions: once the new conversation shows, every painted frame
        # stays at its bottom — a glide there is a scroll animation on switch
        if args.scenario == "sessions":
            first = next((k for k, f in enumerate(window) if f["title"] and f["title"] != window[0]["title"] and not f["loading"]), None)
            off = 0
            for f in window[first:] if first is not None else []:
                gap = f.get("bottomPost", 0) - f.get("scrollPost", 0)
                off = off + 1 if "scrollPost" in f and gap > 4 else 0
                if off >= 2:
                    add("glide", i, f["t"], f"painted {gap}px above the bottom for {off} frames after the switch")
                    break
        new = next((f for f in window if f["title"] and f["title"] != before and not f["loading"]), None)
        if new:
            if args.scenario == "sessions" and new["bottom"] - new["scroll"] > 4:
                add("landing", i, new["t"], f"first frame {new['bottom'] - new['scroll']}px above the bottom")
            if args.scenario == "tickets" and new["scroll"] > 0:
                add("landing", i, new["t"], f"first frame at scroll {new['scroll']}, not the top")

    pix = []
    blank = []
    try:
        for path in sorted(glob.glob(os.path.join(args.out, "frames", "*.jpg"))):
            pix.append((os.path.basename(path), accent_count(path, region)))
            if args.scenario == "sessions" and pane_flat(path):
                blank.append(os.path.basename(path))
    except ImportError:
        print("pixels: skipped (python3 -m pip install pillow)")
    if pix:
        base = statistics.median(c for _p, c in pix)
        limit = base * 4 + 400
        hot = [(p, c) for p, c in pix if c > limit]
        for p, c in hot[:20]:
            add("pixels", -1, -1, f"{p}: {c} accent px (median {base:.0f})")
    for p in blank[:20]:
        add("blank", -1, -1, f"{p}: the pane painted without its conversation")

    summary = {
        "scenario": args.scenario,
        "presses": len(marks),
        "dom_frames": len(frames),
        "painted_frames": len(pix),
        "accent_median": statistics.median(c for _p, c in pix) if pix else None,
        "accent_max": max((c for _p, c in pix), default=None),
        "findings": findings,
        "warnings": warns,
    }
    json.dump(summary, open(os.path.join(args.out, "summary.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{args.scenario}: {len(marks)} presses, {len(frames)} DOM frames, {len(pix)} painted frames,"
          f" accent px median {summary['accent_median']} max {summary['accent_max']}")
    for f in findings:
        print(f"  FLASH {f['kind']:10} press {f['press']} t={f['t']}ms  {f['detail']}")
    for w in warns:
        print(f"  warn  {w['kind']:10} press {w['press']} t={w['t']}ms  {w['detail']}")
    print("  no flash" if not findings else f"  {len(findings)} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
