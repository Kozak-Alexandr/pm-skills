"""Выходные файлы встречи: transcript.md, summary.md, интерактивный report.html и report.pdf."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from process import parse_ts, ts


def nodash(text: str) -> str:
    """Длинное и среднее тире пользователь не использует; LLM их ставит, в файлы они не попадают."""
    em, en = chr(0x2014), chr(0x2013)
    return text.replace(f" {em} ", " - ").replace(em, "-").replace(en, "-")


def speaker_names(summary: dict) -> dict[str, str]:
    names = {}
    for spk, info in (summary.get("speakers") or {}).items():
        name = (info or {}).get("name")
        names[spk] = name if name and name != "null" else f"Спикер {int(spk.split('_')[-1]) + 1}" if spk.split("_")[-1].isdigit() else spk
    return names


def resolve_owners(summary: dict) -> None:
    """SPEAKER_XX в исполнителях → имя спикера (или «Спикер N»), чтобы задачи читались и в базе знаний."""
    names = speaker_names(summary)
    for a in summary.get("action_items") or []:
        a["owner"] = names.get(a.get("owner"), a.get("owner"))
    for t in (summary.get("kb") or {}).get("tasks") or []:
        t["owner"] = names.get(t.get("owner"), t.get("owner"))


def paragraphs(chunks: list[dict]) -> list[dict]:
    """Соседние чанки одного спикера - один абзац."""
    out: list[dict] = []
    for c in chunks:
        if not c["text"]:
            continue
        if out and out[-1]["speaker"] == c["speaker"] and c["start"] - out[-1]["end"] < 3:
            p = out[-1]
            p["end"] = c["end"]; p["text"] += " " + c["text"]
            p["giga"] += " " + c["giga"]; p["whisper"] += " " + c["whisper"]
        else:
            out.append({k: c[k] for k in ("start", "end", "speaker", "text", "giga", "whisper")})
    return out


def write_markdown(folder: Path, meta: dict, summary: dict, chunks: list[dict]) -> None:
    names = speaker_names(summary)
    t = [f"# {summary.get('title') or meta['source']}: стенограмма", "",
         f"{meta['date']} · {ts(meta['duration'])} · {meta['source']}", ""]
    for p in paragraphs(chunks):
        t.append(f"**[{ts(p['start'])}] {names.get(p['speaker'], p['speaker'])}:** {p['text']}\n")
    (folder / "transcript.md").write_text(nodash("\n".join(t)), "utf-8")

    s = [f"# {summary.get('title') or meta['source']}", "",
         f"{meta['date']} · {ts(meta['duration'])} · {summary.get('meeting_type', '')}", "",
         "**Участники:** " + ", ".join(
             f"{names[k]}" + (f" ({v.get('role')})" if (v or {}).get("role") else "")
             for k, v in (summary.get("speakers") or {}).items()), "",
         "## Коротко", "", summary.get("tldr", ""), ""]
    cd = summary.get("custdev") or {}
    if cd.get("profile"):
        s += [f"## Профиль заказчика{': ' + cd['company'] if cd.get('company') else ''}", ""]
        s += [f"- **{p.get('k', '')}:** {p.get('v', '')}" for p in cd["profile"]] + [""]
    for section in cd.get("sections") or []:
        if section.get("bullets"):
            s += [f"## {section.get('title', '')}", ""]
            s += [f"- {b['text']} `{b.get('t', '')}`" for b in section["bullets"]] + [""]
    if cd.get("signals"):
        s += ["## Сигналы для продукта", ""] + [f"- {b['text']} `{b.get('t', '')}`" for b in cd["signals"]] + [""]
    if cd:
        s += ["# Ход встречи", ""]
    for topic in summary.get("topics") or []:
        s.append(f"## {topic['title']} `{topic.get('start', '')}`")
        s += [f"- {b['text']} `{b.get('t', '')}`" for b in topic.get("bullets") or []]
        s.append("")
    for key, title in (("decisions", "Решения"), ("open_questions", "Открытые вопросы")):
        if summary.get(key):
            s += [f"## {title}", ""] + [f"- {d['text']} `{d.get('t', '')}`" for d in summary[key]] + [""]
    if summary.get("action_items"):
        s += ["## Задачи", "", "| Кто | Что | Срок |", "|---|---|---|"]
        s += [f"| {a.get('owner', '')} | {a.get('task', '')} | {a.get('due') or ''} |" for a in summary["action_items"]]
    (folder / "summary.md").write_text(nodash("\n".join(s) + "\n"), "utf-8")


def write_html(folder: Path, meta: dict, summary: dict, chunks: list[dict], audio_name: str) -> Path:
    names = speaker_names(summary)
    data = {
        "meta": meta, "audio": audio_name, "names": names,
        "summary": summary,
        "paragraphs": paragraphs(chunks),
        "turns": [{"s": c["start"], "e": c["end"], "k": c["speaker"]} for c in chunks if c["text"]],
    }
    for key in ("topics",):
        for topic in summary.get(key) or []:
            topic["_s"] = parse_ts(topic.get("start")); topic["_e"] = parse_ts(topic.get("end"))
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    page = TEMPLATE.replace("__DATA__", payload).replace("__TITLE__", (summary.get("title") or "Встреча")[:80]
                                                       .replace("<", "&lt;"))
    out = folder / "report.html"
    out.write_text(nodash(page), "utf-8")
    return out


def write_pdf(html: Path) -> Path | None:
    """report.html -> report.pdf в том же виде: таймлайны, карточки, цвета. Печатает Chrome без окна."""
    candidates = (shutil.which("chrome"), r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                  r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    chrome = next((c for c in candidates if c and Path(c).exists()), None)
    if not chrome:
        return None
    pdf = html.with_suffix(".pdf")
    profile = html.parent / ".chrome-print"
    subprocess.run([chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=3000",
                    f"--user-data-dir={profile}", f"--print-to-pdf={pdf}", html.as_uri()],
                   check=True, capture_output=True, timeout=180)
    shutil.rmtree(profile, ignore_errors=True)
    return pdf


TEMPLATE = r"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#f6f6f8;--card:#fff;--fg:#1c1c1e;--muted:#6c6c72;--line:#e3e3e8;--accent:#3a5bd9;--hl:#fff4c2;
--c0:#3a5bd9;--c1:#d9573a;--c2:#2a9d6f;--c3:#a347c2;--c4:#c99a1a;--c5:#1f9bb5;--c6:#c2477a;--c7:#6b7a8f}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1b1b1e;--fg:#ececf0;--muted:#9a9aa2;--line:#2c2c31;--accent:#7d98ff;--hl:#4a4020;
--c0:#7d98ff;--c1:#ff8a6b;--c2:#4fd1a0;--c3:#cf8ae6;--c4:#e8c25a;--c5:#5ccbe0;--c6:#ef86b1;--c7:#a3afc0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px 120px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px;font-weight:600}
.meta{color:var(--muted);font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-size:13px}
.dot{width:9px;height:9px;border-radius:50%}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.tldr{font-size:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:760px){.grid{grid-template-columns:1fr}}
ul{margin:0;padding-left:18px} li{margin:4px 0}
.t{font:12px ui-monospace,Consolas,monospace;color:var(--accent);cursor:pointer;white-space:nowrap;margin-left:4px}
.t:hover{text-decoration:underline}
.timeline{position:relative}
.row{display:grid;grid-template-columns:140px 1fr 56px;align-items:center;gap:10px;margin:6px 0;font-size:13px}
.row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{position:relative;height:16px;background:var(--bg);border-radius:4px;cursor:pointer;overflow:hidden}
.seg{position:absolute;top:0;bottom:0;opacity:.9}
.pct{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.topics{position:relative;height:30px;margin:4px 0 0 150px;margin-right:66px}
.tb{position:absolute;top:0;height:26px;border-radius:5px;font-size:11px;padding:4px 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;color:#fff}
.cursor{position:absolute;top:0;bottom:0;width:2px;background:var(--fg);pointer-events:none;opacity:.6}
.topic{margin:0 0 14px}
.topic h3{font-size:16px;margin:0 0 6px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}
blockquote{margin:0 0 10px;padding:4px 0 4px 12px;border-left:3px solid var(--accent)}
.kv th{width:180px;font-size:13px;color:var(--muted);font-weight:500}
.grid.cd{align-items:start}
.grid.cd h3{font-size:15px;margin:0 0 8px}
.signals{border-left:4px solid var(--accent)}
.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
input[type=search]{flex:1;min-width:200px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit}
label{font-size:13px;color:var(--muted)}
.p{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:8px 6px;border-radius:8px}
.p.now{background:var(--hl)}
.p .who{font-weight:600;font-size:13px}
.p .who .t{display:block;margin:2px 0 0}
.raw{display:none;font-size:12px;color:var(--muted);margin-top:4px}
.showraw .raw{display:block}
mark{background:var(--hl);color:inherit}
.player{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 16px}
.player audio{width:100%;max-width:1080px;display:block;margin:0 auto}
@media (max-width:600px){.p{grid-template-columns:1fr}.row{grid-template-columns:90px 1fr 44px}.topics{margin-left:100px;margin-right:54px}}
@page{size:A4;margin:10mm 0}
@media print{
/* PDF один в один с экраном: те же цвета и фон; убран только плеер, закреплённый внизу,
   иначе он печатался бы на каждой странице. Тёмная тема в PDF не нужна. */
:root{--bg:#f6f6f8;--card:#fff;--fg:#1c1c1e;--muted:#6c6c72;--line:#e3e3e8;--accent:#3a5bd9;--hl:#fff4c2;
--c0:#3a5bd9;--c1:#d9573a;--c2:#2a9d6f;--c3:#a347c2;--c4:#c99a1a;--c5:#1f9bb5;--c6:#c2477a;--c7:#6b7a8f}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{background:var(--bg)}
.player{display:none}
.wrap{padding:0 28px 24px}
.p{break-inside:avoid}
}
</style></head><body>
<div class="wrap" id="app"></div>
<div class="player"><audio id="audio" controls preload="metadata"></audio></div>
<script>
const D=__DATA__;
const S=D.summary, $=s=>document.querySelector(s), el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt=x=>{x=Math.floor(x);const h=Math.floor(x/3600),m=Math.floor(x%3600/60),s=x%60;return (h?h+":"+String(m).padStart(2,"0"):String(m).padStart(2,"0"))+":"+String(s).padStart(2,"0")};
const sec=v=>{if(v==null||v==="")return null;if(typeof v==="number")return v;return String(v).split(":").reduce((a,p)=>a*60+(+p||0),0)};
const T=v=>{const s=sec(v);return s==null?"":`<span class="t" data-t="${s}">${fmt(s)}</span>`};
const audio=$("#audio"); if(D.audio)audio.src=D.audio; else $(".player").remove();
const speakers=[...new Set(D.turns.map(t=>t.k))];
const color=k=>`var(--c${speakers.indexOf(k)%8})`;
const name=k=>D.names[k]||k;
const dur=D.meta.duration;
const app=$("#app");

app.append(el("h1",null,esc(S.title||D.meta.source)));
app.append(el("div","meta",`${esc(D.meta.date)} · ${fmt(dur)} · ${esc(S.meeting_type||"")} · ${esc(D.meta.source)}`));
const chips=el("div","chips");
speakers.forEach(k=>{const info=(S.speakers||{})[k]||{};chips.append(el("span","chip",`<span class="dot" style="background:${color(k)}"></span>${esc(name(k))}${info.role?` <span class="meta">· ${esc(info.role)}</span>`:""}`))});
app.append(chips);

app.append(el("h2",null,"Коротко"));
app.append(el("div","card tldr",esc(S.tldr)));

// Кастдев: профиль заказчика, разбор по разделам, сигналы для продукта
const CD=S.custdev;
if(CD){
  if((CD.profile||[]).length){app.append(el("h2",null,"Профиль заказчика"+(CD.company?" · "+esc(CD.company):"")));
    const c=el("div","card");c.innerHTML="<table class=\"kv\">"+CD.profile.map(p=>`<tr><th>${esc(p.k)}</th><td>${esc(p.v)}</td></tr>`).join("")+"</table>";app.append(c)}
  const secs=(CD.sections||[]).filter(s=>(s.bullets||[]).length);
  if(secs.length){app.append(el("h2",null,"Разбор кастдева"));const g=el("div","grid cd");
    secs.forEach(s=>{const c=el("div","card");c.append(el("h3",null,esc(s.title)));const ul=el("ul");
      s.bullets.forEach(b=>ul.append(el("li",null,esc(b.text)+T(b.t))));c.append(ul);g.append(c)});app.append(g)}
  if((CD.signals||[]).length){app.append(el("h2",null,"Сигналы для продукта"));const c=el("div","card signals");const ul=el("ul");
    CD.signals.forEach(b=>ul.append(el("li",null,esc(b.text)+T(b.t))));c.append(ul);app.append(c)}
}

// Кто когда говорил + темы на одной шкале времени
app.append(el("h2",null,"Ход встречи"));
const tl=el("div","card timeline");
const talk={};D.turns.forEach(t=>talk[t.k]=(talk[t.k]||0)+(t.e-t.s));
const total=Object.values(talk).reduce((a,b)=>a+b,0)||1;
speakers.forEach(k=>{
  const row=el("div","row");row.append(el("div","name",`<span class="dot" style="display:inline-block;background:${color(k)}"></span> ${esc(name(k))}`));
  const tr=el("div","track");
  D.turns.filter(t=>t.k===k).forEach(t=>{const s=el("div","seg");s.style.left=(t.s/dur*100)+"%";s.style.width=Math.max(.15,(t.e-t.s)/dur*100)+"%";s.style.background=color(k);tr.append(s)});
  tr.onclick=e=>{const r=tr.getBoundingClientRect();seek((e.clientX-r.left)/r.width*dur)};
  row.append(tr);row.append(el("div","pct",Math.round(talk[k]/total*100)+"%"));tl.append(row);
});
const tw=el("div","topics");
(S.topics||[]).forEach((tp,i)=>{const s=sec(tp.start)??0,e=sec(tp.end)??s+60;const b=el("div","tb",esc(tp.title));b.title=tp.title;
  b.style.left=(s/dur*100)+"%";b.style.width=Math.max(1,(e-s)/dur*100)+"%";b.style.background=`var(--c${(i+3)%8})`;b.onclick=()=>seek(s);tw.append(b)});
tl.append(tw);
const cur=el("div","cursor");tl.style.position="relative";tl.append(cur);
app.append(tl);

app.append(el("h2",null,"Темы и ключевые мысли"));
const tc=el("div","card");
(S.topics||[]).forEach(tp=>{const d=el("div","topic");d.append(el("h3",null,esc(tp.title)+T(tp.start)));
  const ul=el("ul");(tp.bullets||[]).forEach(b=>ul.append(el("li",null,esc(b.text)+T(b.t))));d.append(ul);tc.append(d)});
app.append(tc);

const g=el("div","grid");
const list=(title,items)=>{const c=el("div");c.append(el("h2",null,title));const card=el("div","card");
  if(!items||!items.length){card.append(el("div","meta","нет"))}else{const ul=el("ul");items.forEach(x=>ul.append(el("li",null,esc(x.text)+T(x.t))));card.append(ul)}c.append(card);return c};
g.append(list("Решения",S.decisions));g.append(list("Открытые вопросы",S.open_questions));app.append(g);

if((S.action_items||[]).length){app.append(el("h2",null,"Задачи"));const c=el("div","card");
  c.innerHTML="<table><tr><th>Кто</th><th>Что</th><th>Срок</th><th></th></tr>"+S.action_items.map(a=>`<tr><td>${esc(a.owner)}</td><td>${esc(a.task)}</td><td>${esc(a.due||"")}</td><td>${T(a.t)}</td></tr>`).join("")+"</table>";app.append(c)}

if((S.quotes||[]).length){app.append(el("h2",null,"Цитаты"));const c=el("div","card");
  S.quotes.forEach(q=>c.append(el("blockquote",null,`«${esc(q.text)}» <span class="meta">${esc(name(q.speaker))}</span>${T(q.t)}`)));app.append(c)}

app.append(el("h2",null,"Стенограмма"));
const tools=el("div","tools");const q=el("input");q.type="search";q.placeholder="Поиск по стенограмме";
const raw=el("label",null,'<input type="checkbox"> гипотезы ASR');tools.append(q);tools.append(raw);app.append(tools);
const tr=el("div","card tr");app.append(tr);
const rows=D.paragraphs.map(p=>{const r=el("div","p");r.dataset.s=p.start;r.dataset.e=p.end;
  r.innerHTML=`<div class="who" style="color:${color(p.speaker)}">${esc(name(p.speaker))}${T(p.start)}</div><div><div class="txt">${esc(p.text)}</div><div class="raw"><b>GigaAM:</b> ${esc(p.giga)}<br><b>Whisper:</b> ${esc(p.whisper)}</div></div>`;tr.append(r);return {r,p}});
q.oninput=()=>{const v=q.value.trim().toLowerCase();rows.forEach(({r,p})=>{const hit=!v||p.text.toLowerCase().includes(v);r.style.display=hit?"":"none";
  r.querySelector(".txt").innerHTML=v&&hit?esc(p.text).replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"gi"),m=>`<mark>${m}</mark>`):esc(p.text)})};
raw.querySelector("input").onchange=e=>tr.classList.toggle("showraw",e.target.checked);

function seek(t){audio.currentTime=Math.max(0,t-0.5);audio.play()}
document.addEventListener("click",e=>{const t=e.target.closest(".t");if(t)seek(+t.dataset.t)});
let last=null;
const ref=tl.querySelector(".track");
audio.ontimeupdate=()=>{const t=audio.currentTime;if(ref)cur.style.left=(ref.offsetLeft+ref.offsetWidth*t/dur)+"px";
  const hit=rows.find(({p})=>t>=p.start&&t<=p.end+1.5);if(hit&&hit.r!==last){last?.classList.remove("now");hit.r.classList.add("now");last=hit.r}};
</script></body></html>"""
