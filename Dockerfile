# Используем официальный образ Bun
FROM oven/bun:1 AS base
WORKDIR /app

# Устанавливаем зависимости
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Копируем исходный код
FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY . .

# Открываем порт для healthcheck
EXPOSE 3000

# Запускаем приложение
CMD ["bun", "run", "index.ts"]
