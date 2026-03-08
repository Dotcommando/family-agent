# family-agent

Persistent семейный ассистент с тремя контурами: событийный, исполнитель очереди, фоновая рефлексия.

## Стек

- Node.js 24 LTS
- TypeScript
- LanceDB
- Ollama
- Podman Compose / Docker Compose
- Markdown-first memory
- Локальная папка `runtime-secrets/` вместо Docker secrets

## Что где работает

Агент состоит из двух частей:

- **Агент** — работает внутри Docker-контейнера. Это основной процесс: три контура, LLM через Ollama, очередь, память.
- **CLI (`famagent`)** — работает на хосте (на твоём компьютере, не в контейнере). Это лёгкая утилита, которая отправляет HTTP-запросы агенту и сразу завершается.

```
┌─────────────────────────────────────────────────┐
│ Хост                                            │
│                                                 │
│  $ famagent -m "Привет"                         │
│       │                                         │
│       │ HTTP POST localhost:3000                 │
│       ▼                                         │
│  ┌──────────────────────────────┐               │
│  │ Docker: family-agent-app     │               │
│  │                              │               │
│  │  Очередь ← событие          │               │
│  │  Orchestrator → Ollama → ответ               │
│  │  Ответ → state/terminal-chat/│               │
│  └──────────────────────────────┘               │
│       │                                         │
│  $ famagent --history                           │
│       │ HTTP GET localhost:3000                  │
│       ▼                                         │
│  (читает ответ из лога)                         │
└─────────────────────────────────────────────────┘
```

Закрытие терминала ничего не убивает — CLI отработал и вышел, агент живёт в контейнере.

## Быстрый старт

### 1. Создай `.env`

```bash
cp .env.example .env
```

### 2. Создай папку секретов

```bash
mkdir -p runtime-secrets
```

Можно оставить пустой. Агент запустится без секретов — Telegram, n8n и другие интеграции будут пропущены. Для общения через терминал секреты не нужны.

### 3. Собери и запусти агента

```bash
podman-compose up --build -d
```

или

```bash
docker compose up --build -d
```

### 4. Скачай модель в Ollama

```bash
docker exec family-agent-ollama ollama pull llama3.2
```

Без этого шага агент стартует, принимает сообщения, но не может сгенерировать ответ — Ollama не знает модель.

### 5. Собери CLI на хосте

CLI — это не часть Docker-образа. Он устанавливается на хосте:

```bash
npm install
npm run build
chmod +x dist/cli.js
npm link
```

Что делает каждая команда:
- `npm install` — ставит зависимости (нужно для `tsc`)
- `npm run build` — компилирует TypeScript в `dist/`
- `chmod +x dist/cli.js` — даёт файлу права на исполнение (нужно для shebang `#!/usr/bin/env node`)
- `npm link` — создаёт глобальный симлинк, чтобы команда `famagent` была доступна из любой директории

Подробнее про `npm link`: эта команда смотрит в `package.json` → `"bin": { "famagent": "dist/cli.js" }` и создаёт симлинк из глобальной папки npm (обычно `/usr/local/bin/famagent`) на `dist/cli.js` в проекте. После этого `famagent` работает как обычная консольная команда.

Если не хочется делать `npm link`:

```bash
node dist/cli.js -m "Привет!"
```

или

```bash
npm run cli -- -m "Привет!"
```

### 6. Проверь, что всё работает

```bash
famagent --status
curl http://localhost:3000/health
```

### Перед коммитом в git

Файл `src/cli.ts` должен иметь executable bit:

```bash
chmod +x src/cli.ts
git add src/cli.ts
```

Без этого у других разработчиков после `git clone` и `npm run build` CLI не запустится через `npm link` на Linux/macOS.

## Выбор модели

Модель задаётся через переменную `OLLAMA_MODEL` в `.env`:

```env
OLLAMA_MODEL=llama3.2
```

Для видеокарты с 24 ГБ VRAM подойдут:
- `llama3.2` (3B, ~2 ГБ) — быстрая, хороший старт
- `llama3.1:8b` (~5 ГБ) — лучше по качеству
- `gemma2:9b` (~6 ГБ) — хорошая альтернатива
- `mistral` (7B, ~4 ГБ) — классика
- `command-r` (35B, ~20 ГБ) — если хочется выжать максимум из 24 ГБ

Модель используется во всех трёх местах: reasoning (обработка сообщений), thought loop (фоновая рефлексия), summarization (саммаризация памяти).

Перед первым использованием модель нужно скачать:

```bash
docker exec family-agent-ollama ollama pull llama3.2
```

Если Ollama недоступна, агент не падает — он запишет в лог «Ollama unreachable» и дождётся следующего цикла.

## Общение через терминал

Терминал — основной способ общения с агентом без Telegram.

### Команды

