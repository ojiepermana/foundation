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

Aplikasi Angular/backend/worker, tooling OpenAPI/SDK, dan runner database belum diimplementasikan. Saat ini doctor melaporkan prasyarat tersebut sebagai error dan serve berhenti sebelum cleanup/startup. Perintah tidak membuat aplikasi atau data contoh secara otomatis.
