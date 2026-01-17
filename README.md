# Binance Futures Loss Guardian 2.0

## Overview

Автоматический стоп-лосс для Binance Futures, который:
- Мониторит все открытые позиции USDT-M perpetual каждые N миллисекунд
- Отображает позиции с цветным PnL (зеленый/красный)
- **Отслеживает позиции без стоп-лосса** и отправляет уведомления в Telegram
- Автоматически закрывает позиции, если убыток превышает заданный лимит
- Отменяет все открытые ордера (включая algo orders: SL, TP, trailing stops) перед закрытием позиции
- Поддерживает новые Binance API с algo orders (STOP_MARKET, TAKE_PROFIT_MARKET и др.)
- Имеет встроенный HTTP healthcheck endpoint для мониторинга
- Автоматически перезапускается при критических ошибках
- Устойчив к сетевым сбоям и rate limits (exponential backoff)

**Цель**: Защита от больших убытков при торговле на Binance Futures и мониторинг позиций без стоп-лосса.

## Setup

### Требования
- Bun >= 1.0 (или Node.js >= 18 для альтернативной версии)
- Аккаунт Binance с API ключами для Futures
- Доступ к Binance Futures API

### Установка

```bash
# Установка зависимостей
bun install
```

### Переменные окружения

Создайте файл `.env` в корне проекта:

```env
# Обязательные
BINANCE_API_KEY=your_api_key_here
BINANCE_API_SECRET=your_api_secret_here

# Опциональные (значения по умолчанию)
MAX_LOSS_USD=100              # Максимальный убыток в USDT перед закрытием
INTERVAL_MS=1000              # Интервал опроса позиций (мс)
RECV_WINDOW=5000              # Окно получения запросов (мс)
BASE_URL=https://fapi.binance.com
DRY_RUN=false                 # Режим тестирования (не закрывает реально)
SHOW_ALL=true                 # Показывать все позиции в логах
LOG_SYMBOL_FILTER=            # Фильтр символов (через запятую, например: BTCUSDT,ETHUSDT)
HEALTHCHECK_PORT=3000         # Порт для healthcheck endpoint
MAX_RESTART_ATTEMPTS=10       # Максимум попыток перезапуска
RESTART_BACKOFF_MS=5000       # Задержка перед перезапуском (мс)
# Telegram уведомления (опционально)
ENABLE_TELEGRAM_NOTIFICATIONS=false  # Включить уведомления в Telegram
TELEGRAM_BOT_TOKEN=          # Токен бота от @BotFather
TELEGRAM_CHAT_ID=             # ID чата или канала (можно получить у @userinfobot)
TELEGRAM_NOTIFICATION_INTERVAL_MS=15000  # Интервал между уведомлениями (мс, минимум 5 сек)
```

## Запуск

### Локально (Windows/WSL/Linux)

```bash
# Запуск с Bun
bun run index.ts

# Или с Node.js (если установлен ts-node)
npx ts-node index.ts
```

### Docker

```bash
# Сборка образа
docker build -t binance-loss-guardian .

# Запуск контейнера
docker run -d \
  --name loss-guardian \
  --env-file .env \
  -p 3000:3000 \
  binance-loss-guardian
```

## Деплой на Render

### Вариант 1: Через render.yaml (рекомендуется)

