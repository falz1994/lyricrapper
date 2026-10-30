import sys
from faster_whisper import WhisperModel

model = sys.argv[3] if len(sys.argv) > 3 else "base"
lo = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0
hi = float(sys.argv[2]) if len(sys.argv) > 2 else 1e9
prompt = sys.argv[4] if len(sys.argv) > 4 else None

m = WhisperModel(model, device="cpu", compute_type="int8", download_root="tools/models")
segs, _ = m.transcribe(
    "assets/audio/nasny.mp3",
    language="en",
    word_timestamps=True,
    vad_filter=False,
    condition_on_previous_text=False,
    initial_prompt=prompt,
)
for s in segs:
    for w in s.words or []:
        if lo <= w.start <= hi:
            print(f"{w.start:7.2f} {w.end:7.2f} {w.word}")
