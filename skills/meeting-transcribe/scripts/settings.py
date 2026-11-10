"""Где лежат данные пользователя. Код живёт в скилле и обновляется вместе с ним,
а записи, отчёты, словарь и ключи хранятся отдельно, в домашней папке.

TRANSCRIBE_HOME   папка данных, по умолчанию ~/meeting-transcribe
~/.llm.env        общие настройки LLM для скиллов (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)
"""
import os
import shutil
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
HOME = Path(os.environ.get("TRANSCRIBE_HOME") or Path.home() / "meeting-transcribe")
ENV_FILES = (HOME / ".env", Path.home() / ".llm.env")
GLOSSARY = HOME / "glossary.md"
KB = HOME / "kb"
OUT = HOME / "out"


def ensure_home() -> None:
    """Первый запуск: создаём папку данных и кладём туда шаблоны, которые пользователь правит под себя."""
    KB.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    if not GLOSSARY.exists():
        shutil.copy(SKILL / "assets" / "glossary-template.md", GLOSSARY)
    people = KB / "people.yaml"
    if not people.exists():
        shutil.copy(SKILL / "assets" / "people-template.yaml", people)
    env = HOME / ".env"
    if not env.exists():
        env.write_text("HF_TOKEN=\n", "utf-8")


ensure_home()