1. Создайте аккаунт на [Render.com](https://render.com)
2. Подключите ваш GitHub репозиторий
3. Render автоматически обнаружит `render.yaml` и создаст сервис
4. В настройках сервиса добавьте переменные окружения:
   - `BINANCE_API_KEY` (обязательно)
   - `BINANCE_API_SECRET` (обязательно)
   - Остальные переменные можно настроить по необходимости

### Вариант 2: Через веб-интерфейс Render

1. В Dashboard Render нажмите "New +" → "Web Service"
2. Подключите репозиторий
3. Настройки:
   - **Name**: `binance-loss-guardian`
   - **Environment**: `Docker`
   - **Dockerfile Path**: `./Dockerfile`
   - **Docker Context**: `.`
   - **Health Check Path**: `/health`
4. Добавьте переменные окружения (см. раздел выше)
5. Нажмите "Create Web Service"

### Healthcheck

После деплоя сервис будет доступен по адресу:
- `https://your-service.onrender.com/health` - проверка здоровья

Ответ healthcheck:
```json
{
  "status": "healthy",
  "healthy": true,
  "lastTickTime": 1234567890,
  "consecutiveErrors": 0,
  "uptime": 3600,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Конфигурация

### Пример конфигурации для консервативной торговли

```env
MAX_LOSS_USD=50
INTERVAL_MS=2000
DRY_RUN=false
SHOW_ALL=true
```

### Пример для агрессивной торговли

```env
MAX_LOSS_USD=200
INTERVAL_MS=500
DRY_RUN=false
```

## Использование

1. **Запустите приложение** - оно начнет мониторить позиции
2. **Следите за логами** - вы увидите все открытые позиции с PnL
3. **Мониторинг позиций без SL**:
   - Приложение автоматически проверяет наличие стоп-лосса для каждой позиции
   - Если позиция открыта без SL (нет algo order типа STOP_MARKET/STOP с qty > 0), отправляются уведомления в Telegram
   - Уведомления отправляются с заданным интервалом (по умолчанию каждые 15 секунд)
   - Когда SL появляется, уведомления прекращаются
4. **При превышении лимита** - позиция будет автоматически закрыта:
   - Сначала отменяются все открытые ордера (обычные + algo orders: SL, TP, trailing stops)
   - Затем позиция закрывается market ордером с `reduceOnly=true`
   - Выполняется проверка закрытия позиции (несколько попыток через HTTP запросы):
     * Проверяется, что `positionAmt === 0` (позиция закрыта)
     * Проверяется, что нет открытых обычных ордеров
     * Проверяется, что нет открытых algo ордеров
   - Отправляется уведомление в Telegram с результатами проверки

### Пример вывода

```
=== Binance Futures Loss Guardian (polling every 1000ms, max loss 100 USDT, dryRun=false) ===
BTCUSDT    | ▲ LONG  | amt=0.100000 | PnL=+15.50 USDT
ETHUSDT    | ▼ SHORT | amt=1.500000 | PnL=-25.30 USDT
[SL ALERT] ETHUSDT LONG position without SL!
[ALERT] ETHUSDT loss 25.30 ≥ 100. Closing...
ETHUSDT regular orders canceled
ETHUSDT algo orders (SL/TP) canceled
Closed ETHUSDT via BUY 1.5. OrderId=12345, status=FILLED
Verifying position closure for ETHUSDT...
✅ Verified: ETHUSDT position closed, all orders canceled
```

### Уведомления при закрытии позиции

При закрытии позиции отправляется уведомление в Telegram с деталями:

```
✅ POSITION CLOSED: ETHUSDT
Side: BUY
Quantity: 1.5
Order ID: 12345
Status: FILLED
PnL before close: -25.30 USDT

Verification:
Position: ✅ Closed
Orders remaining: 0
Details: Position closed, all orders canceled (regular: 0, algo: 0)

Regular orders: ✅ Canceled
Algo orders: ✅ Canceled
```

Если проверка не прошла успешно, в уведомлении будет указано, что именно не удалось закрыть.

### Настройка Telegram уведомлений

1. **Создайте бота**:
   - Откройте Telegram и найдите [@BotFather](https://t.me/BotFather)
   - Отправьте команду `/newbot` и следуйте инструкциям
   - Сохраните полученный токен (например: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. **Получите Chat ID**:
   - Для личных сообщений: найдите [@userinfobot](https://t.me/userinfobot) и отправьте `/start`
   - Для канала: добавьте бота в канал как администратора, затем отправьте сообщение в канал и получите chat_id через API или используйте [@getidsbot](https://t.me/getidsbot)
   - Chat ID для канала обычно начинается с `-100` (например: `-1001234567890`)

3. **Настройте переменные окружения**:
   ```env
   ENABLE_TELEGRAM_NOTIFICATIONS=true
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   TELEGRAM_CHAT_ID=-1001234567890
   TELEGRAM_NOTIFICATION_INTERVAL_MS=15000
   ```

4. **Формат уведомлений**:
   - **Позиции без SL**: Уведомления отправляются каждые N миллисекунд (по умолчанию 15 сек)
     ```
     ⚠️ ETHUSDT POSITION WITHOUT SL!
     Side: LONG
     Size: 1.500000
     PnL: -25.30 USDT
     ```
   - **Закрытие позиции**: Уведомление отправляется один раз с деталями проверки
     ```
     ✅ POSITION CLOSED: ETHUSDT
     Side: BUY
     Quantity: 1.5
     Order ID: 12345
     Status: FILLED
     PnL before close: -25.30 USDT
     
     Verification:
     Position: ✅ Closed
     Orders remaining: 0
     Details: Position closed, all orders canceled (regular: 0, algo: 0)
     
     Regular orders: ✅ Canceled
     Algo orders: ✅ Canceled
     ```
   - Уведомления о позициях без SL прекращаются, когда SL появляется или позиция закрывается

## Тестирование

### Dry Run режим

Установите `DRY_RUN=true` для тестирования без реальных сделок:

```env
DRY_RUN=true
```

В этом режиме приложение будет логировать действия, но не выполнять их.

## Troubleshooting

### Ошибка "Missing required env: BINANCE_API_KEY"

**Решение**: Убедитесь, что переменные окружения установлены:
- В `.env` файле (локально)
- В настройках сервиса Render (на продакшене)

### Ошибка "Too many consecutive errors"

**Причина**: Слишком много ошибок подряд (сеть, API, и т.д.)

**Решение**: 
- Проверьте интернет-соединение
- Проверьте валидность API ключей
- Увеличьте `INTERVAL_MS` для снижения нагрузки
- Проверьте лимиты API Binance

### Healthcheck возвращает 503

**Причина**: Приложение не может выполнить tick или слишком много ошибок

**Решение**:
- Проверьте логи в Render Dashboard
- Убедитесь, что API ключи валидны
- Проверьте доступность Binance API

### Позиция не закрывается

**Возможные причины**:
- `DRY_RUN=true` - проверьте переменную окружения
- Недостаточно средств для комиссии
- Позиция уже закрыта вручную
- Проблемы с API (проверьте логи)

### Telegram уведомления не приходят

**Возможные причины**:
- `ENABLE_TELEGRAM_NOTIFICATIONS=false` - установите в `true`
- Неверный `TELEGRAM_BOT_TOKEN` - проверьте токен у @BotFather
- Неверный `TELEGRAM_CHAT_ID` - проверьте ID через @userinfobot или @getidsbot
- Бот не добавлен в канал как администратор (для каналов)
- Позиция имеет стоп-лосс (проверка работает корректно)

### Позиция определяется как "без SL", хотя SL есть

**Причина**: Приложение проверяет algo orders (STOP_MARKET, STOP) и обычные stop orders. Если SL установлен через другой механизм, он может не определяться.

**Решение**: Убедитесь, что SL установлен как algo order типа STOP_MARKET или STOP с qty > 0 или closePosition=true.

### Проверка закрытия позиции не проходит

**Причина**: Проверка выполняется через HTTP запросы к Binance API. Иногда требуется время для обновления состояния на бирже.

**Решение**: 
- Приложение делает до 5 попыток проверки с задержкой 1 секунда
- Если проверка не прошла, уведомление в Telegram покажет детали
- Проверьте логи для дополнительной информации
- В редких случаях может потребоваться ручная проверка на бирже

## Мониторинг

### Логи

Все действия логируются в консоль:
- `[ALERT]` - превышение лимита убытка
- `[ERR]` - ошибки
- `[WARN]` - предупреждения
- `[DRY]` - действия в dry run режиме

### Healthcheck

Используйте `/health` endpoint для мониторинга:
- Проверяйте статус каждые 30 секунд
- Настройте алерты на `status: "unhealthy"`

## Безопасность

⚠️ **ВАЖНО**:
- Никогда не коммитьте `.env` файл в Git
- Используйте отдельные API ключи только для этого приложения
- Ограничьте права API ключей (только Futures, без вывода средств)
- Регулярно проверяйте логи на подозрительную активность

## Changelog

- 2024-01-XX: Добавлен мониторинг позиций без стоп-лосса
- 2024-01-XX: Интегрированы Telegram уведомления для позиций без SL
- 2024-01-XX: Добавлена поддержка algo orders (STOP_MARKET, TAKE_PROFIT_MARKET и др.)
- 2024-01-XX: Обновлена логика закрытия позиций - отменяются все типы ордеров (regular + algo)
- 2024-01-XX: Добавлен автоматический перезапуск при ошибках
- 2024-01-XX: Добавлен HTTP healthcheck endpoint
- 2024-01-XX: Улучшена обработка сигналов для graceful shutdown
- 2024-01-XX: Подготовка к деплою на Render

## Технические детали

- **Язык**: TypeScript
- **Runtime**: Bun (совместимо с Node.js)
- **API**: Binance Futures REST API (fapi)
- **Архитектура**: Single-file, без внешних зависимостей (кроме Bun/Node)
- **Retry логика**: Exponential backoff с jitter
- **Округление**: Автоматическое округление количества по LOT_SIZE фильтру

## Лицензия

Private project - не для публичного использования.
