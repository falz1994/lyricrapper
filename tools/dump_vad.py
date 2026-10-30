"""Dump VAD speech-segment starts (a proxy for vocal onsets) in a time range."""
import sys

from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

lo = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0
hi = float(sys.argv[2]) if len(sys.argv) > 2 else 1e9

audio = decode_audio("assets/audio/nasny.mp3", sampling_rate=16000)
audio = audio[int(lo * 16000) : int(hi * 16000)]

opts = VadOptions(
    threshold=0.5,
    min_speech_duration_ms=60,
    min_silence_duration_ms=150,
    speech_pad_ms=80,
)
segments = get_speech_timestamps(audio, opts, sampling_rate=16000)
for s in segments:
    print(f"{lo + s['start'] / 16000:7.2f} {lo + s['end'] / 16000:7.2f}")
