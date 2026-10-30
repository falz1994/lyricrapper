"""Transcribe a time slice of the track with word timestamps (loose thresholds)."""
import sys

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

lo = float(sys.argv[1])
hi = float(sys.argv[2])
model = sys.argv[3] if len(sys.argv) > 3 else "small"
prompt = sys.argv[4] if len(sys.argv) > 4 else None

audio = decode_audio("assets/audio/nasny.mp3", sampling_rate=16000)
clip = audio[int(lo * 16000) : int(hi * 16000)]

m = WhisperModel(model, device="cpu", compute_type="int8", download_root="tools/models")
segs, _ = m.transcribe(
    clip,
    language="en",
    word_timestamps=True,
    vad_filter=False,
    condition_on_previous_text=True,
    initial_prompt=prompt,
    no_speech_threshold=0.3,
    log_prob_threshold=-2.0,
    compression_ratio_threshold=3.0,
    temperature=0.0,
)
for s in segs:
    print(f"[{lo + s.start:7.2f} - {lo + s.end:7.2f}] {s.text.strip()}")
    for w in s.words or []:
        print(f"      {lo + w.start:7.2f} {lo + w.end:7.2f} {w.word}")
