"""База знаний из встреч: люди, команды, проекты, задачи - и mind map по ней.

kb/people.yaml          - канонический справочник (правится руками, главнее всего);
kb/meetings/<id>.json   - что LLM извлекла из каждой встречи;
kb/mindmap.html         - интерактивная карта (markmap), собирается из всего выше.
"""
from __future__ import annotations

import html
import json
import re
from collections import defaultdict
from pathlib import Path

import yaml

from settings import GLOSSARY, HOME as ROOT, KB
PEOPLE = KB / "people.yaml"
MEETINGS = KB / "meetings"
CANDIDATES = KB / "glossary-candidates.md"


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").lower().replace("ё", "е")).strip()


def load_directory() -> dict:
    if PEOPLE.exists():
        return yaml.safe_load(PEOPLE.read_text("utf-8")) or {}
    return {}


def people_context() -> str:
    """Список известных людей для промпта: помогает LLM узнать человека и написать имя одинаково."""
    people = merged()["people"]
    return "\n".join(
        f"- {p['name']} - {', '.join(x for x in (p.get('role'), p.get('team'), p.get('company')) if x)}"
        + (f" - зовут также: {', '.join(p['aliases'])}" if p.get("aliases") else "")
        for p in people.values())


def save_meeting(meeting_id: str, meta: dict, summary: dict) -> None:
    MEETINGS.mkdir(parents=True, exist_ok=True)
    data = {"id": meeting_id, **meta, "title": summary.get("title"), "kb": summary.get("kb", {}),
            "action_items": summary.get("action_items", []), "decisions": summary.get("decisions", [])}
    (MEETINGS / f"{meeting_id}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")


def merged() -> dict:
    directory = load_directory()
    people: dict[str, dict] = {}
    alias: dict[str, str] = {}

    def resolve(name: str) -> str:
        key = norm(name)
        return alias.get(key, key)

    def upsert(p: dict, source: str | None, canonical: bool) -> None:
        if not p.get("name"):
            return
        key = resolve(p["name"])
        cur = people.setdefault(key, {"name": p["name"], "aliases": [], "facts": [], "meetings": []})
        for field in ("role", "team", "company", "manager"):
            if p.get(field) and (canonical or not cur.get(f"_{field}_canon")):
                cur[field] = p[field]
                if canonical:
                    cur[f"_{field}_canon"] = True
        for a in p.get("aliases") or []:
            if a and a not in cur["aliases"] and norm(a) != key:
                cur["aliases"].append(a)
            alias.setdefault(norm(a), key)
        alias.setdefault(norm(p["name"]), key)
        for f in p.get("facts") or []:
            if f not in cur["facts"]:
                cur["facts"].append(f)
        if source and source not in cur["meetings"]:
            cur["meetings"].append(source)

    for p in directory.get("people") or []:
        upsert(p, None, True)
    teams: dict[str, dict] = {norm(t["name"]): dict(t) for t in directory.get("teams") or [] if t.get("name")}
    projects: dict[str, dict] = {}
    tasks: dict[tuple, dict] = {}
    meetings = []
    for path in sorted(MEETINGS.glob("*.json")):
        m = json.loads(path.read_text("utf-8"))
        label = f"{m.get('date', '')} {m.get('title') or m['id']}".strip()
        meetings.append({"id": m["id"], "label": label, "report": m.get("report")})
        kb = m.get("kb") or {}
        for p in kb.get("people") or []:
            upsert(p, label, False)
        for t in kb.get("teams") or []:
            if t.get("name"):
                cur = teams.setdefault(norm(t["name"]), {"name": t["name"]})
                for field in ("parent", "lead", "company"):
                    if t.get(field) and not cur.get(field):
                        cur[field] = t[field]
        for pr in kb.get("projects") or []:
            if pr.get("name"):
                cur = projects.setdefault(norm(pr["name"]), {"name": pr["name"]})
                cur.update({k: v for k, v in pr.items() if v})
        # kb.tasks и action_items обычно пересказывают одно и то же разными словами -
        # берём kb.tasks, а action_items только если модель задачи в kb не вынесла.
        for t in kb.get("tasks") or [
                {"owner": a.get("owner"), "task": a.get("task"), "due": a.get("due"), "status": "open"}
                for a in m.get("action_items") or []]:
            if not t.get("task"):
                continue
            owner = people.get(resolve(t.get("owner") or ""), {}).get("name") or t.get("owner") or "-"
            key = (norm(owner), norm(t["task"])[:60])
            cur = tasks.setdefault(key, {"owner": owner, "task": t["task"], "meeting": label})
            cur.update({k: v for k, v in t.items() if v and k not in ("owner", "task")})
    for p in people.values():
        for k in [k for k in p if k.startswith("_")]:
            p.pop(k)
    return {"people": people, "teams": teams, "projects": projects, "tasks": list(tasks.values()),
            "meetings": meetings}