| Команда | Что делает |
|---|---|
| `famagent -m "текст"` | Отправить сообщение агенту |
| `famagent --history` | Показать последние 20 сообщений |
| `famagent --history N` | Показать последние N сообщений |
| `famagent --status` | Статус агента, интеграций, конфигурация |
| `famagent --help` | Справка |

### Пример сессии

```bash
$ famagent -m "Привет, я Михаил. Твой создатель. Теперь ты часть моей семьи."
✓ Сообщение поставлено в очередь
  Агент обработает его в следующем цикле.
  Чтобы увидеть ответ: famagent --history 5

# Подождать ~30-60 секунд (поллинг + окно коалесинга + время Ollama)

$ famagent --history 5
[08.03.2026, 15:40:00] 👤 Вы:
  Привет, я Михаил. Твой создатель. Теперь ты часть моей семьи.

[08.03.2026, 15:40:45] 🤖 Агент:
  Здравствуйте, Михаил! Рад познакомиться...
```

### Почему ответ не мгновенный

Сообщение проходит полный цикл агента:
1. CLI отправляет POST → сообщение попадает в очередь
2. Event poll (каждые `AGENT_EVENT_POLL_SECONDS`, по умолчанию 10с)
3. Ожидание окна коалесинга (`AGENT_COALESCE_WINDOW_SECONDS`, по умолчанию 45с) — чтобы собрать возможные уточнения
4. Reasoning через Ollama (время зависит от модели и GPU)
5. Ответ сохраняется в лог

Итого: от отправки до ответа может пройти 30-90 секунд. Это нормально — агент спроектирован не как чат-бот с мгновенными ответами, а как persistent assistant с обдумыванием.

### Как это работает внутри

```
famagent -m "текст"
    │
    │  HTTP POST /terminal/send
    ▼
TerminalAdapter.logUserMessage()  ← сохраняет в state/terminal-chat/
    │
EventBus.emit({source: 'terminal', chatId: 'terminal-local', ...})
    │
EventQueue.enqueue()              ← файл в state/queue/pending/
    │
    ... event poll tick ...
    │
Orchestrator.tickEventPoll()
    │  коалесинг, батчинг
    ▼
runReasoning() → Ollama
    │
    ▼
TerminalAdapter.sendResponse()    ← сохраняет ответ в state/terminal-chat/
```

`famagent --history` просто делает GET `/terminal/history` и читает тот же лог.

### Переменная AGENT_URL

По умолчанию CLI обращается к `http://localhost:3000`. Если агент на другом адресе:

```bash
AGENT_URL=http://192.168.1.100:3000 famagent --status
```

## Архитектура каналов

Агент не привязан к конкретному способу общения. Каждый канал — это адаптер, реализующий интерфейс `IChannelAdapter`:

```
IChannelAdapter
├── TerminalAdapter   — всегда доступен, общение через CLI
├── TelegramAdapter   — активируется при наличии секретов
└── (будущие)         — HTTP webhook, RSS, Reddit, ...
```

Когда приходит сообщение, оно несёт метку `source` (например, `terminal` или `telegram`). После reasoning оркестратор находит адаптер для этого source и отправляет ответ через него. Агент всегда отвечает в тот канал, из которого пришло сообщение.

Чтобы добавить новый канал:
1. Создать класс, реализующий `IChannelAdapter`
2. Зарегистрировать его в массиве `channels` при старте (в `src/index.ts`)
3. Добавить маппинг `EventSource → channel kind` в оркестраторе

## Секреты

Все секреты опциональны. Агент стартует без них в полнофункциональном режиме (минус те интеграции, которым нужны ключи).

Секреты лежат в обычных файлах в `runtime-secrets/`:

```bash
runtime-secrets/
├── telegram_api_id      # Telegram API ID (число)
├── telegram_api_hash    # Telegram API hash
├── telegram_session     # Session string пользовательского аккаунта
└── n8n_api_key          # API key для n8n
```

Папка не коммитится (в `.gitignore`). В контейнер попадает как readonly volume `/run/secrets`.

Чтобы заполнить из шаблонов:

```bash
cp -R runtime-secrets.example runtime-secrets
# Отредактируй файлы
```

Агент не пишет содержимое секретов в логи, memory или LanceDB. В логах только masked preview:

```
[boot] secrets status:
- telegram_api_id: present (12***78)
- telegram_api_hash: present (ab***90)
- telegram_session: missing (missing)
- n8n_api_key: missing (missing)
```

## Принципы архитектуры

### Три контура

#### 1. Событийный контур

Новые сообщения (терминал, Telegram, n8n, браузер, будущие источники) не ждут thought loop. Они мгновенно попадают в файловую очередь `state/queue/pending/`.

#### 2. Исполнитель очереди

В каждый момент времени активна только одна reasoning job. Пока она работает, новые события продолжают складываться в очередь. Пользовательские события имеют приоритет над фоновыми.

#### 3. Фоновая рефлексия

