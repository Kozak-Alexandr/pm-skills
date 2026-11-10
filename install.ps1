# Установка скиллов в Claude Code: копирует папки из skills/ в ~/.claude/skills.
# Запуск из папки репозитория: powershell -ExecutionPolicy Bypass -File install.ps1
# Повторный запуск обновляет код скиллов; данные пользователя (~/meeting-transcribe, ~/pain-registry) не трогает.

$ErrorActionPreference = "Stop"
$Target = Join-Path $HOME ".claude\skills"
New-Item -ItemType Directory -Force $Target | Out-Null

Get-ChildItem (Join-Path $PSScriptRoot "skills") -Directory | ForEach-Object {
    $dest = Join-Path $Target $_.Name
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse $_.FullName $dest
    Write-Host "установлен скилл: $($_.Name)"
}

$LlmEnv = Join-Path $HOME ".llm.env"
if (-not (Test-Path $LlmEnv)) {
    "# OpenAI-совместимый API для сведения текста и саммари. Пусто: будет использован Claude Code CLI.`n# Примеры: https://api.openai.com/v1 + gpt-4.1; https://openrouter.ai/api/v1 + qwen/qwen3-235b-a22b`nLLM_BASE_URL=`nLLM_API_KEY=`nLLM_MODEL=`n" |
        Out-File -Encoding utf8 $LlmEnv
    Write-Host "создан $LlmEnv: впиши адрес, ключ и модель LLM (или оставь пустым для Claude Code CLI)"
}

Write-Host ""
Write-Host "Готово. Перезапусти Claude Code и напиши, например:"
Write-Host "  расшифруй встречу C:\Users\...\запись.mp3"
Write-Host "  собери бэклог из интервью в папке C:\...\custdev"
Write-Host "Для расшифровки при первом запуске Claude предложит поставить окружение (torch и модели, около 6 ГБ)."
