#!/usr/bin/env python3
"""Input-to-paint probe: how long the screen takes to change after an input.

It reads one screen region (XGetImage on the root window), sends one input through XTest, then reads the region
again as fast as it can until it differs, and prints the time from the input to the first changed read, in ms.
Standard library only (ctypes on libX11 and libXtst).

  python3 scripts/paint-probe.py --display :1 --region X,Y,W,H --click PX,PY [--runs 5]
  python3 scripts/paint-probe.py --display :1 --region X,Y,W,H --key a [--runs 5]
  python3 scripts/paint-probe.py --display :1 --region X,Y,W,H --baseline PX,PY [--runs 5]

--region is in screen pixels: keep it small and on the part that must change (a frame's tab, the code pane's line),
since each read costs time. --click sends a left click at PX,PY; --key presses and lets go of one key (an X keysym
name: a, Return, Escape, F2); --baseline right-clicks at PX,PY (the app's own context menu) and times that menu's
first paint, the probe's own floor, to subtract from the other readings. Between runs --reset-key (default Escape for
--baseline, none otherwise) is pressed and --settle-ms waited, so each run starts from the same screen.

It only reads the screen and sends the inputs named: it starts, stops and kills no process and opens no window.
Exit codes: 0 done, 1 the region never changed within --timeout-ms, 2 bad arguments or no display.
"""

import argparse
import ctypes
import ctypes.util
import statistics
import sys
import time
import zlib

Z_PIXMAP = 2
ALL_PLANES = ctypes.c_ulong(~0 & 0xFFFFFFFFFFFFFFFF)


class XImage(ctypes.Structure):
    pass


DESTROY = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(XImage))


class Funcs(ctypes.Structure):
    _fields_ = [
        ("create_image", ctypes.c_void_p),
        ("destroy_image", DESTROY),
        ("get_pixel", ctypes.c_void_p),
        ("put_pixel", ctypes.c_void_p),
        ("sub_image", ctypes.c_void_p),
        ("add_pixel", ctypes.c_void_p),
    ]


XImage._fields_ = [
    ("width", ctypes.c_int),
    ("height", ctypes.c_int),
    ("xoffset", ctypes.c_int),
    ("format", ctypes.c_int),
    ("data", ctypes.c_void_p),
    ("byte_order", ctypes.c_int),
    ("bitmap_unit", ctypes.c_int),
    ("bitmap_bit_order", ctypes.c_int),
    ("bitmap_pad", ctypes.c_int),
    ("depth", ctypes.c_int),
    ("bytes_per_line", ctypes.c_int),
    ("bits_per_pixel", ctypes.c_int),
    ("red_mask", ctypes.c_ulong),
    ("green_mask", ctypes.c_ulong),
    ("blue_mask", ctypes.c_ulong),
    ("obdata", ctypes.c_void_p),
    ("f", Funcs),
]


def load(name):
    path = ctypes.util.find_library(name)
    if not path:
        raise OSError(f"lib{name} not found")
    return ctypes.CDLL(path)


class Screen:
    def __init__(self, display):
        self.x11 = load("X11")
        self.xtst = load("Xtst")
        x = self.x11
        x.XOpenDisplay.restype = ctypes.c_void_p
        x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x.XGetImage.restype = ctypes.POINTER(XImage)
        x.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
        x.XStringToKeysym.restype = ctypes.c_ulong
        x.XStringToKeysym.argtypes = [ctypes.c_char_p]
        x.XKeysymToKeycode.restype = ctypes.c_ubyte
        x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x.XFlush.argtypes = [ctypes.c_void_p]
        x.XCloseDisplay.argtypes = [ctypes.c_void_p]
        t = self.xtst
        t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.dpy = x.XOpenDisplay(display.encode())
        if not self.dpy:
            raise OSError(f"cannot open display {display}")
        self.root = x.XDefaultRootWindow(self.dpy)

    def close(self):
        self.x11.XCloseDisplay(self.dpy)

    def read(self, region):
        """The region's pixels, as a checksum (a changed pixel changes it)."""
        x, y, w, h = region
        img = self.x11.XGetImage(self.dpy, self.root, x, y, w, h, ALL_PLANES, Z_PIXMAP)
        if not img:
            raise OSError("XGetImage failed: is the region on the screen?")
        try:
            size = img.contents.bytes_per_line * img.contents.height
            return zlib.crc32(ctypes.string_at(img.contents.data, size))
        finally:
            img.contents.f.destroy_image(img)

    def click(self, at, button):
        t = self.xtst
        t.XTestFakeMotionEvent(self.dpy, -1, at[0], at[1], 0)
        t.XTestFakeButtonEvent(self.dpy, button, 1, 0)
        t.XTestFakeButtonEvent(self.dpy, button, 0, 0)
        self.x11.XFlush(self.dpy)

    def key(self, name):
        sym = self.x11.XStringToKeysym(name.encode())
        code = self.x11.XKeysymToKeycode(self.dpy, sym) if sym else 0
        if not code:
            raise ValueError(f"no key for {name!r}")
        self.xtst.XTestFakeKeyEvent(self.dpy, code, 1, 0)
        self.xtst.XTestFakeKeyEvent(self.dpy, code, 0, 0)
        self.x11.XFlush(self.dpy)