Thought loop запускается по таймеру (`AGENT_THOUGHT_LOOP_SECONDS`, по умолчанию 240с). Если в очереди есть пользовательские события или активна job — рефлексия пропускается.

### Коалесинг событий

Если пока агент думает, из одного чата пришло несколько сообщений, они не обрабатываются как отдельные задания:

- Сообщения из одного чата стакаются в пределах окна коалесинга
- Более позднее сообщение может отменять раннюю инструкцию
- Reasoning запускается по объединённому контексту

Настройки в `.env`:
- `AGENT_COALESCE_WINDOW_SECONDS` (45) — окно ожидания перед обработкой
- `AGENT_MESSAGE_BATCH_WINDOW_SECONDS` (30) — окно батчинга сообщений
- `AGENT_CHAT_COALESCE_MAX_ITEMS` (20) — максимум сообщений в одном батче

## Структура памяти

Markdown-файлы — канонический источник. LanceDB — производный индекс.

```
memory/
├── plans/
│   └── next-run.md              — план на следующий запуск
├── runs/                        — резюме каждого reasoning-цикла
├── summaries/
│   ├── 1h/                      — саммари за последний час
│   ├── 3h/
│   ├── 6h/
│   ├── 24h/
│   ├── 7d/
│   ├── 30d/
│   ├── 90d/
│   ├── 180d/
│   └── 365d/
└── identity/
    └── agent.md                 — идентичность агента
```

Горизонты саммаризации задаются через `AGENT_SUMMARIZATION_MILESTONES` в `.env`.

## Operational state

```
state/
├── queue/
│   ├── pending/                 — ожидающие обработки события
│   ├── processing/              — текущая job
│   ├── done/                    — завершённые jobs
│   └── failed/                  — упавшие jobs
├── terminal-chat/               — лог терминального чата (JSON)
└── purpose/
    └── main.md                  — кто агент, для чего, ограничения
```

`state/purpose/main.md` загружается в контекст агента при каждом reasoning-цикле.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `AGENT_NAME` | `family-agent` | Имя агента |
| `AGENT_PORT` | `3000` | HTTP-порт |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | URL Ollama |
| `OLLAMA_MODEL` | `llama3.2` | Модель для всех LLM-вызовов |
| `LANCEDB_DIR` | `/app/data/lancedb` | Путь к LanceDB |
| `MEMORY_DIR` | `/app/memory` | Путь к markdown-памяти |
| `SECRETS_DIR` | `/run/secrets` | Путь к секретам |
| `PURPOSE_DIR` | `/app/state/purpose` | Путь к purpose-файлу |
| `TERMINAL_CHAT_DIR` | `/app/state/terminal-chat` | Путь к логу терминального чата |
| `AGENT_QUEUE_DIR` | `/app/state/queue` | Путь к очереди |
| `AGENT_EVENT_POLL_SECONDS` | `10` | Интервал поллинга очереди |
| `AGENT_IDLE_BACKOFF_SECONDS` | `30` | Backoff при пустой очереди |
| `AGENT_THOUGHT_LOOP_SECONDS` | `240` | Интервал фоновой рефлексии |
| `AGENT_MAX_CONCURRENT_JOBS` | `1` | Макс. параллельных jobs |
| `AGENT_PROACTIVE_MODE` | `true` | Включена ли фоновая рефлексия |
| `AGENT_COALESCE_WINDOW_SECONDS` | `45` | Окно коалесинга |
| `AGENT_MESSAGE_BATCH_WINDOW_SECONDS` | `30` | Окно батчинга сообщений |
| `AGENT_CHAT_COALESCE_MAX_ITEMS` | `20` | Макс. сообщений в батче |
| `AGENT_EVENT_QUEUE_STRATEGY` | `priority-fifo` | Стратегия очереди |
| `AGENT_THOUGHT_LOOP_SKIP_WHEN_QUEUE_NOT_EMPTY` | `true` | Пропускать рефлексию при наличии событий |
| `AGENT_DEDUP_THOUGHT_LOOP` | `true` | Дедупликация thought loop |
| `AGENT_DEDUP_SUMMARY_JOBS` | `true` | Дедупликация саммаризации |
| `AGENT_SUMMARIZATION_MILESTONES` | `1h,3h,...,365d` | Горизонты саммаризации |
| `AGENT_SUMMARIZATION_MAX_INPUT_ITEMS` | `200` | Макс. файлов на вход саммаризации |
| `AGENT_SUMMARY_RUN_ONLY_WHEN_IDLE` | `true` | Саммаризация только в idle |
| `AGENT_SUMMARY_MIN_IDLE_SECONDS` | `60` | Мин. idle перед саммаризацией |
| `AGENT_SUMMARY_MAX_CONCURRENT` | `1` | Макс. параллельных саммаризаций |
| `AGENT_SUMMARY_RAW_RETENTION_DAYS` | `14` | Сколько дней хранить сырые run-файлы |
