"""Расшифровка встречи: звук → стенограмма → саммари → отчёт → база знаний и mind map.

    python transcribe.py "C:/Users/me/Downloads/встреча.mp3"

Стадии кэшируются в out/<дата>_<имя>/, повторный запуск продолжает с места падения.
Сменить LLM без повторного распознавания: тот же файл с другим --llm.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import asr  # noqa: E402
import settings  # noqa: E402
import kb  # noqa: E402
import process  # noqa: E402
import report  # noqa: E402
from llm import ENV, default_backend  # noqa: E402


def meeting_date(src: Path) -> str:
    m = re.search(r"(20\d\d)[-_.](\d\d)[-_.](\d\d)", src.name)
    if m:
        return "-".join(m.groups())
    return dt.date.fromtimestamp(src.stat().st_mtime).isoformat()


def slug(text: str) -> str:
    return re.sub(r"[^\w-]+", "_", text, flags=re.U).strip("_")[:60]


TEXT_SUFFIXES = {".txt", ".md"}
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня",
          "июля", "августа", "сентября", "октября", "ноября", "декабря")


def text_meeting(src: Path) -> tuple[str, str, list[dict]]:
    """Готовая текстовая транскрипция (Контур.Толк, Телемост): «чч:мм:сс<TAB>Имя<TAB>текст».
    Возвращает название, дату и фрагменты в формате конвейера; спикер - имя из файла,
    обе «гипотезы» равны тексту, сведение просто чистит его по словарю."""
    lines = src.read_text("utf-8-sig").splitlines()
    title, date = src.stem, meeting_date(src)
    head = re.match(r'Транскрипция записи "(.+?)"\s+(\d{1,2}) (\S+) (20\d\d)', lines[0]) if lines else None
    if head:
        title = head.group(1)
        if head.group(3) in MONTHS:
            date = f"{head.group(4)}-{MONTHS.index(head.group(3)) + 1:02d}-{int(head.group(2)):02d}"
    rows = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) >= 3 and re.fullmatch(r"\d{1,2}(:\d\d){1,2}", parts[0].strip()) and parts[2].strip():
            rows.append((process.parse_ts(parts[0].strip()), parts[1].strip(), "\t".join(parts[2:]).strip()))
    if not rows:
        sys.exit(f"В {src.name} не нашёл строк вида «00:01:05<TAB>Имя<TAB>текст»")
    rows.sort(key=lambda r: r[0])
    chunks = []
    for i, (start, speaker, text) in enumerate(rows):
        # Конец реплики в файле не указан: до следующей, но не дольше, чем её можно произнести (~15 знаков/с).
        nxt = rows[i + 1][0] if i + 1 < len(rows) else start + len(text) / 15
        end = max(start + 1, min(nxt, start + len(text) / 15 + 2))
        chunks.append({"id": i, "start": start, "end": round(end, 1), "speaker": speaker,
                       "giga": text, "whisper": text})
    return title, date, chunks


def hf_token() -> str | None:
    token = os.environ.get("HF_TOKEN")
    env_file = settings.HOME / ".env"
    if not token and env_file.exists():
        for line in env_file.read_text("utf-8").splitlines():
            if line.startswith("HF_TOKEN="):
                token = line.split("=", 1)[1].strip()
    return token or None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", type=Path, help="запись встречи или готовая текстовая транскрипция (.txt)")
    ap.add_argument("--llm", choices=["api", "claude", "local"], default=default_backend(),
                    help="api: OpenAI-совместимый API из ~/.llm.env; claude: Claude Code CLI; local: Ollama и т.п.")
    ap.add_argument("--custdev", action="store_true",
                    help="кастдев: профиль заказчика, боли, ожидания, сигналы для продукта; без базы знаний о коллегах")
    ap.add_argument("--context", help="что известно о встрече: заказчик, участники, продукты, как их коверкает "
                                      "распознавание (текст или путь к .txt/.md); главнее догадок модели")
    ap.add_argument("--speakers", type=int, help="точное число говорящих, если известно")
    ap.add_argument("--no-diar", action="store_true", help="без разделения на спикеров")
    ap.add_argument("--asr-only", action="store_true", help="только распознавание, без LLM")
    ap.add_argument("--out", type=Path, default=settings.OUT)
    args = ap.parse_args()

    src = args.audio.resolve()
    started = time.time()
    lap = lambda name: print(f"[{time.time() - started:6.0f} с] {name}", flush=True)  # noqa: E731

    if src.suffix.lower() in TEXT_SUFFIXES:
        # Звука нет: распознавание пропускаем, дальше тот же конвейер (сведение, саммари, отчёт).
        title, date, data = text_meeting(src)
        folder = args.out / f"{date}_{slug(title)}"
        folder.mkdir(parents=True, exist_ok=True)
        duration = max(c["end"] for c in data)
        sig = "t" + hashlib.sha1(json.dumps([(c["start"], c["speaker"], c["giga"]) for c in data],
                                            ensure_ascii=False).encode()).hexdigest()[:7]
        print(f"  текстовая транскрипция: {len(data)} реплик, {len({c['speaker'] for c in data})} спикеров")
        (folder / "chunks_raw.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
        finish(args, src, folder, date, duration, data, sig, None, lap)
        return

    date = meeting_date(src)
    folder = args.out / f"{date}_{slug(src.stem)}"
    folder.mkdir(parents=True, exist_ok=True)

    lap("подготовка звука")
    wav = folder / "audio.wav"
    asr.prepare_audio(src, wav)
    player = folder / "audio.m4a"
    if not player.exists():
        subprocess.run([asr.ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1",
                        "-c:a", "aac", "-b:a", "64k", str(player)], check=True)
    audio = asr.load_wav(wav)
    duration = len(audio) / asr.SR

    lap("диаризация")
    turns = asr.diarize(audio, folder / "diarization.json", None if args.no_diar else hf_token(), args.speakers)
    lap("поиск речи (VAD)")
    segments = asr.speech_segments(audio, folder / "vad.json")
    chunks = asr.make_chunks(segments, turns)
    # Подпись нарезки: кэши, завязанные на фрагменты, валидны только для неё
    # (например, после добавления диаризации нарезка меняется и всё пересчитывается).
    sig = hashlib.sha1(json.dumps([(c.start, c.end, c.speaker) for c in chunks]).encode()).hexdigest()[:8]
    print(f"  {len(chunks)} фрагментов, {len({c.speaker for c in chunks})} спикеров, нарезка {sig}")

    hint = process.asr_hint()
    names = [p["name"] for p in kb.merged()["people"].values()][:20]
    if names:
        hint += " Участники: " + ", ".join(names) + "."
    lap("GigaAM v3")
    asr.run_gigaam(audio, chunks, folder / f"asr_gigaam_{sig}.json", folder)
    lap("Whisper large-v3")
    asr.run_whisper(audio, chunks, folder / f"asr_whisper_{sig}.json", hint)
    data = asr.chunks_to_json(chunks)
    (folder / "chunks_raw.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    if args.asr_only:
        for c in data:
            c["text"] = c["giga"]
        report.write_markdown(folder, {"date": date, "duration": duration, "source": src.name}, {}, data)
        lap(f"готово: {folder / 'transcript.md'}")
        return
    finish(args, src, folder, date, duration, data, sig, player.name, lap)


def finish(args, src: Path, folder: Path, date: str, duration: float, data: list[dict], sig: str,
           audio_name: str | None, lap) -> None:
    """Общая часть для записи и для текста: сведение, саммари, отчёт, база знаний."""
    context = args.context or ""
    if context and Path(context).is_file():
        context = Path(context).read_text("utf-8")
    if context:
        # Другой контекст даёт другой текст: кэши LLM-стадий разводим по нему.
        sig += "c" + hashlib.sha1(context.encode()).hexdigest()[:4]
    lap(f"исправление стенограммы ({args.llm})")
    process.correct(data, args.llm, folder / f"corrected_{args.llm}_{sig}.json", context)
    (folder / "chunks.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")

    lap(f"саммари ({args.llm})")
    meta = {"date": date, "duration": round(duration, 1), "source": src.name, "llm": args.llm}
    kind = "custdev" if args.custdev else "summary"
    summary_file = folder / f"{kind}_{args.llm}_{sig}.json"
    if summary_file.exists():
        summary = process.normalize_summary(json.loads(summary_file.read_text("utf-8")))
    else:
        summary = process.summarize(data, args.llm, kb.people_context(),
                                    f"Дата встречи: {date}. Длительность: {process.ts(duration)}. Файл: {src.name}."
                                    + ("" if audio_name else " Метки спикеров здесь не SPEAKER_XX, а имена из файла"
                                       " транскрипции (бывают латиницей); ключи speakers - эти метки как есть.")
                                    + (f"\n\nИзвестно о встрече (это факты, они главнее догадок по стенограмме):\n{context}"
                                       if context else ""),
                                    custdev=args.custdev)
        summary_file.write_text(json.dumps(summary, ensure_ascii=False, indent=1), "utf-8")

    lap("отчёт")
    report.resolve_owners(summary)
    report.write_markdown(folder, meta, summary, data)
    html = report.write_html(folder, meta, summary, data, audio_name)
    try:
        pdf = report.write_pdf(html)
    except Exception as error:  # PDF для удобства, конвейер из-за него не падает
        print(f"  PDF не собран: {error}")
        pdf = None

    if args.custdev:
        # Люди заказчика не коллеги: в оргструктуру и mind map их не несём, только новые термины.
        added = kb.add_candidates(f"{date} {summary.get('title', '')}", summary.get("new_terms") or [])
        lap("готово")
        print(f"  отчёт:      {html}")
        if pdf:
            print(f"  PDF:        {pdf}")
        print(f"  саммари:    {folder / 'summary.md'}")
        if added:
            print(f"  новых терминов-кандидатов в словарь: {added}: {kb.CANDIDATES}")
        return

    lap("база знаний и mind map")
    meeting_id = folder.name
    kb.save_meeting(meeting_id, {**meta, "report": str(html)}, summary)
    added = kb.add_candidates(f"{date} {summary.get('title', '')}", summary.get("new_terms") or [])
    kb.update_glossary_people()
    mindmap = kb.build_mindmap()

    lap("готово")
    print(f"  отчёт:      {html}")
    if pdf:
        print(f"  PDF:        {pdf}")
    print(f"  саммари:    {folder / 'summary.md'}")
    print(f"  стенограмма:{folder / 'transcript.md'}")
    print(f"  mind map:   {mindmap}")
    if added:
        print(f"  новых терминов-кандидатов в словарь: {added} → {kb.CANDIDATES}")


if __name__ == "__main__":
    main()