def pair(text, n, what):
    parts = text.split(",")
    if len(parts) != n:
        raise argparse.ArgumentTypeError(f"{what} takes {n} numbers joined by commas")
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{what} takes whole numbers") from None


def one_run(scr, region, send, timeout_ms):
    """Ms from the input to the first read that differs; None if nothing changed in time."""
    scr.x11.XSync(scr.dpy, 0)
    before = scr.read(region)
    start = time.perf_counter()
    send()
    limit = start + timeout_ms / 1000
    while True:
        if scr.read(region) != before:
            return (time.perf_counter() - start) * 1000
        if time.perf_counter() > limit:
            return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Input-to-paint probe (XTest input, XGetImage polling).")
    ap.add_argument("--display", required=True, help="the X display, as :1 (required, starting with a colon; never read from the environment)")
    ap.add_argument("--region", required=True, type=lambda s: pair(s, 4, "--region"), help="X,Y,W,H in screen pixels")
    act = ap.add_mutually_exclusive_group(required=True)
    act.add_argument("--click", type=lambda s: pair(s, 2, "--click"), metavar="PX,PY", help="a left click here")
    act.add_argument("--key", metavar="KEYSYM", help="one key pressed and let go")
    act.add_argument(
        "--baseline",
        type=lambda s: pair(s, 2, "--baseline"),
        metavar="PX,PY",
        help="a right click here: the context menu's paint; Escape is pressed after each run to close the menu",
    )
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--reset-key", default=None, help="pressed after each run, and after a run that times out (default Escape with --baseline, none otherwise)")
    ap.add_argument("--settle-ms", type=int, default=600, help="wait after each run and its reset")
    ap.add_argument("--timeout-ms", type=int, default=5000)
    a = ap.parse_args(argv)
    if not a.display.startswith(":") or len(a.display) < 2:
        ap.error("--display takes a display name starting with a colon, as :1")
    if a.runs < 1 or a.region[2] <= 0 or a.region[3] <= 0:
        ap.error("--runs and the region's size must be positive")
    reset = a.reset_key if a.reset_key is not None else ("Escape" if a.baseline else None)
    try:
        scr = Screen(a.display)
    except OSError as e:
        print(f"paint-probe: {e}", file=sys.stderr)
        return 2
    try:
        if a.click:
            send, what = (lambda: scr.click(a.click, 1)), f"click at {a.click[0]},{a.click[1]}"
        elif a.key:
            send, what = (lambda: scr.key(a.key)), f"key {a.key}"
        else:
            send, what = (lambda: scr.click(a.baseline, 3)), f"baseline (menu) at {a.baseline[0]},{a.baseline[1]}"
        times = []
        for i in range(a.runs):
            ms = one_run(scr, a.region, send, a.timeout_ms)
            if ms is None:
                print(f"run {i + 1}: no change within {a.timeout_ms} ms", file=sys.stderr)
                # Whatever the input opened (a menu) is closed again, as after any run.
                if reset:
                    scr.key(reset)
                return 1
            times.append(ms)
            print(f"run {i + 1}: {what}: {ms:.1f} ms")
            time.sleep(a.settle_ms / 1000)
            if reset:
                scr.key(reset)
                time.sleep(a.settle_ms / 1000)
        print(f"median {statistics.median(times):.1f} ms, min {min(times):.1f} ms, max {max(times):.1f} ms over {len(times)} runs")
        return 0
    finally:
        scr.close()


if __name__ == "__main__":
    sys.exit(main())
