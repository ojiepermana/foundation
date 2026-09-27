# Foundation

Monorepo Angular, Bun/Elysia, dan worker dengan satu `package.json` root. Rules dan workflow agent berada di [AGENTS.md](AGENTS.md) serta `docs/rules/`.

Workflow development menggunakan [Engineering Workflow Skills dari JS Mastery](https://github.com/jsmastery-pro/skills), termasuk `/scope`, `/audit`, `/architect`, `/develop`, `/check`, `/test`, `/debug`, `/document`, dan `/sync`. Gunakan skill sesuai kebutuhan perubahan. [Workflow project](docs/rules/development-workflow.md) dan aturan dalam `AGENTS.md` melengkapi skill tersebut dengan keputusan khusus Foundation.

```sh
cp .env.infrastructure.example .env.infrastructure
# Isi password administrator lokal pada .env.infrastructure sebelum menjalankan Compose.
docker compose --env-file .env.infrastructure up -d --wait postgres
```

`docker-compose.yml` root hanya untuk infrastruktur pendukung, saat ini PostgreSQL 18. Setelah provisioning role/schema dan migration melalui langkah terpisah, jalankan aplikasi:

```sh
bun run doctor
bun run serve
bun run test:tooling
```

Frontend development menggunakan port **8889**, backend **8888**. Worker dipilih dengan `--worker <nama>` setelah didaftarkan di `config/development.json`.

Doctor memeriksa prasyarat tanpa mengubah database atau menghentikan proses. Serve menjalankan preflight, membersihkan listener pada port layanan terpilih, lalu menjalankan aplikasi. Lihat [aturan perintah development](docs/rules/development-commands.md).

Frontend, backend, dan worker dijalankan melalui Bun/Angular CLI; Compose tidak memuat runtime aplikasi. Credential Compose terpisah dari `.env` aplikasi. Lihat [aturan infrastruktur](docs/rules/infrastructure.md) untuk port, volume, healthcheck, dan batas provisioning.

## Kerangka aplikasi (spec 0001)

Gunakan Node 24.21.0 dan Bun 1.4.2 sesuai `.node-version` serta `.bun-version`.

```sh
bun install --frozen-lockfile
bun run api:sync
bun run test:ci
```

Frontend Angular 22.2.0 dan backend Elysia 1.4.30 sudah tersedia. Route `/api/status` hanya ada pada development. SDK standalone berasal dari `openapi.json`, memakai `@ojiepermana/angular` 22.1.14 dan tidak diedit manual.

Untuk pembuktian kerangka tanpa database sesuai spec 0001, jalankan `bun run dev:backend` dan `bun run dev:frontend` pada dua terminal. Perintah ini memakai port development yang sama. Workflow aplikasi lengkap tetap melalui `doctor` dan `serve` setelah PostgreSQL, role, schema, serta metadata migration tersedia. Runner database dan worker bisnis menunggu scope terkait.

`api:check` meregenerasi artefak dua kali dan gagal jika isi atau daftar file berubah. Build frontend mengompilasi SDK di luar `src/`. Laporan fitur mencatat bukti dan batasnya.
