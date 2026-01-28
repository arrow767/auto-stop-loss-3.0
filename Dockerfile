# Bun Alpine image for smaller size
FROM oven/bun:1-alpine
WORKDIR /app

# Copy and install deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY index.ts ./

# Run
CMD ["bun", "run", "index.ts"]
