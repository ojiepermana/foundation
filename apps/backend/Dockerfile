# Image backend Foundation (spec 0012): satu bundle bun build komposisi production. Bangun dari root monorepo:
# docker build -f apps/backend/Dockerfile -t <tag> .
# Konteks dibatasi apps/backend/Dockerfile.dockerignore (daftar izin). Image dasar dipin tag dan digest indeks multi
# arch, sama dengan bun.image di tests/performance/images.json. Tidak ada ARG, build secret, atau ENV credential;
# DATABASE_URL hanya masuk saat runtime lewat environment service.
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY apps/backend/src/ apps/backend/src/
COPY libs/server/ libs/server/
# Minify whitespace dan sintaks saja; nama identifier tetap, sesuai anjuran skill elysiajs.
RUN bun build apps/backend/src/index.ts --target bun --minify-whitespace --minify-syntax --outfile /out/backend.js

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
LABEL org.opencontainers.image.title="foundation-backend"
COPY --from=build /out/backend.js /app/backend.js
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8888
WORKDIR /app
USER 1000:1000
EXPOSE 8888
STOPSIGNAL SIGTERM
# Liveness lewat loopback container: keluar 0 hanya untuk 200, tanpa menyentuh database.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=10s \
  CMD ["bun", "--no-env-file", "-e", "fetch('http://127.0.0.1:8888/health/live', { signal: AbortSignal.timeout(2000) }).then((response) => process.exit(response.status === 200 ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "--no-env-file", "/app/backend.js"]
