# Agent Desk — сборка и устройство пакета

Настоящее приложение для **Windows** (установщик `.exe`) и **Android** (`.apk`) в стиле Windows 98. Следит за ИИ-агентами, хранит единое состояние задач и напоминает только тогда, когда нужно ответить, переслать задание или принять сдачу.

- **ПК (Windows 10/11 x64):** окно и значок в трее, всплывающие уведомления со звуком, тихие часы, автозапуск, встроенные `agentdesk.cmd` и `agentdesk-mcp.cmd` без требования отдельного Node.js.
- **Телефон (Android 6+):** очередь и задачи по домашнему Wi-Fi во весь экран, фоновая служба уведомлений в стиле Windows 98 даже с выключенным экраном.
- **Связанные компьютеры:** автоматическая синхронизация поручений, задач и квитанций по `AES-256-GCM` + опциональный обмен файлами проектных папок `mail`.

Связанная документация:
- [CHANGELOG.md](../CHANGELOG.md) — изменения по версиям и порядок обновления
- [docs/linked-mail-2.3.md](../docs/linked-mail-2.3.md) — синхронизация между ПК, файловая почта и резервное восстановление
- [docs/agent-cli.md](../docs/agent-cli.md) — штатные CLI и MCP (11 инструментов)
- [docs/task-service.md](../docs/task-service.md) — модель задач, переходов и проверок контекста

## Установка и подключение

### Windows
1. Скачайте `AgentDesk-Setup-<версия>.exe` из [Releases](https://github.com/purrfect0/AgentDesk/releases/latest) и запустите (права администратора не нужны).
2. При предупреждении SmartScreen выберите **«Подробнее» → «Выполнить в любом случае»**.
3. Разрешите доступ в **частных сетях** в брандмауэре Windows (TCP `8098` и UDP `8099`).
4. Крестик окна сворачивает приложение в трей; полный выход — через «Файл → Выход» или меню значка в трее. Данные хранятся в `%USERPROFILE%\AgentDesk` (включая автоматическую резервную копию `state.json.bak`).

### Android и подключение к ПК
1. Установите `AgentDesk-<версия>.apk` из [Releases](https://github.com/purrfect0/AgentDesk/releases/latest) и разрешите показ уведомлений.
2. На ПК откройте **«Файл → Подключить телефон…»**, включите доступ из Wi-Fi и отсканируйте QR-код с телефона.
3. На оболочках с агрессивным энергосбережением (Xiaomi, Honor, Huawei, OPPO, vivo, RedMagic, Nubia) включите автозапуск, режим батареи «Без ограничений» и закрепите приложение в недавних.

## Сборка через GitHub Actions и выпуск релиза

Конвейер `.github/workflows/agent-desk.yml` автоматически прогоняет тесты ядра, UI, пиксельного шрифта и синтаксиса, после чего собирает `AgentDesk-Windows` (`.exe` + `.sha256`) и `AgentDesk-Android` (`.apk` + `.sha256`).

Для выпуска новой версии обновите версию в `core/desk.js`, `package.json`, `package-lock.json` и `mobile/package.json`, добавьте раздел `## <версия> — <дата>` в `CHANGELOG.md` и отправьте тег `agent-desk-v<версия>`.

### Постоянная подпись APK (обновление на телефоне без удаления)

Чтобы Android ставил новые сборки поверх прежних без переустановки, один раз создайте ключ (нужна Java):

```bash
keytool -genkeypair -v -keystore debug.keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
```

Закодируйте файл в Base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("debug.keystore")) | Set-Clipboard`) и сохраните в секретах репозитория GitHub под именем `ANDROID_DEBUG_KEYSTORE`.

## Локальная сборка

Требуется Node.js 20+ (для локальной сборки APK также нужны JDK 21 и Android SDK).

```bash
cd agent-desk
node scripts/fetch-assets.js       # 98.css и значки Win98
npm ci
npm test                           # тесты ядра, синхронизации, безопасности и CLI/MCP
node --test web/linked-ui.test.js  # DOM-тесты интерфейса
node scripts/make-font.js --check  # проверка кириллического пиксельного шрифта
npm start                          # запуск из исходников
npm run dist:win                   # сборка dist/AgentDesk-Setup-<версия>.exe

# Графика для главной страницы GitHub:
node scripts/make-readme-art.js
```

## Структура каталога `agent-desk/`

```text
agent-desk/
  core/
    desk.js             ядро, конвейер маркеров, дельта-состояние, диагностика и HTTP API
    tasks.js            жизненный цикл задач, идемпотентность, контекст и handoff/handback
    sync.js             журнал синхронизации, Lamport-версии, компактизация и AES-256-GCM
    peers.js            обнаружение в Wi-Fi (UDP 8099), сопряжение по коду и репликация пар
    mail.js             безопасный обмен файлами проектных папок mail по фрагментам с SHA-256
    marker-schema.js    единая схема маркеров, шаблоны и классификация причин отказа
    adapters.js         реестр адаптеров запуска (ручной режим, mock dry-run, внешние шлюзы)
    agent-client.js     локальный HTTP-клиент агентского контура
    cli.js              штатный CLI (inbox, read, ack, submit, status, assign, transition, handoff, coordinate, context, validate)
    mcp.js              официальный MCP stdio-сервер (11 инструментов)
    test/               модульные, интеграционные, нагрузочные и защитные автотесты
  desktop/              оболочка Electron для Windows: окно, трей, стопка уведомлений, обёртки .cmd
  web/                  общий интерфейс Win98 для ПК и Android + пиксельный шрифт с кириллицей
  mobile/               проект Capacitor для Android + нативная фоновая служба WatchService
  scripts/              загрузка ассетов, генерация шрифта и SVG-оформления README, подготовка mobile/www
```

## Ограничения

- **Домашняя сеть:** телефон подключается к ПК по локальному HTTP с ключом сопряжения; межузловая синхронизация между связанными ПК шифруется `AES-256-GCM`. Не публикуйте порт `8098` напрямую в интернет и отключайте доступ из Wi-Fi в публичных сетях.
- **Подпись сборок:** установщик Windows не подписан платным сертификатом EV/Authenticode (SmartScreen предупреждает при первом запуске); APK подписывается ключом из `ANDROID_DEBUG_KEYSTORE` (или временным debug-ключом, если секрет не задан).
