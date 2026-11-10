"""Обновление словаря расшифровки.

    python update_glossary.py            # перенести отмеченные [x] кандидаты в словарь + пересобрать «Люди»
    python update_glossary.py --scan ПАПКА   # ещё и поискать новые термины в материалах продукта

Кандидаты копятся в kb/glossary-candidates.md после каждой встречи; отметь нужные [x],
ненужные удали, остальное оставь - скрипт перенесёт только отмеченные.
"""
from __future__ import annotations

import argparse
import re
from collections import Counter
from pathlib import Path

import kb

SECTION = "## Термины из встреч"
SKIP_DIRS = {"node_modules", ".git", "out", "__pycache__", ".venv", "dist", "build"}
STOP = {"The", "This", "If", "When", "All", "Any", "Use", "See", "Do", "Get", "None", "True", "False",
        "High", "Medium", "Low", "Optional", "Item", "Field", "Query", "Description", "Parameters"}


def apply_checked() -> int:
    if not kb.CANDIDATES.exists():
        return 0
    lines = kb.CANDIDATES.read_text("utf-8").splitlines()
    picked = [l[6:].strip() for l in lines if l.lower().startswith("- [x] ")]
    if not picked:
        return 0
    text = kb.GLOSSARY.read_text("utf-8")
    head, sep, people = text.partition("## Люди")
    if SECTION not in head:
        head = head.rstrip() + f"\n\n{SECTION}\n"
    head = head.rstrip() + "\n" + "".join(f"- {p}\n" for p in picked) + "\n"
    kb.GLOSSARY.write_text(head + sep + people, "utf-8")
    kb.CANDIDATES.write_text("\n".join(l for l in lines if not l.lower().startswith("- [x] ")) + "\n", "utf-8")
    return len(picked)


def scan_materials(root: Path, min_count: int = 5) -> list[tuple[str, int]]:
    known = kb.norm(kb.GLOSSARY.read_text("utf-8"))
    counter: Counter[str] = Counter()
    for path in root.rglob("*.md"):
        if SKIP_DIRS & set(path.parts) or path.stat().st_size > 400_000:
            continue
        text = path.read_text("utf-8", errors="ignore")
        counter.update(re.findall(r"\b(?:[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9-]*|[A-Z][a-z]+(?: [A-Z][A-Za-z0-9]+)+)\b", text))
    return [(t, n) for t, n in counter.most_common(400)
            if n >= min_count and t not in STOP and kb.norm(t) not in known and not re.match(r"^(TA|T|INC|E)\d", t)][:60]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scan", type=Path, metavar="ПАПКА", help="папка с материалами продукта (*.md)")
    args = ap.parse_args()
    print(f"перенесено из кандидатов: {apply_checked()}")
    kb.update_glossary_people()
    if args.scan:
        found = scan_materials(args.scan)
        n = kb.add_candidates(f"Из материалов {args.scan.name}", [{"term": t, "note": f"встречается {c} раз"} for t, c in found])
        print(f"новых кандидатов из материалов: {n} → {kb.CANDIDATES}")


if __name__ == "__main__":
    main()
