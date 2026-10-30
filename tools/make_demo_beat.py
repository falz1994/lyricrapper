#!/usr/bin/env python3
"""
Genera la pista de demostración (instrumental, sin voces) y su JSON de tiempos.

    python3 tools/make_demo_beat.py

Salida:
    assets/audio/demo-beat.mp3     (boom-bap de 90 BPM, 16 compases)
    data/tracks/demo-beat.json     (8 líneas de ejemplo alineadas al pulso)

Todo se sintetiza aquí: no se usa ningún audio de terceros, así que la demo
es 100 % libre de derechos y sirve para probar la mecánica del sitio.
"""
from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parent.parent
SR = 44_100
BPM = 90
BEAT = 60.0 / BPM
BARS = 16
STEPS_PER_BAR = 16
STEP = BEAT / 4                      # semicorchea
TOTAL = BARS * 4 * BEAT + 2.0        # cola para que el final respire
N = int(TOTAL * SR)
rng = np.random.default_rng(7)


def env(n: int, attack: float, decay: float, curve: float = 4.0) -> np.ndarray:
    """Envolvente ataque/decaimiento exponencial de n muestras."""
    a = max(1, int(attack * SR))
    d = max(1, n - a)
    e = np.concatenate([np.linspace(0, 1, a), np.exp(-curve * np.linspace(0, 1, d))])
    return e[:n]


def place(buf: np.ndarray, sound: np.ndarray, t: float, gain: float = 1.0) -> None:
    i = int(t * SR)
    if i >= buf.shape[0]:
        return
    n = min(len(sound), buf.shape[0] - i)
    if buf.ndim == 2:
        buf[i:i + n] += sound[:n, None] * gain
    else:
        buf[i:i + n] += sound[:n] * gain


def kick(dur: float = 0.45) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 48 + 105 * np.exp(-t * 26)                 # barrido de 153 Hz a 48 Hz
    body = np.sin(2 * np.pi * np.cumsum(f) / SR)
    click = rng.normal(0, 1, n) * np.exp(-t * 420) * 0.25
    return (body * env(n, 0.001, dur, 3.2) + click) * 0.95


def snare(dur: float = 0.28) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    b, a = signal.butter(2, [900 / (SR / 2), 7000 / (SR / 2)], btype="band")
    noise = signal.lfilter(b, a, noise)
    tone = np.sin(2 * np.pi * 185 * t) * 0.35 + np.sin(2 * np.pi * 320 * t) * 0.15
    body = env(n, 0.001, dur, 5.5)
    return (noise * 0.75 + tone) * body * 0.55


def hat(dur: float = 0.07, open_hat: bool = False) -> np.ndarray:
    dur = 0.24 if open_hat else dur
    n = int(dur * SR)
    noise = rng.normal(0, 1, n)
    b, a = signal.butter(4, 6500 / (SR / 2), btype="high")
    noise = signal.lfilter(b, a, noise)
    return noise * env(n, 0.0008, dur, 9 if not open_hat else 5) * 0.22


