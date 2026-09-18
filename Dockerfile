# syntax=docker/dockerfile:1

# ---- Dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as an unprivileged user.
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PORT=3000 \
    PREVIEW_PORT=3001 \
    STORAGE_DIR=/data/storage

# The archive lives on a volume; make it writable by the app user. Also prepare a
# writable fallback at the workdir so a relative STORAGE_DIR (e.g. "storage")
# still works instead of failing with EACCES.
RUN mkdir -p "$STORAGE_DIR" /app/storage && chown -R app:app /data /app/storage
USER app

# 3000 = app + API, 3001 = isolated preview origin (HTML with scripts)
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
