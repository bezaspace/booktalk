"""Generate BookTalk test assets: a multi-page PDF + spoken question WAVs.

Outputs (all under OUT):
  test.pdf          12-page text PDF
  q1.wav q2.wav q3.wav   spoken questions (24kHz mono PCM16 WAV)
  q1.pcm q2.pcm q3.pcm   same audio resampled to 16kHz raw PCM (Live API input)
  session.json      {session_id, page_count} from POST /upload
"""
from __future__ import annotations

import base64
import json
import struct
import urllib.request
import os
from pathlib import Path

import pymupdf
from google import genai
from google.genai import types

OUT = Path(os.environ.get("BH_DIR", "/tmp/bh"))
OUT.mkdir(parents=True, exist_ok=True)

PAGE_TEXT = [
    "Chapter {n}: The Machinery of Memory",
    "",
    "Human memory is not a recording device. When you recall an event, your brain "
    "reconstructs it from fragments: sensory traces, emotional tags, and the "
    "narrative you have told yourself about it before. Each reconstruction is "
    "slightly lossy, which is why two people can describe the same afternoon in "
    "ways that barely overlap.",
    "",
    "The hippocampus acts as an indexing service. It does not store the memory "
    "itself; it stores the address of the cortical regions that, when reactivated "
    "together, reproduce the experience. Sleep consolidates these addresses, "
    "replaying them at high speed so the connections strengthen.",
    "",
    "This has a practical consequence for anyone trying to learn: retrieval beats "
    "review. Reading a page again feels productive because it is fluent, but "
    "fluency is not storage. Closing the book and attempting to reconstruct the "
    "argument from scratch is uncomfortable, and that discomfort is the signal "
    "that encoding is actually happening.",
    "",
    "Entropy plays an unexpected role here. Memories that are recalled in varied "
    "contexts become more resistant to forgetting, because each recall adds a new "
    "retrieval route. A fact learned in one room, in one mood, at one hour is "
    "fragile. The same fact, revisited while walking, while cooking, while "
    "arguing, becomes part of a network rather than a single thread.",
]


def make_pdf(path: Path, pages: int = 12) -> int:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()
        body = "\n".join(line.format(n=i + 1) for line in PAGE_TEXT)
        page.insert_textbox(
            pymupdf.Rect(60, 60, 540, 760),
            body,
            fontsize=11,
            fontname="helv",
        )
    doc.save(path)
    doc.close()
    return pages


def wav_header(n_samples: int, rate: int) -> bytes:
    data_size = n_samples * 2
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_size)
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", data_size)
    )


def resample_24k_to_16k(pcm: bytes) -> bytes:
    """24kHz -> 16kHz: average each group of 3 samples into 2 (ratio 3:2)."""
    n = len(pcm) // 2
    src = struct.unpack("<%dh" % n, pcm[: n * 2])
    out = []
    i = 0
    while i + 3 <= n:
        a, b, c = src[i], src[i + 1], src[i + 2]
        out.append(int((a + b) / 2))
        out.append(int((b + c) / 2))
        i += 3
    return struct.pack("<%dh" % len(out), *out)


def tts(client: genai.Client, text: str, path: Path, voice: str = "Kore") -> tuple[bytes, int]:
    resp = client.models.generate_content(
        model="gemini-3.1-flash-tts-preview",
        contents=text,
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
        ),
    )
    part = resp.candidates[0].content.parts[0]
    raw = part.inline_data.data
    if isinstance(raw, str):
        raw = base64.b64decode(raw)
    mime = part.inline_data.mime_type or "audio/L16;codec=pcm;rate=24000"
    rate = 24000
    import re

    m = re.search(r"rate=(\d+)", mime)
    if m:
        rate = int(m.group(1))
    n = len(raw) // 2
    path.write_bytes(wav_header(n, rate) + raw[: n * 2])
    print(f"  {path.name}: {n / rate:.2f}s @ {rate}Hz ({mime})")
    return raw[: n * 2], rate


def upload(pdf: Path) -> dict:
    boundary = "----booktalkharness"
    data = pdf.read_bytes()
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="file"; filename="test.pdf"\r\n',
            b"Content-Type: application/pdf\r\n\r\n",
            data,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    req = urllib.request.Request(
        "http://127.0.0.1:8000/upload",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main() -> None:
    from app.config import get_settings

    settings = get_settings()
    client = genai.Client(
        api_key=settings.gemini_api_key, http_options={"api_version": "v1alpha"}
    )

    print("PDF:")
    pages = make_pdf(OUT / "test.pdf")
    print(f"  test.pdf: {pages} pages")

    print("TTS questions:")
    questions = {
        "q1": "Can you explain what this page is about, and what the hippocampus does?",
        "q2": "Now tell me more about that memory idea — why does retrieval beat review?",
        "q3": "And what did the page say about entropy and forgetting?",
    }
    for key, text in questions.items():
        raw, rate = tts(client, text, OUT / f"{key}.wav")
        (OUT / f"{key}.pcm").write_bytes(resample_24k_to_16k(raw))

    print("Upload:")
    resp = upload(OUT / "test.pdf")
    (OUT / "session.json").write_text(json.dumps(resp))
    print(f"  {resp}")


if __name__ == "__main__":
    main()