def saw(freq: float, dur: float, harmonics: int = 12) -> np.ndarray:
    """Sierra con armónicos limitados (evita aliasing y filtros)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        if freq * k > SR / 2.2:
            break
        out += np.sin(2 * np.pi * freq * k * t) / k
    return out * 0.6


def bass(freq: float, dur: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2 * t)
    sig += 0.12 * saw(freq, dur, 5)
    return sig * env(n, 0.006, dur, 2.6) * 0.5


def keys(freqs: list[float], dur: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for f in freqs:
        out += np.sin(2 * np.pi * f * t) * 0.6
        out += np.sin(2 * np.pi * f * 2.01 * t) * 0.12
    trem = 0.85 + 0.15 * np.sin(2 * np.pi * 4.5 * t)
    return out * trem * env(n, 0.02, dur, 1.7) * 0.16


# --- armonía: Am | Am | F | G  -------------------------------------------
NOTE = {
    "A1": 55.00, "C2": 65.41, "D2": 73.42, "E2": 82.41, "F2": 87.31, "G2": 98.00,
    "A3": 220.00, "C4": 261.63, "D4": 293.66, "E4": 329.63, "F3": 174.61,
    "G3": 196.00, "B3": 246.94, "A4": 440.00,
}
PROG = [
    (["A3", "C4", "E4"], "A1"),
    (["A3", "C4", "E4"], "A1"),
    (["F3", "A3", "C4"], "F2"),
    (["G3", "B3", "D4"], "G2"),
]

music = np.zeros(N)
music_l = np.zeros(N)
music_r = np.zeros(N)

for bar in range(BARS):
    bar_t = bar * 4 * BEAT
    chord, root = PROG[bar % len(PROG)]
    chord_f = [NOTE[n] for n in chord]

    # teclado al inicio de cada compás
    k = keys(chord_f, 4 * BEAT * 0.95)
    place(music_l, k, bar_t, 1.0)
    place(music_r, k, bar_t + 0.008, 1.0)   # pequeño retardo = anchura estéreo

    # batería
    kicks = [0, 7, 10] if bar % 4 != 3 else [0, 6, 10, 14]
    for s in kicks:
        place(music, kick(), bar_t + s * STEP, 1.0)
    for s in (4, 12):
        place(music, snare(), bar_t + s * STEP, 1.0)
    for s in range(0, 16, 2):
        swing = 0.018 if s % 4 else 0.0
        place(music, hat(open_hat=(s == 14)), bar_t + s * STEP + swing,
              0.55 if s % 4 == 0 else 0.38)

    # bajo: raíz en 1 y 3.5
    for s, dur in ((0, 1.6 * BEAT), (7, 0.9 * BEAT), (10, 1.4 * BEAT)):
        place(music, bass(NOTE[root], dur), bar_t + s * STEP, 0.9)

# --- mezcla --------------------------------------------------------------
drums = music
mix_l = drums * 0.85 + music_l
mix_r = drums * 0.85 + music_r

# ruido de vinilo muy leve
crackle = rng.normal(0, 0.006, N) * (rng.random(N) > 0.9992)
mix_l += crackle
mix_r += rng.normal(0, 0.006, N) * (rng.random(N) > 0.9992)

# fundido
fade_in = int(0.05 * SR)
fade_out = int(1.6 * SR)
for ch in (mix_l, mix_r):
    ch[:fade_in] *= np.linspace(0, 1, fade_in)
    ch[-fade_out:] *= np.linspace(1, 0, fade_out) ** 2

stereo = np.stack([mix_l, mix_r], axis=1)
stereo /= np.max(np.abs(stereo)) / 0.89        # ~ -1 dBFS

wav_path = ROOT / "assets" / "audio" / "demo-beat.wav"
mp3_path = ROOT / "assets" / "audio" / "demo-beat.mp3"
wav_path.parent.mkdir(parents=True, exist_ok=True)

pcm = (stereo * 32767).astype("<i2")
with wave.open(str(wav_path), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
     "-codec:a", "libmp3lame", "-b:a", "160k", str(mp3_path)],
    check=True,
)
wav_path.unlink()

# --- JSON de la pista ----------------------------------------------------
# Ocho líneas de ejemplo, una cada dos compases. Los tiempos salen de la
# rejilla del beat, no de escuchar: por eso son exactos.
LINEAS = [
    "Esto es un piloto, no la canción real",
    "un beat de metrónomo pa' probar el ritual",
    "toca una línea y el audio salta justo ahí",
    "sin cortar la primera sílaba, todo fluye así",
    "cada verso guarda su start y su end",
    "en un JSON liviano que el navegador lee",
    "marca tú los tiempos con el estudio sync",
    "y la letra y la música van a la vez",
]
step = 2 * 4 * BEAT            # 2 compases por línea
lines = []
for i, text in enumerate(LINEAS):
    start = round(0.25 + i * step, 3)
    lines.append({"start": start, "end": round(start + step, 3), "text": text})

duration = round(len(stereo) / SR, 3)
track = {
    "id": "demo-beat",
    "title": "Demo Beat",
    "artist": "Lyric Rapper",
    "album": "Piloto",
    "kicker": "Demostración",
    "audio": "assets/audio/demo-beat.mp3",
    "duration": duration,
    "bpm": BPM,
    "language": "es",
    "notes": "Instrumental sintetizado por tools/make_demo_beat.py. Sin voces: sirve para probar el salto por línea.",
    "lines": lines,
}
out = ROOT / "data" / "tracks" / "demo-beat.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(track, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

print(f"OK  {mp3_path.relative_to(ROOT)}  ({duration:.2f} s)")
print(f"OK  {out.relative_to(ROOT)}  ({len(lines)} líneas)")
