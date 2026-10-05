# Image edge Foundation (spec 0012): build production Angular dilayani nginx yang mengakhiri TLS dan meneruskan /api/
# ke backend. Bangun dari root monorepo: docker build -f apps/frontend/Dockerfile -t <tag> .
# Konteks dibatasi apps/frontend/Dockerfile.dockerignore (daftar izin). Setiap image dasar dipin tag dan digest indeks
# multi arch; pin diperbarui lewat PR dengan docker buildx imagetools inspect. Tidak ada ARG, build secret, atau ENV
# credential; sertifikat dan key TLS hanya masuk saat runtime lewat secret file Compose.
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build
COPY --from=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/frontend/ apps/frontend/
RUN bun run build:frontend

FROM nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
LABEL org.opencontainers.image.title="foundation-frontend"
# Konfigurasi contoh image nginx tidak dipakai; edge hanya memakai file dari apps/frontend/edge/. Folder include dibuat
# 0755 lebih dulu, karena COPY --chmod ke folder yang belum ada memberi mode file itu juga pada folder nya.
RUN find /etc/nginx/conf.d /usr/share/nginx/html -mindepth 1 -delete && mkdir -m 0755 /etc/nginx/foundation
COPY --from=build /app/apps/frontend/dist/frontend/browser/ /srv/frontend/
COPY --chmod=0444 apps/frontend/edge/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0444 apps/frontend/edge/document-headers.conf apps/frontend/edge/api-headers.conf /etc/nginx/foundation/
COPY --chmod=0555 apps/frontend/edge/foundation-edge.sh /usr/local/bin/foundation-edge
ENV FOUNDATION_BACKEND_UPSTREAM=backend:8888
USER 101:101
EXPOSE 8080 8443
# SIGQUIT memicu graceful shutdown nginx; SIGTERM bawaan memicu fast shutdown.
STOPSIGNAL SIGQUIT
ENTRYPOINT ["/usr/local/bin/foundation-edge"]
