"""Три бэкенда LLM с одним интерфейсом: chat(system, user) -> str.

api    - любой OpenAI-совместимый API: адрес, ключ и модель в ~/.llm.env (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL);
         подходят OpenAI, OpenRouter, корпоративный шлюз, vLLM;
claude - Claude Code в headless-режиме (`claude -p`), по подписке пользователя;
local  - локальный OpenAI-совместимый сервер без ключа (Ollama, LM Studio, llama.cpp).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import ssl
import subprocess
import urllib.request
from pathlib import Path

from settings import ENV_FILES


def _env() -> dict[str, str]:
    env: dict[str, str] = {}
    for path in ENV_FILES:
        if path.exists():
            for line in path.read_text("utf-8").splitlines():
                if line.strip() and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env.setdefault(key.strip(), value.strip())
    env.update({k: v for k, v in os.environ.items() if k.startswith(("LLM_", "LOCAL_LLM_", "CLAUDE_MODEL"))})
    return env


ENV = _env()


def _ssl_context() -> ssl.SSLContext:
    # Корпоративный шлюз может быть подписан внутренним УЦ: берём системное хранилище плюс цепочку из файла.
    context = ssl.create_default_context()
    context.load_default_certs(ssl.Purpose.SERVER_AUTH)
    chain = ENV.get("LLM_CA_BUNDLE")  # корневой сертификат, если его нет в системном хранилище
    if chain and Path(chain).exists():
        context.load_verify_locations(cafile=chain)
    return context


def _openai_chat(base_url: str, key: str, model: str, system: str, user: str,
                 max_tokens: int, extra: dict, timeout: int, direct: bool) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        **extra,
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    handlers: list = [urllib.request.HTTPSHandler(context=_ssl_context())]
    if direct:
        # Корпоративный прокси часто не пускает к внутренним хостам и к localhost: ходим напрямую.
        handlers.append(urllib.request.ProxyHandler({}))
    opener = urllib.request.build_opener(*handlers)
    with opener.open(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    message = data["choices"][0]["message"]
    return message.get("content") or ""


def _claude_chat(system: str, user: str, timeout: int) -> str:
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError("claude CLI не найден в PATH")
    # Переменные родительской сессии Claude Code (если скрипт запущен из неё) ломают
    # авторизацию дочернего CLI - он должен жить на собственном логине (`claude` → /login).
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "AI_AGENT", "BAGGAGE"))}
    model = ENV.get("CLAUDE_MODEL", "opus")
    result = subprocess.run(
        [exe, "-p", "--model", model, "--output-format", "text",
         "--append-system-prompt", system, "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch"],
        input=user, capture_output=True, text=True, encoding="utf-8", env=env, timeout=timeout,
    )
    if "Failed to authenticate" in result.stdout + result.stderr:
        raise RuntimeError("claude CLI не залогинен: запусти `claude` в терминале и выполни /login")
    if result.returncode != 0:
        raise RuntimeError(f"claude -p упал: {(result.stderr or result.stdout)[-2000:]}")
    return result.stdout


def default_backend() -> str:
    """API, если он настроен в ~/.llm.env, иначе Claude Code CLI, который есть у любого пользователя скилла."""
    return "api" if ENV.get("LLM_API_KEY") and ENV.get("LLM_BASE_URL") else "claude"


def chat(backend: str, system: str, user: str, *, max_tokens: int = 8000,
         thinking: bool = False, timeout: int = 900) -> str:
    if backend == "api":
        key, base = ENV.get("LLM_API_KEY"), ENV.get("LLM_BASE_URL")
        model = ENV.get("LLM_MODEL") or ENV.get("LLM_DEFAULT_MODEL")
        if not (key and base and model):
            raise RuntimeError("Заполни LLM_BASE_URL, LLM_API_KEY и LLM_MODEL в ~/.llm.env")
        extra, budget = {}, max_tokens
        if "qwen" in model.lower():
            # Qwen по умолчанию «размышляет»: без явного флага ответ может уйти целиком в размышление
            extra = {"chat_template_kwargs": {"enable_thinking": thinking}}
            budget += 8000 if thinking else 0
        # localhost (Ollama) и внутренние шлюзы часто не открываются через корпоративный прокси
        direct = ENV.get("LLM_NO_PROXY", "") == "1" or any(h in base for h in ("localhost", "127.0.0.1"))
        return _openai_chat(base, key, model, system, user, budget, extra, timeout, direct)
    if backend == "local":
        return _openai_chat(ENV.get("LOCAL_LLM_URL", "http://localhost:11434/v1"),
                            ENV.get("LOCAL_LLM_KEY", "ollama"), ENV.get("LOCAL_LLM_MODEL", "gemma3:12b"),
                            system, user, max_tokens, {}, timeout, True)
    if backend == "claude":
        return _claude_chat(system, user, timeout)
    raise ValueError(f"Неизвестный бэкенд {backend}")


def parse_json(text: str):
    """Достаёт JSON из ответа модели: снимает ```json-обёртку и <think>-блоки."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    if fence:
        text = fence.group(1)
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=0)
    end = max(text.rfind("}"), text.rfind("]"))
    return json.loads(text[start:end + 1])


def chat_json(backend: str, system: str, user: str, retries: int = 2, **kwargs):
    last = None
    for attempt in range(retries + 1):
        if attempt == retries and kwargs.get("thinking"):
            # Qwen иногда тратит весь бюджет на размышление и возвращает пустой ответ -
            # последняя попытка без размышления.
            kwargs["thinking"] = False
        answer = chat(backend, system, user, **kwargs)
        try:
            return parse_json(answer)
        except (json.JSONDecodeError, ValueError) as error:
            last = error
            user = user + "\n\nПредыдущий ответ не разобрался как JSON. Верни только валидный JSON."
    raise RuntimeError(f"Модель не вернула JSON: {last}")
