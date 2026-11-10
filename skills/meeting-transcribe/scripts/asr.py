"""Распознавание: подготовка звука, диаризация, нарезка, GigaAM v3 и Whisper large-v3.

Каждая стадия пишет результат в папку встречи и при повторном запуске берётся из кэша,
поэтому упавший на середине прогон продолжается с места падения.
Модели грузятся по очереди и выгружаются: на RTX A1000 всего 6 ГБ видеопамяти.
"""
from __future__ import annotations

import gc
import json
import os
import subprocess
import wave
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

SR = 16000
MAX_CHUNK = 20.0   # GigaAM принимает до 25 с; 20 с даёт запас и короткие реплики


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def prepare_audio(src: Path, out_wav: Path) -> None:
    if out_wav.exists():
        return
    subprocess.run([ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
                    "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le",
                    str(out_wav)], check=True)


def load_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as f:
        raw = f.readframes(f.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    # Громкость к -20 dBFS по речи (loudnorm в ffmpeg делал то же, но 3+ минуты на час звука).
    loud = audio[np.abs(audio) > 0.01]
    if loud.size:
        gain = min(0.1 / (np.sqrt(np.mean(loud ** 2)) + 1e-9), 0.97 / (np.abs(audio).max() + 1e-9))
        audio = audio * gain
    return audio


def _free_gpu() -> None:
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass


def _load(path: Path):
    return json.loads(path.read_text("utf-8")) if path.exists() else None


def _save(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")


# ---------- диаризация ----------

def diarize(audio: np.ndarray, cache: Path, hf_token: str | None, num_speakers: int | None) -> list[dict]:
    """Кто когда говорит. Без токена HF - один условный спикер на всю запись."""
    if (cached := _load(cache)) is not None:
        return cached
    if not hf_token:
        print("  HF_TOKEN не задан - диаризация пропущена")
        turns = [{"start": 0.0, "end": len(audio) / SR, "speaker": "SPEAKER_00"}]
        return turns
    import torch
    from pyannote.audio import Pipeline
    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=hf_token)
    pipeline.to(torch.device("cuda" if torch.cuda.is_available() else "cpu"))
    kwargs = {"num_speakers": num_speakers} if num_speakers else {}
    output = pipeline({"waveform": torch.from_numpy(audio)[None], "sample_rate": SR}, **kwargs)
    # Exclusive-разметка: в каждый момент ровно один говорящий - удобно резать под ASR.
    annotation = getattr(output, "exclusive_speaker_diarization", None) or getattr(output, "speaker_diarization", output)
    turns = [{"start": round(t.start, 3), "end": round(t.end, 3), "speaker": spk}
             for t, _, spk in annotation.itertracks(yield_label=True)]
    del pipeline
    _free_gpu()
    _save(cache, turns)
    return turns


# ---------- нарезка ----------

@dataclass
class Chunk:
    id: int
    start: float
    end: float
    speaker: str
    giga: str = ""
    whisper: str = ""
    text: str = ""


def speech_segments(audio: np.ndarray, cache: Path) -> list[tuple[float, float]]:
    if (cached := _load(cache)) is not None:
        return [tuple(x) for x in cached]
    import torch
    from silero_vad import load_silero_vad, get_speech_timestamps
    model = load_silero_vad()
    stamps = get_speech_timestamps(torch.from_numpy(audio), model, sampling_rate=SR,
                                   threshold=0.4, min_silence_duration_ms=250, speech_pad_ms=150,
                                   max_speech_duration_s=MAX_CHUNK, return_seconds=True)
    segments = [(float(s["start"]), float(s["end"])) for s in stamps]
    _save(cache, segments)
    return segments


def make_chunks(segments: list[tuple[float, float]], turns: list[dict]) -> list[Chunk]:
    """Пересекаем речь (VAD) с репликами (диаризация) и склеиваем соседние куски
    одного спикера, пока чанк не длиннее MAX_CHUNK и пауза короче секунды."""
    pieces: list[tuple[float, float, str]] = []
    for s, e in segments:
        for t in turns:
            a, b = max(s, t["start"]), min(e, t["end"])
            if b - a >= 0.25:
                pieces.append((a, b, t["speaker"]))
    pieces.sort()
    chunks: list[Chunk] = []
    for a, b, spk in pieces:
        last = chunks[-1] if chunks else None
        if last and last.speaker == spk and a - last.end < 1.0 and b - last.start <= MAX_CHUNK:
            last.end = b
        else:
            chunks.append(Chunk(len(chunks), a, b, spk))
    for c in chunks:
        c.start, c.end = round(c.start, 2), round(c.end, 2)
    return chunks


# ---------- GigaAM v3 ----------

def run_gigaam(audio: np.ndarray, chunks: list[Chunk], cache: Path, workdir: Path) -> None:
    if (cached := _load(cache)) is not None:
        for c, text in zip(chunks, cached):
            c.giga = text
        return
    import gigaam
    import torch
    model = gigaam.load_model("v3_e2e_rnnt", device="cuda" if torch.cuda.is_available() else "cpu")
    # Звук подаём тензором, минуя load_audio (тот зовёт ffmpeg из PATH), и батчами
    # близких по длине фрагментов - паддинга меньше, GPU загружен лучше.
    order = sorted(range(len(chunks)), key=lambda i: chunks[i].end - chunks[i].start)
    batch = 8
    with torch.inference_mode():
        for n in range(0, len(order), batch):
            idx = order[n:n + batch]
            pieces = [torch.from_numpy(audio[int(chunks[i].start * SR):int(chunks[i].end * SR)].copy()) for i in idx]
            lengths = torch.tensor([len(p) for p in pieces], device=model._device)
            wav = torch.nn.utils.rnn.pad_sequence(pieces, batch_first=True).to(model._device).to(model._dtype)
            encoded, encoded_len = model.forward(wav, lengths)
            for i, (text, _) in zip(idx, model._decode(encoded, encoded_len, lengths)):
                chunks[i].giga = text.strip()
            if n % (batch * 5) == 0:
                print(f"  GigaAM {n + len(idx)}/{len(chunks)}", flush=True)
    del model
    _free_gpu()
    _save(cache, [c.giga for c in chunks])


# ---------- Whisper large-v3 ----------

def run_whisper(audio: np.ndarray, chunks: list[Chunk], cache: Path, prompt: str) -> None:
    words = _load(cache)
    if words is None:
        import torch  # noqa: F401 - подгружает cuDNN/cuBLAS из колёс torch для CTranslate2
        from faster_whisper import BatchedInferencePipeline, WhisperModel
        local = Path.home() / "models" / "faster-whisper-large-v3"
        name = os.environ.get("WHISPER_MODEL") or (str(local) if (local / "model.bin").exists() else "large-v3")
        gpu = torch.cuda.is_available()  # без видеокарты работает на CPU, но в разы медленнее
        model = WhisperModel(name, device="cuda" if gpu else "cpu", compute_type="int8_float16" if gpu else "int8")
        # Распознаём ровно наши фрагменты: подсказка-словарь действует в каждом
        # (в последовательном режиме она забывалась после первого окна, и к середине
        # записи Whisper терял пунктуацию), батч ускоряет в несколько раз,
        # а гипотезы GigaAM и Whisper совпадают по границам.
        pipeline = BatchedInferencePipeline(model=model)
        segments, _ = pipeline.transcribe(
            audio, language="ru", beam_size=5, word_timestamps=True, initial_prompt=prompt,
            clip_timestamps=[{"start": c.start, "end": c.end} for c in chunks],
            batch_size=int(os.environ.get("WHISPER_BATCH", "4")), temperature=0.0)
        words = []
        for seg in segments:
            for w in seg.words or []:
                words.append([round(w.start, 2), round(w.end, 2), w.word])
        del pipeline, model
        _free_gpu()
        _save(cache, words)
    # Слово уходит в тот чанк, куда попадает его середина (или в ближайший).
    starts = np.array([c.start for c in chunks])
    buckets: list[list[str]] = [[] for _ in chunks]
    for s, e, w in words:
        mid = (s + e) / 2
        i = int(np.searchsorted(starts, mid, side="right")) - 1
        i = max(0, i)
        if i + 1 < len(chunks) and mid > chunks[i].end and chunks[i + 1].start - mid < mid - chunks[i].end:
            i += 1
        buckets[i].append(w)
    for c, b in zip(chunks, buckets):
        c.whisper = "".join(b).strip()


def chunks_to_json(chunks: list[Chunk]) -> list[dict]:
    return [asdict(c) for c in chunks]