def _md(text) -> str:
    # markmap читает markdown: экранируем то, что сломает разметку.
    return re.sub(r"([\[\]#*_`])", r"\\\1", str(text or "")).replace("\n", " ")


def mindmap_markdown(data: dict) -> str:
    people, teams, projects, tasks = data["people"], data["teams"], data["projects"], data["tasks"]
    tasks_by_owner = defaultdict(list)
    for t in tasks:
        tasks_by_owner[norm(t["owner"])].append(t)

    def person_line(p: dict) -> str:
        role = f" - {_md(p['role'])}" if p.get("role") else ""
        return f"**{_md(p['name'])}**{role}"

    def task_line(t: dict) -> str:
        due = f" · до {_md(t['due'])}" if t.get("due") else ""
        done = "~~" if t.get("status") == "done" else ""
        return f"{done}{_md(t['task'])}{done}{due}"

    out = ["# Люди, команды, задачи", "", "## Оргструктура"]
    members = defaultdict(list)
    for p in people.values():
        members[norm(p.get("team") or "")].append(p)
    for key in list(members):
        if key and key not in teams:
            teams[key] = {"name": members[key][0]["team"]}
    children = defaultdict(list)
    for key, t in teams.items():
        parent = norm(t.get("parent") or "")
        children[parent if parent in teams else ("company:" + norm(t.get("company") or ""))].append(key)

    def emit_team(key: str, depth: int) -> None:
        t = teams[key]
        lead = f" (рук. {_md(t['lead'])})" if t.get("lead") else ""
        out.append("  " * depth + f"- {_md(t['name'])}{lead}")
        for p in sorted(members.get(key, []), key=lambda x: x["name"]):
            out.append("  " * (depth + 1) + f"- {person_line(p)}")
        for child in sorted(children.get(key, []), key=lambda k: teams[k]["name"]):
            emit_team(child, depth + 1)

    companies = sorted({k for k in children if k.startswith("company:")})
    for c in companies:
        name = c.split(":", 1)[1] or "Компания не указана"
        title = next((teams[k].get("company") for k in children[c] if teams[k].get("company")), name)
        out.append(f"- {_md(title)}")
        for key in sorted(children[c], key=lambda k: teams[k]["name"]):
            emit_team(key, 1)
    loose = members.get("", [])
    if loose:
        out.append("- Команда не указана")
        for p in sorted(loose, key=lambda x: x["name"]):
            out.append(f"  - {person_line(p)}")

    out += ["", "## Проекты"]
    tasks_by_project = defaultdict(list)
    for t in tasks:
        tasks_by_project[norm(t.get("project") or "")].append(t)
    for key, pr in sorted(projects.items(), key=lambda kv: kv[1]["name"]):
        meta = ", ".join(_md(x) for x in (pr.get("owner"), pr.get("status")) if x)
        out.append(f"- **{_md(pr['name'])}**" + (f" - {meta}" if meta else ""))
        if pr.get("description"):
            out.append(f"  - {_md(pr['description'])}")
        for t in tasks_by_project.pop(key, []):
            out.append(f"  - {task_line(t)} - {_md(t['owner'])}")

    out += ["", "## Люди"]
    for key, p in sorted(people.items(), key=lambda kv: kv[1]["name"]):
        out.append(f"- {person_line(p)}")
        if p.get("team") or p.get("company"):
            out.append(f"  - {_md(', '.join(x for x in (p.get('team'), p.get('company')) if x))}")
        if p.get("manager"):
            out.append(f"  - руководитель: {_md(p['manager'])}")
        own = tasks_by_owner.get(key, [])
        if own:
            out.append("  - Задачи")
            out += [f"    - {task_line(t)}" for t in own]
        if p.get("facts"):
            out.append("  - Факты")
            out += [f"    - {_md(f)}" for f in p["facts"][:12]]
        if p.get("meetings"):
            out.append("  - Встречи")
            out += [f"    - {_md(m)}" for m in p["meetings"][-8:]]

    out += ["", "## Открытые задачи"]
    for owner, items in sorted(tasks_by_owner.items()):
        items = [t for t in items if t.get("status") != "done"]
        if items:
            out.append(f"- **{_md(items[0]['owner'])}**")
            out += [f"  - {task_line(t)}" for t in items]
    return "\n".join(out)


