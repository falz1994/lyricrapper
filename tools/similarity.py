"""Find repeats of an audio segment by spectral self-similarity (numpy only).

Usage: python3 tools/similarity.py TEMPLATE_START TEMPLATE_END SEARCH_START SEARCH_END
Prints, for each candidate offset, how similar the template is to the audio there.
"""
import sys

import numpy as np

from faster_whisper.audio import decode_audio

t0, t1, s0, s1 = (float(x) for x in sys.argv[1:5])

SR = 16000
audio = decode_audio("assets/audio/nasny.mp3", sampling_rate=SR)

WIN = 1024
HOP = 160  # 10 ms


def frames(sig):
    n = 1 + max(0, (len(sig) - WIN) // HOP)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    return np.abs(np.fft.rfft(sig[idx] * np.hanning(WIN), axis=1))


spec = frames(audio)
spec = np.log1p(spec * 100.0)
# 32 log-spaced bands, then normalise each frame
edges = np.unique(np.round(np.geomspace(1, spec.shape[1] - 1, 33)).astype(int))
banded = np.stack([spec[:, a:b].mean(axis=1) for a, b in zip(edges[:-1], edges[1:])], axis=1)
banded -= banded.mean(axis=1, keepdims=True)
banded /= np.linalg.norm(banded, axis=1, keepdims=True) + 1e-9

i0, i1 = int(t0 * 100), int(t1 * 100)
template = banded[i0:i1]

lo = int(s0 * 100)
hi = int(s1 * 100)
n = i1 - i0
starts = np.arange(lo, hi)
# cosine similarity averaged over template frames, for every candidate start
sims = np.empty(len(starts))
for k, st in enumerate(starts):
    seg = banded[st : st + n]
    if len(seg) < n:
        sims[k] = -1
        continue
    sims[k] = float((template * seg).sum() / n)

# local maxima above threshold
order = np.argsort(sims)[::-1]
picked = []
for k in order:
    if sims[k] < 0.55:
        break
    t = starts[k] / 100
    if all(abs(t - p) > 1.0 for p, _ in picked):
        picked.append((t, sims[k]))
    if len(picked) >= 25:
        break

print(f"template {t0:.2f}-{t1:.2f} s")
for t, s in sorted(picked):
    print(f"  {t:7.2f}  sim={s:.3f}")
