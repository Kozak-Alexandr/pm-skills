# Установка окружения для расшифровки встреч (Windows, PowerShell).
# Запуск: powershell -ExecutionPolicy Bypass -File setup.ps1
# Повторный запуск безопасен: уже установленное пропускается.

$ErrorActionPreference = "Stop"
$Skill = Split-Path -Parent $PSScriptRoot
$Venv = if ($env:TRANSCRIBE_VENV) { $env:TRANSCRIBE_VENV } else { Join-Path $HOME ".venvs\transcribe" }
$Py = Join-Path $Venv "Scripts\python.exe"
$env:UV_HTTP_TIMEOUT = "600"

Write-Host "1/5 uv"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    python -m pip install --user uv --index-url https://pypi.org/simple
}

Write-Host "2/5 venv: $Venv"
if (-not (Test-Path $Py)) { uv venv $Venv --python 3.12 }

$Gpu = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$TorchIndex = if ($Gpu) { "https://download.pytorch.org/whl/cu126" } else { "https://download.pytorch.org/whl/cpu" }
Write-Host ("3/5 пакеты (" + $(if ($Gpu) { "видеокарта NVIDIA найдена" } else { "видеокарты нет, всё будет на CPU и медленнее" }) + ")")
Write-Host "    torch весит 2,5 ГБ; через корпоративный прокси это может занять 10-40 минут"
uv pip install --python $Py --index-url https://pypi.org/simple --extra-index-url $TorchIndex `
    --index-strategy unsafe-best-match `
    "torch==2.10.*" "torchaudio==2.10.*" "torchcodec==0.10.*" faster-whisper "pyannote.audio==4.0.*" `
    silero-vad imageio-ffmpeg pyyaml "gigaam @ git+https://github.com/salute-developers/GigaAM"

Write-Host "4/5 модель Whisper large-v3 (3 ГБ)"
& $Py (Join-Path $PSScriptRoot "download_whisper.py")

Write-Host "5/5 папка данных"
& $Py -c "import sys; sys.path.insert(0, r'$PSScriptRoot'); import settings; print(settings.HOME)"

$LlmEnv = Join-Path $HOME ".llm.env"
if (-not (Test-Path $LlmEnv)) {
    "# OpenAI-совместимый API для сведения текста и саммари. Пусто: будет использован Claude Code CLI.`n# Примеры: https://api.openai.com/v1 + gpt-4.1; https://openrouter.ai/api/v1 + qwen/qwen3-235b-a22b`nLLM_BASE_URL=`nLLM_API_KEY=`nLLM_MODEL=`n" |
        Out-File -Encoding utf8 $LlmEnv
}

Write-Host ""
Write-Host "Готово. Осталось два шага руками (ключи в чат не присылай):"
Write-Host "  1. LLM для сведения и саммари: адрес, ключ и модель OpenAI-совместимого API в $LlmEnv."
Write-Host "     Если оставить пустым, используется Claude Code CLI (нужен вход: claude, затем /login)."
Write-Host "  2. Для разделения спикеров: прими условия https://huggingface.co/pyannote/speaker-diarization-community-1,"
Write-Host "     создай read-токен на https://huggingface.co/settings/tokens и впиши в $HOME\meeting-transcribe\.env (HF_TOKEN=)"
