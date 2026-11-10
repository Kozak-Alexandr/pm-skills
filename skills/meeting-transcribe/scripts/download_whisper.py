"""Скачивает Whisper large-v3 (CTranslate2) в ~/models/faster-whisper-large-v3.

Через корпоративный прокси одна закачка идёт 0,3-1 МБ/с, поэтому model.bin (3 ГБ)
качается кусками в несколько потоков: так выходит около 5 МБ/с. Докачка поддерживается:
если прервать и запустить снова, готовые куски не скачиваются заново.
"""
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://huggingface.co/Systran/faster-whisper-large-v3/resolve/main/"
SMALL = ["config.json", "preprocessor_config.json", "tokenizer.json", "vocabulary.json"]
DEST = Path.home() / "models" / "faster-whisper-large-v3"
PARTS = 12


def size_of(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("X-Linked-Size") or r.headers["Content-Length"])


def fetch_part(url: str, path: Path, start: int, end: int) -> None:
    for _ in range(20):
        have = path.stat().st_size if path.exists() else 0
        if have >= end - start + 1:
            return
        req = urllib.request.Request(url, headers={"Range": f"bytes={start + have}-{end}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r, open(path, "ab") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
        except OSError as error:
            print(f"  повтор куска {path.name}: {error}", flush=True)
    raise RuntimeError(f"не удалось скачать {path.name}")


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    for name in SMALL:
        if not (DEST / name).exists():
            urllib.request.urlretrieve(BASE + name, DEST / name)
    target = DEST / "model.bin"
    url = BASE + "model.bin"
    total = size_of(url)
    if target.exists() and target.stat().st_size == total:
        print("Whisper уже скачан:", DEST)
        return
    step = (total + PARTS - 1) // PARTS
    ranges = [(i * step, min(total, (i + 1) * step) - 1) for i in range(PARTS)]
    parts = [DEST / f"model.bin.p{i}" for i in range(PARTS)]
    print(f"Качаю model.bin, {total / 2**30:.1f} ГБ, в {PARTS} потоков...", flush=True)
    with ThreadPoolExecutor(PARTS) as pool:
        list(pool.map(lambda a: fetch_part(url, *a), [(p, s, e) for p, (s, e) in zip(parts, ranges)]))
    with open(target, "wb") as out:
        for p in parts:
            out.write(p.read_bytes())
            p.unlink()
    if target.stat().st_size != total:
        sys.exit("Размер model.bin не совпал, запусти скрипт ещё раз")
    print("Готово:", DEST)


if __name__ == "__main__":
    main()