def build_mindmap() -> Path:
    KB.mkdir(exist_ok=True)
    data = merged()
    md = mindmap_markdown(data)
    (KB / "mindmap.md").write_text(md, "utf-8")
    stats = f"{len(data['people'])} людей · {len(data['teams'])} команд · {len(data['projects'])} проектов · {len(data['tasks'])} задач · {len(data['meetings'])} встреч"
    page = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Карта команды</title>
<style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151517;--fg:#f2f2f7;--muted:#98989f;--line:#2c2c30}}}}
html,body{{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:14px system-ui,-apple-system,Segoe UI,sans-serif}}
header{{display:flex;gap:16px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line)}}
header b{{font-size:16px}} header span{{color:var(--muted)}}
#mm{{position:absolute;inset:48px 0 0 0}} #mm>svg{{width:100%;height:100%}}
#mm{{--markmap-text-color:var(--fg);--markmap-code-bg:var(--line)}}
</style>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-lib@0.18.12/dist/browser/index.iife.js"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-toolbar@0.18.12/dist/index.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/markmap-toolbar@0.18.12/dist/style.css">
</head><body>
<header><b>Люди, команды, задачи</b><span>{html.escape(stats)}</span></header>
<div id="mm"><svg></svg></div>
<script type="text/markdown" id="md">
{md.replace("</script", "<\\/script")}
</script>
<script>
const {{Transformer, Markmap, Toolbar}} = window.markmap;
const {{root}} = new Transformer().transform(document.getElementById("md").textContent);
const mm = Markmap.create("#mm svg", {{colorFreezeLevel: 2, initialExpandLevel: 3, maxWidth: 360, duration: 300}}, root);
const bar = Toolbar.create(mm); bar.el.style.cssText = "position:absolute;right:16px;bottom:16px";
document.getElementById("mm").append(bar.el);
// Если страница открылась в скрытой вкладке, размеры были нулевые - подгоняем при показе и ресайзе.
const refit = () => mm.fit();
new ResizeObserver(refit).observe(document.getElementById("mm"));
document.addEventListener("visibilitychange", refit);
[300, 1000].forEach(t => setTimeout(refit, t));
</script></body></html>"""
    out = KB / "mindmap.html"
    out.write_text(page, "utf-8")
    return out


# ---------- словарь ----------

def update_glossary_people() -> None:
    """Секция «Люди» в словаре пересобирается из базы: имена - главный источник ошибок ASR."""
    if not GLOSSARY.exists():
        return
    text = GLOSSARY.read_text("utf-8")
    head, sep, _ = text.partition("## Люди")
    lines = ["## Люди", "<!-- Генерируется из kb/ (people.yaml + встречи). Правки - в kb/people.yaml. -->"]
    for p in sorted(merged()["people"].values(), key=lambda x: x["name"]):
        meta = ", ".join(x for x in (p.get("role"), p.get("team"), p.get("company")) if x)
        aliases = f" - {', '.join(p['aliases'])}" if p.get("aliases") else ""
        lines.append(f"- {p['name']}" + (f" - {meta}" if meta else "") + aliases)
    GLOSSARY.write_text(head.rstrip() + "\n\n" + "\n".join(lines) + "\n", "utf-8")


def add_candidates(meeting_label: str, terms: list[dict]) -> int:
    known = norm(GLOSSARY.read_text("utf-8")) if GLOSSARY.exists() else ""
    existing = CANDIDATES.read_text("utf-8") if CANDIDATES.exists() else "# Кандидаты в словарь\n\nНовые термины из встреч. `python update_glossary.py` переносит отмеченные [x] в словарь.\n"
    fresh = [t for t in terms if t.get("term") and norm(t["term"]) not in known
             and f"] {t['term']} -" not in existing]
    if fresh:
        existing += f"\n## {meeting_label}\n" + "".join(f"- [ ] {t['term']} - {t.get('note', '')}\n" for t in fresh)
        KB.mkdir(exist_ok=True)
        CANDIDATES.write_text(existing, "utf-8")
    return len(fresh)


if __name__ == "__main__":
    update_glossary_people()
    print(build_mindmap())
