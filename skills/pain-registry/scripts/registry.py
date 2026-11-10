"""Реестр болей без интерфейса: проверка цитат, счёт клиентов, приоритет, бэклог.

Извлечение, темы и формулировки задач делает Claude и пишет их в registry.json
(формат ниже). Скрипт делает то, что нельзя доверять модели: сверяет каждую цитату
с исходником, считает разных клиентов, а не упоминания, и считает приоритет по формуле.

    python registry.py registry.json [--out ПАПКА]

registry.json:
{
  "sources": [{"id": "S1", "path": "C:/.../встреча.txt", "org": "Металлургия", "segment": "LE", "date": "2026-08-28"}],
  "items":   [{"source": "S1", "quote": "дословно из исходника", "summary": "суть одной фразой",
               "type": "pain", "category": "quality", "severity": 2, "theme": "T1", "ts": "00:12:34"}],
  "themes":  [{"id": "T1", "title": "до 7 слов", "statement": "у кого и что болит"}],
  "backlog": [{"title": "Сделать ...", "kind": "feature", "problem": "...", "proposal": "...",
               "acceptance": ["..."], "themes": ["T1"]}]
}
segment: SMB, enterprise и т.п. или «внутренний» (коллеги, внутренние команды). type: pain, request, blocker, praise, question.
"""
import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

WEIGHTS = {"orgExt": 10, "orgInt": 3, "blocker": 8, "severity": 2, "recency": 5}  # как в прототипе
TYPE_RU = {"pain": "Боль", "request": "Запрос", "blocker": "Блокер сделки", "praise": "Похвала", "question": "Вопрос"}
TEXT_EXT = {".txt", ".md", ".vtt", ".srt", ".csv", ".tsv", ".json", ".html", ".htm", ".eml", ".log"}


