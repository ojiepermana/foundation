# Image runner database Foundation (spec 0012): provisioning, migration, dan seed sebagai job sekali jalan. Bangun dari
# root monorepo: docker build -f database/Dockerfile -t <tag> .
# Konteks dibatasi database/Dockerfile.dockerignore (daftar izin). Folder disalin utuh, sehingga file ignore yang rusak
# terlihat pada pemindaian image akhir. Image dasar dipin tag dan digest indeks multi arch, sama dengan bun.image di
# tests/performance/images.json. Tidak ada ARG, build secret, atau ENV credential; DSN hanya masuk saat runtime.
# Perintah bawaan menjalankan database/migrate.ts tanpa --apply, sehingga keluar 1 dengan "Use --apply".
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
LABEL org.opencontainers.image.title="foundation-migrate"
WORKDIR /app
COPY database/ /app/database/
COPY libs/server/database/ /app/libs/server/database/
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "--no-env-file"]
CMD ["database/migrate.ts"]
