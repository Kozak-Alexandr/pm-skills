"""Проверка настроек LLM: короткий запрос к выбранному бэкенду. Ключ не печатается.

    python check_llm.py [api|claude|local]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from llm import ENV, chat, default_backend  # noqa: E402

backend = sys.argv[1] if len(sys.argv) > 1 else default_backend()
if backend == "api":
    print("адрес:", ENV.get("LLM_BASE_URL") or "не задан")
    print("модель:", ENV.get("LLM_MODEL") or ENV.get("LLM_DEFAULT_MODEL") or "не задана")
    print("ключ:", "задан" if ENV.get("LLM_API_KEY") else "не задан")
try:
    answer = chat(backend, "Отвечай одним словом.", "Столица Франции?", max_tokens=50, timeout=120)
    print(f"OK ({backend}): {answer.strip()[:60]}")
except Exception as error:  # noqa: BLE001
    print(f"ОШИБКА ({backend}): {error}")
    sys.exit(1)
