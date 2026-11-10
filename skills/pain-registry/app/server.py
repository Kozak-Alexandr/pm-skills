"""Реестр болей - локальный сервер прототипа.

Только стандартная библиотека Python 3.9+, никаких pip-зависимостей.
Раздаёт интерфейс из ./static, хранит рабочее пространство в ./data/workspace.json
и проксирует вызовы к любой OpenAI-совместимой LLM (внутренняя модель в контуре,
Ollama, vLLM, облачный API). Ключ остаётся на сервере и в браузер не попадает.

Запуск:  python server.py            (порт 8095)
         python server.py --port 9000
Настройка модели: config.json рядом с файлом или переменные окружения
LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_EMBED_MODEL, LLM_STT_MODEL.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
# Данные и настройки пользователя живут вне скилла, чтобы обновление кода их не затирало.
HOME = Path(os.environ.get("PAIN_REGISTRY_HOME") or Path.home() / "pain-registry")
DATA = HOME / "data"
WORKSPACE = DATA / "workspace.json"
CONFIG = HOME / "config.json"

DEFAULTS = {
    "base_url": "http://localhost:11434/v1",
    "api_key": "",
    "model": "qwen2.5:14b-instruct",
    "embed_model": "",
    "stt_model": "",
    "json_mode": True,
    "timeout_s": 300,
    "verify_tls": True,
    "price_in_rub_per_1m": 0,
    "price_out_rub_per_1m": 0,
    "allowed_roots": [],
    "env_file": "",
    "use_system_proxy": False,
    "ca_bundle": "",
    "max_tokens": 8000,
    "extra_body": {},
}

ENV_MAP = {"LLM_BASE_URL": "base_url", "LLM_API_KEY": "api_key", "LLM_DEFAULT_MODEL": "model",
           "LLM_MODEL": "model", "LLM_CA_BUNDLE": "ca_bundle"}


def read_env_file(path: str) -> dict:
    """Берём адрес, ключ и модель из .env другого проекта, чтобы не копировать ключ руками."""
    out = {}
    p = Path(path).expanduser()
    if not path or not p.is_file():
        return out
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key in ENV_MAP and value:
            out[ENV_MAP[key]] = value
    return out

TEXT_TYPES = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".vtt", ".srt",
              ".html", ".htm", ".eml", ".log", ".xml"}


def ensure_config() -> None:
    """Первый запуск: конфиг по образцу, адрес, ключ и модель LLM берутся из общего ~/.llm.env."""
    if CONFIG.exists():
        return
    HOME.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
    cfg["env_file"] = str(Path.home() / ".llm.env")
    cfg["allowed_roots"] = [str(Path.home())]
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def load_config() -> dict:
    ensure_config()
    cfg = dict(DEFAULTS)
    file_cfg = {}
    if CONFIG.exists():
        try:
            file_cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"config.json не прочитан: {exc}", file=sys.stderr)
    from_env_file = read_env_file(file_cfg.get("env_file") or os.environ.get("LLM_ENV_FILE", ""))
    cfg.update(from_env_file)
    cfg.update({k: v for k, v in file_cfg.items() if not (k in from_env_file and v in ("", None))})
    cfg["key_source"] = "env_file" if from_env_file.get("api_key") and not file_cfg.get("api_key") else ("config.json" if file_cfg.get("api_key") else "")
    env = {
        "base_url": "LLM_BASE_URL", "api_key": "LLM_API_KEY", "model": "LLM_MODEL",
        "embed_model": "LLM_EMBED_MODEL", "stt_model": "LLM_STT_MODEL",
    }
    for key, var in env.items():
        if os.environ.get(var):
            cfg[key] = os.environ[var]
    cfg["base_url"] = str(cfg["base_url"]).rstrip("/")
    return cfg


def save_config(patch: dict) -> dict:
    current = {}
    if CONFIG.exists():
        try:
            current = json.loads(CONFIG.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            current = {}
    for key in ("base_url", "model", "embed_model", "stt_model", "json_mode", "env_file",
                "price_in_rub_per_1m", "price_out_rub_per_1m", "verify_tls", "timeout_s"):
        if key in patch:
            current[key] = patch[key]
    if patch.get("api_key"):
        current["api_key"] = patch["api_key"]
    CONFIG.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return load_config()


def public_config(cfg: dict) -> dict:
    out = {k: v for k, v in cfg.items() if k not in ("api_key", "extra_body")}
    out["has_key"] = bool(cfg.get("api_key"))
    return out


def upstream(cfg: dict, path: str, payload: dict | bytes, content_type="application/json") -> dict:
    url = cfg["base_url"] + path
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", content_type)
    if cfg.get("api_key"):
        req.add_header("Authorization", f"Bearer {cfg['api_key']}")
    handlers = []
    if not cfg.get("use_system_proxy"):
        handlers.append(urllib.request.ProxyHandler({}))  # корпоративный прокси до внутренних хостов не доходит
    if url.startswith("https"):
        if not cfg.get("verify_tls", True):
            ctx = ssl._create_unverified_context()  # для стендов с самоподписанным сертификатом
        else:
            ctx = ssl.create_default_context()  # на Windows подтягивает системное хранилище сертификатов
            if cfg.get("ca_bundle") and Path(cfg["ca_bundle"]).is_file():
                ctx.load_verify_locations(cfg["ca_bundle"])
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    with opener.open(req, timeout=float(cfg.get("timeout_s", 300))) as resp:
        return json.loads(resp.read().decode("utf-8"))


def chat(cfg: dict, body: dict) -> dict:
    payload = {
        "model": body.get("model") or cfg["model"],
        "messages": body["messages"],
        "temperature": body.get("temperature", 0),
    }
    payload["max_tokens"] = body.get("max_tokens") or cfg.get("max_tokens") or 8000
    if isinstance(cfg.get("extra_body"), dict):
        payload.update(cfg["extra_body"])
    if body.get("json") and cfg.get("json_mode", True):
        payload["response_format"] = {"type": "json_object"}
    started = time.time()
    try:
        data = upstream(cfg, "/chat/completions", payload)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:800]
        # Некоторые серверы не знают response_format - повторяем без него один раз.
        if "response_format" in payload and exc.code in (400, 422):
            payload.pop("response_format")
            data = upstream(cfg, "/chat/completions", payload)
        else:
            raise RuntimeError(f"LLM ответила {exc.code}: {detail}") from exc
    text = data["choices"][0]["message"].get("content") or ""
    usage = data.get("usage") or {}
    return {
        "text": text,
        "usage": {"in": usage.get("prompt_tokens", 0), "out": usage.get("completion_tokens", 0)},
        "ms": int((time.time() - started) * 1000),
        "model": data.get("model", payload["model"]),
    }


def embed(cfg: dict, body: dict) -> dict:
    if not cfg.get("embed_model"):
        raise RuntimeError("Модель эмбеддингов не задана - используется TF-IDF в браузере")
    data = upstream(cfg, "/embeddings", {"model": cfg["embed_model"], "input": body["input"]})
    return {"vectors": [row["embedding"] for row in data["data"]]}


def transcribe(cfg: dict, filename: str, raw: bytes) -> dict:
    if not cfg.get("stt_model"):
        raise RuntimeError("Модель распознавания речи не задана (stt_model в config.json)")
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("model", cfg["stt_model"]), ("response_format", "verbose_json"), ("language", "ru")):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        f"Content-Type: {mime}\r\n\r\n".encode() + raw + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    data = upstream(cfg, "/audio/transcriptions", b"".join(parts), f"multipart/form-data; boundary={boundary}")
    segments = [{"ts": round(s.get("start", 0)), "text": s.get("text", "").strip()} for s in data.get("segments", [])]
    return {"text": data.get("text", ""), "segments": segments}


def safe_path(cfg: dict, raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    roots = [Path(r).expanduser().resolve() for r in cfg.get("allowed_roots") or []]
    if roots and not any(path == r or r in path.parents for r in roots):
        raise PermissionError("Папка вне allowed_roots из config.json")
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "PainRegistry/0.3"

    def log_message(self, fmt, *args):  # компактный лог
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, code: int, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            if url.path == "/api/status":
                cfg = load_config()
                return self._json(200, {"ok": True, "mode": "local", "config": public_config(cfg)})
            if url.path == "/api/workspace":
                if WORKSPACE.exists():
                    return self._send(200, WORKSPACE.read_bytes())
                return self._json(200, None)
            if url.path == "/api/folder":
                cfg = load_config()
                folder = safe_path(cfg, q.get("path", [""])[0])
                if not folder.is_dir():
                    return self._json(404, {"error": f"Папка не найдена: {folder}"})
                recursive = q.get("recursive", ["0"])[0] == "1"
                pattern = "**/*" if recursive else "*"
                files = [
                    {"path": str(p), "name": p.name, "size": p.stat().st_size, "mtime": int(p.stat().st_mtime * 1000)}
                    for p in sorted(folder.glob(pattern)) if p.is_file() and not p.name.startswith(".")
                ]
                return self._json(200, {"folder": str(folder), "files": files[:2000]})
            if url.path == "/api/file":
                cfg = load_config()
                path = safe_path(cfg, q.get("path", [""])[0])
                if not path.is_file():
                    return self._json(404, {"error": "Файл не найден"})
                return self._send(200, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            return self._static(url.path)
        except PermissionError as exc:
            return self._json(403, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": str(exc)})

    def do_PUT(self):
        if urlparse(self.path).path != "/api/workspace":
            return self._json(404, {"error": "not found"})
        raw = self._body()
        json.loads(raw.decode("utf-8"))  # проверяем, что это JSON
        DATA.mkdir(exist_ok=True)
        tmp = WORKSPACE.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(WORKSPACE)
        return self._json(200, {"ok": True, "bytes": len(raw)})

    def do_POST(self):
        url = urlparse(self.path)
        cfg = load_config()
        try:
            if url.path == "/api/llm/chat":
                return self._json(200, chat(cfg, json.loads(self._body())))
            if url.path == "/api/llm/embed":
                return self._json(200, embed(cfg, json.loads(self._body())))
            if url.path == "/api/llm/test":
                res = chat(cfg, {"messages": [{"role": "user", "content": "Ответь одним словом: готов"}], "max_tokens": 10})
                return self._json(200, {"ok": True, **res})
            if url.path == "/api/config":
                return self._json(200, {"config": public_config(save_config(json.loads(self._body())))})
            if url.path == "/api/transcribe":
                name = parse_qs(url.query).get("name", ["audio.wav"])[0]
                return self._json(200, transcribe(cfg, name, self._body()))
            return self._json(404, {"error": "not found"})
        except urllib.error.URLError as exc:
            return self._json(502, {"error": f"LLM недоступна по адресу {cfg['base_url']}: {exc.reason}"})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": str(exc)})

    def _static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if STATIC not in target.parents or not target.is_file():
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or target.suffix in (".js", ".mjs", ".json"):
            ctype += "; charset=utf-8"
        if target.suffix == ".mjs":
            ctype = "text/javascript; charset=utf-8"
        return self._send(200, target.read_bytes(), ctype)


def main():
    parser = argparse.ArgumentParser(description="Реестр болей - локальный прототип")
    parser.add_argument("--port", type=int, default=8095)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    cfg = load_config()
    print(f"Реестр болей: http://{args.host}:{args.port}")
    print(f"LLM: {cfg['base_url']} · модель {cfg['model']} · ключ {'задан' if cfg.get('api_key') else 'не задан'}")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
