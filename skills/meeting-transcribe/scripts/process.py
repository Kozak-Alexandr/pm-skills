"""LLM-шаги: сведение двух гипотез ASR в чистовую стенограмму и структурное саммари."""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from llm import chat_json

from settings import GLOSSARY
BATCH = 20


def glossary() -> str:
    return GLOSSARY.read_text("utf-8") if GLOSSARY.exists() else ""


def asr_hint() -> str:
    text = glossary()
    if "## Подсказка ASR" not in text:
        return ""
    block = text.split("## Подсказка ASR", 1)[1].split("\n## ", 1)[0]
    return " ".join(l for l in block.splitlines() if l.strip() and not l.startswith("<!--")).strip()


def ts(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def parse_ts(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    parts = [float(p) for p in str(value).strip().split(":") if p.strip()]
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


CORRECT_SYSTEM = """Ты - редактор стенограмм рабочих встреч. Для каждого фрагмента речи даны две независимые гипотезы распознавания одного и того же звука:
A - GigaAM v3 (сильна в русской речи, но пишет английские термины кириллицей или коверкает их, оставляет «э-э»);
B - Whisper large-v3 (хорошо пишет термины, названия, числа и пунктуацию, но иногда пропускает начало или куски фразы и упрощает разговорные слова).

Задача - восстановить чистовой текст того, что реально сказал человек. Гипотезы равноправны: сравни их пословно и там, где расходятся, выбирай вариант, который осмысленнее, грамматически согласован и соответствует словарю. Примеры:
- A «в нашем схеме», B «в нашем SIEM» → «в нашем SIEM» (SIEM - мужской род, «схема» тут ошибка ASR);
- A «размечают риво», B «размечают очень криво» → «размечают очень криво»;
- A «3 000 янцов», B «3000 инцидентов» → «3000 инцов» или «3000 инцидентов» (как сказано);
- A содержит слова, которых нет в B (B пропустил) → бери их из A.

Правила чистового текста:
- Всегда удаляй междометия и паразиты: «э-э», «э-э-э», «м-м», «и-и-и», «вот» в конце фразы, «ну» в начале, «типа», «как бы», «там» как связку; удаляй заикания и повторы («с чем, с чем» → «с чем»).
- Не пересказывай и не сокращай смысл, ничего не добавляй от себя, сохраняй разговорный стиль и сленг (тачка, фолзить, инцы).
- Термины, продукты, имена - как в словаре ниже (латиница там, где она в словаре). Числа - цифрами. Нормальная пунктуация.
- Если фрагмент - шум или неразборчив в обеих гипотезах, верни пустую строку.

Ответ - только JSON-массив [{"id": <число>, "text": "<текст>"}] для каждого входного id, без пояснений.

Словарь и контекст компании:
"""


def correct(chunks: list[dict], backend: str, cache: Path, context: str = "") -> None:
    """Сведение гипотез пачками по BATCH фрагментов, несколько пачек параллельно.
    Длинные пачки модель «ленится» и копирует гипотезу A, поэтому пачки короткие;
    размышление заметно чище убирает паразиты и выбирает верный термин (CORRECT_THINKING=0 - без него).
    context - известные факты о встрече (заказчик, участники, продукты): без них модель
    угадывает названия и пишет, например, «Финам» вместо «Тринфико»."""
    done: dict[str, str] = json.loads(cache.read_text("utf-8")) if cache.exists() else {}
    system = CORRECT_SYSTEM + glossary()
    if context:
        system += ("\n\nИзвестно об этой встрече (главнее словаря и догадок; незнакомое название, похожее по звучанию,"
                   " исправляй на название отсюда, а если не похоже ни на что - оставляй как в гипотезах):\n" + context)
    thinking = os.environ.get("CORRECT_THINKING", "1") != "0"
    batches = [chunks[i:i + BATCH] for i in range(0, len(chunks), BATCH)]
    todo = [b for b in batches if not all(str(c["id"]) in done for c in b)]

    def run(batch: list[dict]) -> list[dict]:
        items = [{"id": c["id"], "A": c["giga"], "B": c["whisper"]} for c in batch]
        return chat_json(backend, system, json.dumps(items, ensure_ascii=False), max_tokens=6000, thinking=thinking)

    workers = 1 if backend == "local" else int(os.environ.get("LLM_WORKERS", "4"))
    with ThreadPoolExecutor(workers) as pool:
        for n, result in enumerate(pool.map(run, todo), 1):
            for item in result:
                done[str(item["id"])] = (item.get("text") or "").strip()
            cache.write_text(json.dumps(done, ensure_ascii=False, indent=1), "utf-8")
            print(f"  исправлено пачек {n}/{len(todo)}", flush=True)
    for c in chunks:
        # Если модель потеряла фрагмент - лучше сырой GigaAM, чем дыра в стенограмме.
        c["text"] = done.get(str(c["id"]), c["giga"])


SUMMARY_SYSTEM = """Ты - ассистент продакт-менеджера. Продукт, термины и люди описаны в словаре контекста ниже. Тебе дают стенограмму рабочей встречи с таймкодами [мм:сс] и метками спикеров SPEAKER_XX (метки от автоматической диаризации, могут слегка ошибаться).
Сделай структурный разбор встречи. Пиши по-русски, по сути, без воды. Опирайся только на стенограмму: не выдумывай факты, имена, сроки. Если чего-то нет - не заполняй.

Верни только JSON такого вида:
{
 "title": "короткое название встречи",
 "meeting_type": "синк / интервью / кастдев / демо / планирование / 1:1 / другое",
 "speakers": {"SPEAKER_00": {"name": "имя или null, если не звучит", "role": "роль/компания, если понятно", "evidence": "по какой фразе понял"}},
 "tldr": "2-3 предложения: о чём встреча и чем закончилась",
 "topics": [{"title": "тема", "start": "мм:сс", "end": "мм:сс", "bullets": [{"text": "ключевая мысль, факт или аргумент - одно предложение", "t": "мм:сс"}]}],
 "decisions": [{"text": "что решили", "t": "мм:сс"}],
 "action_items": [{"owner": "кто (имя или спикер)", "task": "что сделать", "due": "срок, если назван", "t": "мм:сс"}],
 "open_questions": [{"text": "что осталось нерешённым", "t": "мм:сс"}],
 "quotes": [{"text": "1-3 самые сильные дословные цитаты", "speaker": "SPEAKER_XX", "t": "мм:сс"}],
 "kb": {
   "people": [{"name": "каноническое имя", "aliases": ["как ещё называли"], "role": "должность/роль", "team": "команда/отдел", "company": "компания", "manager": "руководитель, если звучит", "facts": ["факт о человеке из встречи: зона ответственности, чем занят"]}],
   "teams": [{"name": "команда/отдел", "parent": "вышестоящее подразделение", "lead": "руководитель", "company": "компания"}],
   "projects": [{"name": "проект/продукт/инициатива", "owner": "кто ведёт", "status": "статус, если звучит", "description": "одна строка"}],
   "tasks": [{"owner": "кто", "task": "что", "project": "к чему относится", "due": "срок", "status": "open/done"}]
 },
 "new_terms": [{"term": "термин, продукт, имя или аббревиатура, которых нет в словаре, но которые звучат на встрече", "note": "что это"}]
}
Правила по разделу kb: это база знаний об оргструктуре, людях и задачах - в неё попадают только факты, прямо прозвучавшие на встрече.
- Только реальные люди с именем (в именительном падеже: «Женя», а не «Жень»). Метки SPEAKER_XX, «Спикер», «Команда», отделы - не люди, в people их не включай.
- role, team, manager, company - только если это прямо сказано или однозначно следует из сказанного; иначе null. Не угадывай должности.
- Имена приводи к написанию из списка известных людей ниже, если это явно тот же человек. Не дублируй одного человека под разными именами.
- В tasks и action_items owner - имя человека; если исполнитель - говорящий без имени, пиши его метку SPEAKER_XX.
Каждый буллет, решение, вопрос и цитата - объект с полями text и t, а не строка.
Темы - в хронологическом порядке, 3-8 буллетов на тему, буллеты содержательные (цифры, аргументы, договорённости), а не «обсудили X».
"""


CUSTDEV_SYSTEM = """
Это кастдев: интервью продакт-менеджера с потенциальным заказчиком (часто вместе с показом продукта). meeting_type = "кастдев".
Отличай, кто говорит: факты о заказчике, его боли и ожидания бери только из реплик людей заказчика; то, что рассказывают сотрудники нашей компании о продукте, фактом о заказчике не является. В speakers.role пиши компанию и роль, например «Ромашка, ИТ-директор» или «мы, продукт».
В tldr: кто заказчик, как он решает задачу сегодня, главное ожидание и чем закончилось.
Добавь в JSON ключ "custdev":
"custdev": {
 "company": "название компании заказчика",
 "segment": "SMB, mid-market или enterprise, если понятно",
 "profile": [{"k": "Отрасль", "v": "..."}, {"k": "Масштаб", "v": "сотрудники, пользователи, площадки"}, {"k": "Требования и регуляторика", "v": "..."}, {"k": "Как решают задачу сегодня", "v": "инструменты, люди, процессы"}, {"k": "Кто принимает решение", "v": "..."}, {"k": "Статус", "v": "готовность к пилоту, следующий шаг"}],
 "sections": [
   {"title": "Как решают задачу сегодня", "bullets": [{"text": "...", "t": "мм:сс"}]},
   {"title": "Боли и риски", "bullets": []},
   {"title": "Что хотят от решения", "bullets": []},
   {"title": "Вопросы и опасения", "bullets": []},
   {"title": "Экономика и процесс покупки", "bullets": []},
   {"title": "Договорённости", "bullets": []}
 ],
 "signals": [{"text": "вывод для продукта: что делать, как позиционировать, чего избегать, с опорой на сказанное", "t": "мм:сс"}]
}
Пиши буллеты коротко и конкретно (цифры, названия, дословные формулировки заказчика в кавычках). Если по разделу ничего не прозвучало, оставь пустой список и в profile пиши «не прозвучало». signals: 4-7 пунктов.
"""


NOT_PEOPLE = re.compile(r"^(speaker_?\d*|спикер.*|команда.*|участник.*|все|null|none|аналитики.*)$", re.I)


def normalize_summary(summary: dict) -> dict:
    """Модели иногда отдают буллеты строками и заводят «SPEAKER_00» человеком - чиним кодом."""
    def items(value):
        return [{"text": x} if isinstance(x, str) else x for x in (value or []) if x]
    for topic in summary.get("topics") or []:
        topic["bullets"] = items(topic.get("bullets"))
    for key in ("decisions", "open_questions", "quotes", "action_items"):
        summary[key] = items(summary.get(key))
    cd = summary.get("custdev")
    if isinstance(cd, dict):
        for section in cd.get("sections") or []:
            section["bullets"] = items(section.get("bullets"))
        cd["signals"] = items(cd.get("signals"))
        cd["profile"] = [p for p in cd.get("profile") or [] if isinstance(p, dict) and p.get("v")]
    kb = summary.setdefault("kb", {})
    kb["people"] = [p for p in kb.get("people") or []
                    if isinstance(p, dict) and p.get("name") and not NOT_PEOPLE.match(p["name"].strip())]
    for t in kb.get("teams") or []:
        if t.get("lead") and NOT_PEOPLE.match(str(t["lead"]).strip()):
            t["lead"] = None
    for pr in kb.get("projects") or []:
        if pr.get("owner") and NOT_PEOPLE.match(str(pr["owner"]).strip()):
            pr["owner"] = None
    return summary


def summarize(chunks: list[dict], backend: str, people_context: str, meeting_meta: str,
              custdev: bool = False) -> dict:
    lines = []
    for c in chunks:
        if c["text"]:
            lines.append(f"[{ts(c['start'])}] {c['speaker']}: {c['text']}")
    system = (SUMMARY_SYSTEM + (CUSTDEV_SYSTEM if custdev else "")
              + "\nИзвестные люди (имя - роль - варианты):\n" + (people_context or "пока нет")
              + "\n\nСловарь и контекст компании:\n" + glossary())
    user = meeting_meta + "\n\nСтенограмма:\n" + "\n".join(lines)
    return normalize_summary(chat_json(backend, system, user, max_tokens=12000, thinking=True, timeout=1800))