def norm(text: str) -> str:
    text = text.lower().replace("ё", "е")
    text = re.sub(r"[«»\"'“”„.,!?;:()\[\]-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def check_quote(quote: str, source_text: str) -> str:
    """verified: дословно; approx: почти все слова цитаты идут подряд в исходнике; missing: не найдена."""
    q, src = norm(quote), norm(source_text)
    if q and q in src:
        return "verified"
    words = q.split()
    if len(words) >= 4:
        # окно из 70% слов цитаты подряд: модель могла поправить пару слов, но не придумать фразу
        k = max(4, int(len(words) * 0.7))
        if any(" ".join(words[i:i + k]) in src for i in range(len(words) - k + 1)):
            return "approx"
    return "missing"


def is_internal(segment: str) -> bool:
    return "внутр" in (segment or "").lower()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("registry", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    reg = json.loads(args.registry.read_text("utf-8"))
    out = args.out or args.registry.parent
    out.mkdir(parents=True, exist_ok=True)

    sources = {s["id"]: s for s in reg["sources"]}
    texts = {}
    for sid, s in sources.items():
        p = Path(s["path"])
        if p.suffix.lower() not in TEXT_EXT:
            raise SystemExit(f"{p.name}: сначала переведи файл в .txt или .md, сверять цитаты можно только по тексту")
        texts[sid] = p.read_text("utf-8", errors="replace")

    for it in reg["items"]:
        it["quote_status"] = check_quote(it.get("quote", ""), texts.get(it["source"], ""))
    live = [it for it in reg["items"] if it["quote_status"] != "missing" and it.get("type") != "praise"]

    dates = sorted(s["date"] for s in sources.values() if s.get("date"))
    latest = date.fromisoformat(dates[-1]) if dates else None

    by_theme = defaultdict(list)
    for it in live:
        by_theme[it.get("theme")].append(it)

    themes = {t["id"]: t for t in reg.get("themes", [])}
    rows = []
    for b in reg.get("backlog", []):
        items = [it for t in b["themes"] for it in by_theme.get(t, [])]
        org = lambda it: sources[it["source"]].get("org") or sources[it["source"]]["id"]  # noqa: E731
        ext = {org(it) for it in items if not is_internal(sources[it["source"]].get("segment"))}
        internal = {org(it) for it in items if is_internal(sources[it["source"]].get("segment"))}
        blockers = {org(it) for it in items if it.get("type") == "blocker"}
        sev = sum(it.get("severity", 2) for it in items) / len(items) if items else 0
        recent = 0.0
        if latest and items:
            fresh = [it for it in items if sources[it["source"]].get("date")
                     and (latest - date.fromisoformat(sources[it["source"]]["date"])).days <= 45]
            recent = len(fresh) / len(items)
        parts = [("Внешние клиенты", len(ext), WEIGHTS["orgExt"]),
                 ("Внутренние источники", len(internal), WEIGHTS["orgInt"]),
                 ("Клиенты с блокером сделки", len(blockers), WEIGHTS["blocker"]),
                 ("Средняя критичность (1-3)", round(sev, 2), WEIGHTS["severity"]),
                 ("Доля свежих (45 дней)", round(recent, 2), WEIGHTS["recency"])]
        score = round(sum(v * w for _, v, w in parts))
        rows.append({**b, "score": score, "parts": parts, "clients": sorted(ext), "internal": sorted(internal),
                     "blockers": sorted(blockers), "items": items})
    rows.sort(key=lambda r: -r["score"])
    empty = [r for r in rows if not r["items"]]  # все цитаты не прошли сверку: в бэклог не ставим
    rows = [r for r in rows if r["items"]]

    total = len(reg["items"])
    status = defaultdict(int)
    for it in reg["items"]:
        status[it["quote_status"]] += 1
    md = ["# Бэклог из обратной связи", "",
          f"Источников: {len(sources)} · единиц: {total} · цитаты дословно: {status['verified']}, "
          f"близко: {status['approx']}, не найдены: {status['missing']} (в бэклог не попали)", ""]
    for n, r in enumerate(rows, 1):
        md += [f"## {n}. {r['title']} · скор {r['score']}", "",
               f"**Клиенты:** {', '.join(r['clients']) or 'нет'}"
               + (f" · **внутренние:** {', '.join(r['internal'])}" if r["internal"] else "")
               + (f" · **блокер у:** {', '.join(r['blockers'])}" if r["blockers"] else ""), "",
               f"**Проблема.** {r.get('problem', '')}", "", f"**Что сделать.** {r.get('proposal', '')}", "",
               "**Критерии приёмки:**"] + [f"- {a}" for a in r.get("acceptance", [])] + [
               "", "**Из чего скор:** " + "; ".join(f"{k} {v} × {w}" for k, v, w in r["parts"]), "",
               "**Цитаты:**"]
        for it in r["items"]:
            s = sources[it["source"]]
            where = f"{s.get('org') or s['id']}, {s.get('date', '')}" + (f", {it['ts']}" if it.get("ts") else "")
            mark = "" if it["quote_status"] == "verified" else " (≈)"
            md.append(f"- «{it['quote']}»{mark} - {where}, {Path(s['path']).name}")
        md.append("")
    if empty:
        md += ["## Пункты без подтверждённых цитат", ""] + [f"- {r['title']}" for r in empty] + [""]
    missing = [it for it in reg["items"] if it["quote_status"] == "missing"]
    if missing:
        md += ["## Цитаты, которых нет в исходниках", "", "Проверь руками: модель могла пересказать вместо цитаты.", ""]
        md += [f"- [{it['source']}] «{it['quote']}»" for it in missing]
    (out / "backlog.md").write_text("\n".join(md) + "\n", "utf-8")

    with open(out / "backlog.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Приоритет", "Задача", "Тип", "Скор", "Клиентов", "Клиенты", "Блокер у", "Проблема",
                    "Что сделать", "Критерии приёмки"])
        for n, r in enumerate(rows, 1):
            w.writerow([n, r["title"], r.get("kind", ""), r["score"], len(r["clients"]), ", ".join(r["clients"]),
                        ", ".join(r["blockers"]), r.get("problem", ""), r.get("proposal", ""),
                        " | ".join(r.get("acceptance", []))])
    args.registry.write_text(json.dumps(reg, ensure_ascii=False, indent=1), "utf-8")
    print(f"бэклог: {out / 'backlog.md'} · пунктов {len(rows)} · цитат не найдено {status['missing']} из {total}")
    unthemed = [it for it in live if it.get("theme") not in themes]
    if unthemed:
        print(f"без темы или с неизвестной темой: {len(unthemed)} единиц")


if __name__ == "__main__":
    main()
