#!/usr/bin/env python3
"""PTY flicker harness for the TUI.

Spawns `node dist/tui/index.js` in a pseudo-terminal, drives it with a
scripted key sequence, and reports:
  * count of ED (erase display) and EL (erase line) sequences in output
  * row-width variance of lines inside the selected view's border box
  * whether any frame/border characters land in unexpected positions
    during rapid scrolling (off-by-one terminal scroll detection)

Usage:
    python3 tests/pty-flicker.py <view-letter> [--presses N]

<view-letter> is the hotkey that opens the target view: c calendar,
h heartbeats, a agents, t tasks.
"""
from __future__ import annotations

import argparse
import os
import pty
import re
import select
import sys
import time


DOWN = b"\x1b[B"
UP = b"\x1b[A"
ED_RE = re.compile(rb"\x1b\[[0-2]?J")  # erase in display
EL_RE = re.compile(rb"\x1b\[[0-2]?K")  # erase in line (this is fine/expected)
SCROLL_UP_RE = re.compile(rb"\x1b\[S")  # scroll up region
SCROLL_DOWN_RE = re.compile(rb"\x1bD")  # IND (line feed + possible scroll)
ANSI_ANY_RE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("view", help="hotkey to open target view (c/h/a/t)")
    ap.add_argument("--presses", type=int, default=20)
    ap.add_argument("--settle-ms", type=int, default=1500)
    ap.add_argument("--per-key-ms", type=int, default=120)
    ap.add_argument("--cmd", default="node dist/tui/index.js")
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--cols", type=int, default=120)
    args = ap.parse_args()

    pid, fd = pty.fork()
    if pid == 0:
        # Child: set TERM so ink is happy, exec TUI.
        os.environ["TERM"] = "xterm-256color"
        os.environ["LINES"] = str(args.rows)
        os.environ["COLUMNS"] = str(args.cols)
        os.execvp("sh", ["sh", "-lc", args.cmd])
        return 127  # unreachable

    # Parent: set window size via TIOCSWINSZ.
    import fcntl, struct, termios

    winsize = struct.pack("HHHH", args.rows, args.cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

    def drain(ms: int) -> bytes:
        deadline = time.time() + ms / 1000.0
        buf = bytearray()
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
        return bytes(buf)

    # 1. Let TUI paint initial frame.
    initial = drain(args.settle_ms)

    # 2. Switch to target view.
    os.write(fd, args.view.encode())
    switched = drain(args.settle_ms)

    # 3. Scroll: DOWN * presses, then UP * presses.
    down_bytes = bytearray()
    for _ in range(args.presses):
        os.write(fd, DOWN)
        down_bytes.extend(drain(args.per_key_ms))

    up_bytes = bytearray()
    for _ in range(args.presses):
        os.write(fd, UP)
        up_bytes.extend(drain(args.per_key_ms))

    # 4. Quit the TUI cleanly.
    os.write(fd, b"q")
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    drain(500)

    # Tally escape-sequence counts on the scroll phase (down + up only).
    scroll_payload = bytes(down_bytes) + bytes(up_bytes)
    ed_count = len(ED_RE.findall(scroll_payload))
    scroll_up_count = len(SCROLL_UP_RE.findall(scroll_payload))
    scroll_down_count = len(SCROLL_DOWN_RE.findall(scroll_payload))

    # Strip all ANSI sequences to measure drawn-width stability per frame.
    plain = ANSI_ANY_RE.sub(b"", scroll_payload)
    lines = plain.split(b"\n")
    border_lines = [ln for ln in lines if ln.strip().startswith(b"\xe2\x95\xad") or ln.strip().startswith(b"\xe2\x95\xb0")]
    border_widths = set(len(ln) for ln in border_lines)

    # Extract per-frame cursor-home snapshots. Ink emits CUP (cursor to
    # home-ish row) + ED (erase-to-end) before each full-frame redraw, then
    # writes the frame. We split the scroll payload on CUP to approximate
    # frame boundaries and compare the first non-empty line of each frame —
    # if the terminal scrolled the previous frame up, the FIRST visible
    # line of the new frame will differ from the box's top border.
    cup_split = re.split(rb"\x1b\[\d*;\d*H", scroll_payload)
    frame_first_lines = []
    for frag in cup_split:
        # Drop leading ANSI and whitespace, read first printable line.
        no_ansi = ANSI_ANY_RE.sub(b"", frag)
        for raw in no_ansi.split(b"\n"):
            stripped = raw.strip()
            if stripped:
                frame_first_lines.append(stripped[:8])
                break
    top_variants = sorted(set(frame_first_lines))

    print(f"view        = {args.view}")
    print(f"presses     = {args.presses}  (down then up)")
    print(f"bytes       = {len(scroll_payload)}")
    print(f"ED (\\x1b[J) = {ed_count}  (Ink uses these; count is informational)")
    print(f"SU (\\x1b[S) = {scroll_up_count}   (terminal scroll-up regions)")
    print(f"IND (\\x1bD) = {scroll_down_count}   (line feed into scroll region)")
    print(f"border line widths seen = {sorted(border_widths)}")
    print(f"unique frame top-line prefixes = {len(top_variants)}: {top_variants[:6]}")
    warn = 0
    if scroll_up_count > 0 or scroll_down_count > 0:
        print("FAIL: terminal scroll sequences observed; content overflows view.")
        warn += 1
    if len(border_widths) > 1:
        print("FAIL: border line width jitter observed.")
        warn += 1
    return warn


if __name__ == "__main__":
    sys.exit(main())
