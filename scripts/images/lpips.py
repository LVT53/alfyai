#!/usr/bin/env python3
"""LPIPS and offset outside a change mask (plan 2c Task 5).

Usage: lpips.py <before.png> <after.png> <mask.png>
Prints one JSON line: {"lpips_outside": float, "offset_px": float}.

mask.png: white (>0) = inside the edited area (ignored), black = outside.
lpips_outside is the mean of LPIPS(alex) spatial map over pixels where the mask is 0.
offset_px is the length of the global shift between the two pictures, found by
phase correlation of the grey pictures with the masked area blanked to the mean.
Run it with the throwaway venv and `python -I` (the file name would shadow the lpips package otherwise).
"""
import json
import sys

import numpy as np
from PIL import Image


def load(path, size=None, mode="RGB"):
    img = Image.open(path).convert(mode)
    if size and img.size != size:
        img = img.resize(size, Image.LANCZOS)
    return img


def offset_of(a, b, outside):
    def prep(img):
        g = np.asarray(img.convert("L"), dtype=np.float64)
        mean = g[outside].mean() if outside.any() else g.mean()
        g = np.where(outside, g, mean) - mean
        win = np.outer(np.hanning(g.shape[0]), np.hanning(g.shape[1]))
        return g * win

    fa, fb = np.fft.fft2(prep(a)), np.fft.fft2(prep(b))
    cross = fa * np.conj(fb)
    cross /= np.abs(cross) + 1e-9
    corr = np.real(np.fft.ifft2(cross))
    iy, ix = np.unravel_index(np.argmax(corr), corr.shape)

    def refine(c, i, n, axis):
        prev = c[(i - 1) % n, ix] if axis == 0 else c[iy, (i - 1) % n]
        nxt = c[(i + 1) % n, ix] if axis == 0 else c[iy, (i + 1) % n]
        mid = c[i, ix] if axis == 0 else c[iy, i]
        denom = prev - 2 * mid + nxt
        return 0.0 if abs(denom) < 1e-12 else 0.5 * (prev - nxt) / denom

    h, w = corr.shape
    dy = iy + refine(corr, iy, h, 0)
    dx = ix + refine(corr, ix, w, 1)
    if dy > h / 2:
        dy -= h
    if dx > w / 2:
        dx -= w
    return float(np.hypot(dx, dy))


def main():
    before_p, after_p, mask_p = sys.argv[1:4]
    import lpips
    import torch

    before = load(before_p)
    after = load(after_p, before.size)
    mask = np.asarray(load(mask_p, before.size, "L")) > 0
    outside = ~mask

    def tensor(img):
        t = torch.from_numpy(np.asarray(img, dtype=np.float32) / 127.5 - 1.0)
        return t.permute(2, 0, 1).unsqueeze(0)

    net = lpips.LPIPS(net="alex", spatial=True, verbose=False)
    with torch.no_grad():
        dmap = net(tensor(before), tensor(after))[0, 0].numpy()
    if dmap.shape != outside.shape:
        m = Image.fromarray((outside * 255).astype(np.uint8)).resize(
            (dmap.shape[1], dmap.shape[0]), Image.NEAREST
        )
        sel = np.asarray(m) > 127
    else:
        sel = outside
    value = float(dmap[sel].mean()) if sel.any() else 0.0
    print(json.dumps({"lpips_outside": round(value, 4), "offset_px": round(offset_of(before, after, outside), 2)}))


main()
