# family-agent

Стартовый каркас для домашнего persistent-агента.

В текущем виде проект уже умеет:
- запускаться на Node.js 24
- читать секреты из `./runtime-secrets`, примонтированных в контейнер как `/run/secrets`
- печатать понятный статус чтения секретов при старте
- поднимать локальное LanceDB-хранилище на диске
- держать md-память в `./memory`
- готовить базу под Ollama + AMD ROCm
- читать базовые настройки циклов и саммаризации из `.env`

## Стек

- Node.js 24 LTS
- TypeScript
- LanceDB
- Ollama
- Podman Compose / Docker Compose
- Markdown-first memory
- Локальная папка `runtime-secrets/` вместо Docker secrets

## Принципы архитектуры

Система должна развиваться как три подсистемы:
- событийный контур
- исполнитель очереди
- фоновая рефлексия

### 1. Событийный контур

Новые сообщения Telegram, задачи браузера, входящие события n8n и будущие внешние источники не должны ждать большую thought-loop-петлю. Они сразу попадают в очередь.

### 2. Исполнитель очереди

В каждый момент времени активна только одна основная job. Пока она работает, новые события продолжают складываться в очередь.

### 3. Фоновая рефлексия

Большая thought loop запускается по таймеру, но только если не мешает более важной пользовательской работе.

## Коалесинг событий

Если пока агент думает, из одного и того же чата пришло несколько сообщений, их нельзя обрабатывать как независимые задания без попытки объединения.

Ожидаемое поведение:
- новые сообщения из одного чата в пределах окна коалесинга должны стакаться
- если более позднее сообщение отменяет раннюю инструкцию, приоритет у позднего сообщения
- агент должен видеть пачку сообщений как единый контекст для одного решения

Для этого в `.env` уже вынесены настройки:
- `AGENT_COALESCE_WINDOW_SECONDS`
- `AGENT_DEDUP_THOUGHT_LOOP`
- `AGENT_DEDUP_SUMMARY_JOBS`

## Почему секреты здесь не через `compose secrets`

Для максимальной простоты и совместимости с `podman-compose` секреты лежат в обычной локальной папке:

- локально они лежат в `./runtime-secrets`
- папка не коммитится
- в контейнер попадают как `/run/secrets`

Это упрощает ручное добавление новых блогов, каналов, логинов и токенов без лишней церемонии.

## Быстрый старт

1. Создай `.env`:

```bash
cp .env.example .env
```

2. Скопируй шаблоны секретов:

```bash
cp -R runtime-secrets.example runtime-secrets
```

3. Заполни реальные значения в `runtime-secrets/*`.

4. Собери и запусти:

```bash
podman-compose up --build
```

или

```bash
docker compose up --build
```

5. Проверь статус:

```bash
curl http://localhost:3000/health
```

Ожидаемый результат — JSON со статусами `ok` и `present`.

## Какие секреты нужны

### `runtime-secrets/telegram_api_id`
Обычный Telegram API ID.

### `runtime-secrets/telegram_api_hash`
Обычный Telegram API hash.

### `runtime-secrets/telegram_session`
Session string пользовательского Telegram-аккаунта.

### `runtime-secrets/n8n_api_key`
API key для доступа к твоему n8n.

## Что будет знаком, что секреты читаются

При старте агент печатает примерно такое:

```text
[boot] secrets status:
- telegram_api_id: present (12***78)
- telegram_api_hash: present (ab***90)
- telegram_session: present (1A***YZ)
- n8n_api_key: present (n8***yz)
```

И endpoint `/health` тоже показывает статус чтения секретов.

## Структура памяти

- `memory/plans/next-run.md` — план на следующий запуск
- `memory/runs/` — итоговые резюме запусков
- `memory/summaries/1h/`
- `memory/summaries/3h/`
- `memory/summaries/6h/`
- `memory/summaries/24h/`
- `memory/summaries/7d/`
- `memory/summaries/30d/`
- `memory/summaries/90d/`
- `memory/summaries/180d/`
- `memory/summaries/365d/`
- `memory/identity/`

## Operational state

- `state/queue/pending/`
- `state/queue/processing/`
- `state/queue/done/`
- `state/queue/failed/`

На старте это просто каркас. Полная логика очереди, коалесинга, приоритетов и scheduler'ов должна быть реализована следующим этапом.

## Что дальше просить у Perplexity Computer

1. Реализовать Telegram через MTProto user account
2. Добавить Playwright persistent browser profile
3. Реализовать событийную очередь с коалесингом сообщений по chat/thread
4. Реализовать большой thought loop как low-priority job
5. Реализовать scheduler для саммаризации по `AGENT_SUMMARIZATION_MILESTONES`
6. Реализовать LanceDB-индексацию markdown-файлов
7. Добавить blog tools и n8n tools
8. Добавить правила, чтобы саммаризация не раздувала итоговый prompt за контекстное окно
