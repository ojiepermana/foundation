# Verifikasi: build container dan deployment terpisah · spec 0012 · diperbarui 2026-10-06

_Langkah diturunkan dari acceptance criteria spec 0012 dan tabel Value sourcing. `/check verify` menjalankannya; `/test` mengunci langkah yang tahan lama. Bagian ini mencakup langkah 1 build plan (AC-1, AC-3, AC-4, dan sebagian AC-8): health dan readiness pada kedua komposisi beserta kontrak dan SDK, ketiga Dockerfile dengan konteks daftar izin, edge minimum, `deploy/compose.yaml`, serta orkestrasi dari salinan sampai readiness 503 lalu 200 dengan pembersihan pada setiap jalur keluar. Langkah 2 sampai 5 menambahkan bagiannya sendiri. Jalankan langkah Docker tanpa suite lain yang sedang berjalan, dan pastikan tidak ada container berlabel `foundation.test=deployment` sebelum mulai._

## Perintah: health dan readiness pada kedua komposisi (langkah 1)

- [x] Untuk `createApp('production')` dan `createApp('development')` tanpa pool, kirim request lewat `app.handle()` (misalnya script `bun --no-env-file` sementara di luar repository) → `GET /health/live` 200 `{"status":"live"}`; `GET /health/ready` 503 `{"status":"unavailable"}`; keduanya dengan `Cache-Control: no-store` → AC-4
- [x] Pada kedua komposisi: `HEAD /health/live` dan `GET /health/live/` → 404 `{"error":"Not found"}` dengan `no-store`; `POST /health/live` → 404 `{"error":"Not found"}`; `GET /health/live?x=1`, `Content-Length: 5`, dan `Transfer-Encoding: chunked` → 400 `{"error":"Invalid request"}` dengan `no-store`; sama untuk `/health/ready` → AC-4
- [x] Komposisi production: `GET /api/status`, `/api/readiness`, `/openapi`, `/openapi/json`, dan `/x` → 404 `{"error":"Not found"}`; komposisi development tetap menjawab `/api/status` 200 `{"status":"ok"}` dan `/openapi/json` 200 → AC-4
- [x] Jawaban health tidak memuat waktu, versi, jumlah, nama, atau pesan error: body hanya `{"status":"live"}`, `{"status":"ready"}`, atau `{"status":"unavailable"}` → AC-4
- [x] `createHealthReadiness` dengan probe palsu dan `deadlineMs` 100 (script sementara) → dua pemanggil sebelum batas berbagi satu probe; pemanggil sesudah batas saat probe belum selesai langsung `unavailable` tanpa probe baru; probe baru hanya sesudah probe lama selesai; probe `false`, ditolak, melempar sinkron, atau bukan boolean memberi `unavailable`; tanpa probe selalu `unavailable` (2026-10-05 saat build: sesuai; DEP-002 di langkah 3 mengunci perilaku ini) → AC-4
- [x] Baca `apps/backend/src/features/health/health.queries.ts` → satu transaksi `begin`, `SET LOCAL statement_timeout = '2s'`, lalu `SELECT EXISTS (SELECT 1 FROM common.schema_migrations WHERE name = ${name}) AS applied` dengan nama sebagai parameter tagged template, bukan teks SQL → AC-4
- [x] `bun run test:integration` → exit 0, 630 pass dan 0 fail (2026-10-05: 630 pass) → AC-4

## Perintah: kontrak OpenAPI dan SDK (langkah 1)

- [x] `bun run api:sync` → `OpenAPI exported without listener`, `OpenAPI project checks passed`, lalu generator mencetak `schemas=7, operations=4, tags=2`; `apps/frontend/sdk/services/health.service.ts` berisi `HealthService` dengan `getHealthLive()` dan `getHealthReady()` tanpa edit manual → AC-4
- [x] Baca `openapi.json` → `tags` tepat `development` lalu `health`; `/health/live` get dengan `operationId` `getHealthLive`, tag `health`, `security: []`, 200 `$ref` `HealthLive`, 400 dan 500 inline; `/health/ready` get dengan `getHealthReady`, 200 `HealthReady`, 400 dan 500 inline, serta 503 `HealthUnavailable`; ketiga model `additionalProperties: false` dengan satu `status` literal → AC-4
- [x] `bun run api:check` → `OpenAPI and SDK match stored artifacts across two runs`, exit 0 (2026-10-05: lulus) → AC-4
- [x] Salin `openapi.json` ke file sementara, hapus path `/health/live`, lalu `bun --no-env-file scripts/validate-openapi.ts <file>` → exit 1 dengan `rule: required-operation` (2026-10-05 saat build: sesuai) → AC-4
- [x] `bun run build:frontend`, `bun run check:frontend:bundle`, dan `bun run test:frontend` → exit 0; `test:frontend` 79 test lulus → AC-4

## Perintah: Dockerfile dan konteks daftar izin (langkah 1)

- [x] Dari root: `docker build -f apps/frontend/Dockerfile -t foundation-frontend:verify .`, `docker build -f apps/backend/Dockerfile -t foundation-backend:verify .`, dan `docker build -f database/Dockerfile -t foundation-migrate:verify .` → ketiganya exit 0; hapus ketiga tag sesudah langkah ini → AC-1
- [x] Baca ketiga Dockerfile → setiap `FROM` dan `COPY --from=<image>` berbentuk `<repo>:<tag>@sha256:<64 heksadesimal kecil>` sama dengan tabel *Image dasar*; referensi Bun sama dengan `bun.image` di `tests/performance/images.json`; tag Node `24.21.0-trixie-slim` sama dengan `engines.node`; tidak ada `ARG`, dan `ENV` stage akhir hanya `FOUNDATION_BACKEND_UPSTREAM` (edge) atau `NODE_ENV`, `HOST`, `PORT` (backend) → AC-1
- [x] Baca ketiga `<Dockerfile>.dockerignore` → baris aturan pertama `*`, lalu tepat baris `!` tabel *Daftar izin konteks build*, pengecualian tambahan `**/*.spec.ts` dan `**/*.test.ts` untuk frontend dan backend, lalu diakhiri `**/.env` dan `**/.env.*`; `.dockerignore` root berisi daftar tolak tabel → AC-1
- [x] `docker image inspect` ketiga tag verify → `Config.User` `101:101`, `1000:1000`, `1000:1000`; `Entrypoint` `["/usr/local/bin/foundation-edge"]`, `["bun","--no-env-file","/app/backend.js"]`, dan `["bun","--no-env-file"]` dengan `Cmd` `["database/migrate.ts"]`; `StopSignal` `SIGQUIT`, `SIGTERM`, `SIGTERM`; `Healthcheck` hanya pada backend (interval 10 s, timeout 5 s, retries 3, start period 10 s); port 8080 dan 8443 pada edge serta 8888 pada backend; tidak ada key `Config.Env` yang cocok `/(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE_URL)/i` → AC-1
- [x] `docker run --rm --entrypoint sh foundation-migrate:verify -c 'find /app'` → hanya `database/migrate.ts`, `provision.ts`, `runner.ts`, `seed.ts`, `database/migrations/*.sql`, dan `libs/server/database/client.ts`; `docker run --rm --entrypoint sh foundation-backend:verify -c 'find /app'` → hanya `/app/backend.js` → AC-1
- [x] `docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges foundation-migrate:verify` → exit 1 dengan stderr tepat `Use --apply` → AC-3
- [x] `grep -rnE '\bdocker (image )?(push|login|tag)\b' deploy/ .github/workflows/ README.md` → tidak ada baris (exit 1); `deploy/compose.yaml` tidak mempunyai key `build` dan merujuk image hanya lewat `${FOUNDATION_FRONTEND_IMAGE:?}`, `${FOUNDATION_BACKEND_IMAGE:?}`, `${FOUNDATION_MIGRATE_IMAGE:?}`, dan `${FOUNDATION_POSTGRES_IMAGE:-foundation-postgres:18-pinned}` → AC-1
- [x] `dockerArgs` dari `tests/orchestration/deployment-real.ts` (script sementara) → menolak `push`, `login`, `logout`, `tag`, `save`, `load`, `compose ... logs`, `build --push`, `build --output type=registry`, dan `compose build` untuk file selain `docker-compose.yml`; menerima subperintah daftar izin *Urutan orkestrasi* (2026-10-05 saat build: sesuai; DEP-001 di langkah 4 mengunci ini) → AC-1
- [x] Baca `apps/frontend/angular.json` → konfigurasi `production` memuat `optimization` tepat `{ "scripts": true, "styles": { "minify": true, "inlineCritical": false, "removeSpecialComments": true }, "fonts": { "inline": false } }`; `index.html` hasil `bun run build:frontend` tanpa `<script>` tanpa `src` dan tanpa `<style>` (disiapkan di langkah 1; dibuktikan lewat edge di langkah 2) → AC-6

## Perintah: topologi deploy/compose.yaml (langkah 1)

- [x] `docker compose -f deploy/compose.yaml config --no-interpolate --format json` → exit 0 tanpa env file; `name` `foundation-deploy`; service tepat `edge`, `backend`, `postgres`, dan `migrate` (`profiles: [migrate]`); network `public` biasa, `app` dan `data` dengan `internal: true`; hanya `edge` yang mempunyai `ports` → AC-8
- [x] Dari keluaran yang sama → nilai CPU, memory, PIDs, `shm_size`, read only, tmpfs, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, restart, stop grace, healthcheck PostgreSQL, `depends_on` `service_healthy`, `logging` `json-file` dengan `max-size` `10m` dan `max-file` `3`, network, dan secret `edge_tls_cert` serta `edge_tls_key` sama dengan tabel *Topologi* → AC-8
- [x] Dari keluaran yang sama → environment tepat: `edge` tidak ada; `backend` hanya `DATABASE_URL`; `postgres` hanya `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`; `migrate` hanya `FOUNDATION_MIGRATOR_DATABASE_URL` → AC-8
- [x] `git check-ignore --no-index -v .env.deploy` → cocok pola `.env.*`; `git check-ignore --no-index -q .env.deploy.example` → exit 1; `.env.deploy.example` hanya memuat nama variable tanpa nilai → AC-8
- [x] Baca `tests/integration/deployment/compose.test.yml` → setiap service hanya mendapat `restart: "no"`, `pull_policy: never`, dan label `foundation.test: deployment` serta `foundation.run: ${FOUNDATION_DEPLOY_RUN:?}` → AC-8

## Perintah: orkestrasi dari salinan sampai readiness 503 lalu 200 (langkah 1)

- [x] `bun run test:deployment:real` → konsol mencetak baris tetap: run `<hex>` dimulai, `check image_pins passed`, salinan siap, tiga baris menarik image dasar, tiga baris membangun image dengan tag `deploy-<hex>`, `postgres sehat`, `check provisioning_step passed`, `check readiness_before_migration passed`, `check migration_step passed`, `check readiness_after_migration passed`, edge menjawab `GET /` 200, lalu pembersihan; exit 1 karena 30 check lain masih `not_run` sampai langkah build plan berikutnya (2026-10-05: 99 detik, `6 check passed, 0 failed, 30 not_run`) → AC-1, AC-3, AC-4, AC-8
- [x] Baca `.local/feature-13/result.json` → `schema` 1, `status` `failed`, `candidate` dengan commit dan pohon sumber checkout, `checks` tepat urutan `DEPLOYMENT_CHECKS` dengan `image_pins`, `provisioning_step`, `readiness_before_migration`, `migration_step`, `readiness_after_migration`, dan `cleanup` `passed` serta sisanya `not_run`, `reasons` kosong, dan `boundary` teks tetap → AC-1, AC-3, AC-4
- [x] Selama run (antara baris `postgres sehat` dan baris pembersihan): `docker ps --filter label=foundation.run=<hex> --format '{{.Names}}'` → container milik project `foundation-deploy-<hex>`; `docker port` untuk container backend dan postgres → kosong; `docker port` untuk edge → hanya `127.0.0.1:<port acak>` ke 8443 dan 8080 → AC-8
- [x] Selama run: `docker inspect --format '{{json .Config.Env}}' <container backend>` → hanya `DATABASE_URL` yang ditambahkan di atas `Config.Env` image (nilai tidak perlu dicetak) → AC-8
- [x] Sesudah run: `docker ps -a`, `docker network ls`, `docker volume ls`, dan `docker images` tanpa nama atau tag yang memuat `<hex>`; tidak ada folder `foundation-deploy-<hex>-*` di `$TMPDIR` → AC-3, AC-8
- [x] Jalankan `bun --no-env-file tests/orchestration/deployment-real.ts` di latar belakang, lalu kirim SIGTERM sesudah `check readiness_before_migration passed`, SIGINT saat membangun image, dan SIGHUP sesudah `check readiness_after_migration passed` → exit 143, 130, dan 129; `result.json` beralasan `signal` dengan nama sinyal; `cleanup` `passed`; tidak ada container, network, volume, image, atau folder milik run (2026-10-05 saat build: ketiganya sesuai) → AC-3
- [x] `runDeployment` dengan `deadlineMs` 16000 lewat script sementara → exit 1, alasan `timeout` dengan langkah yang sedang berjalan, check sesudahnya `not_run`, `cleanup` `passed`, dan tidak ada resource milik run (2026-10-05 saat build: alasan `timeout backend`) → AC-3

## Perintah: sumber nilai (Value sourcing, langkah 1)

- [x] Base image dan digest: ubah satu digest Bun di salinan sementara `apps/backend/Dockerfile` lalu panggil `checkPins` → `pin_invalid` dengan detail Dockerfile itu; ubah `engines.node` → frontend ditolak → AC-1
- [x] Isi konteks: `buildInputs()` sama dengan gabungan path baris *Daftar izin konteks build* ditambah tiga Dockerfile dan file ignore nya; salinan run tidak memuat `.env`, `.env.*`, `node_modules`, `dist`, atau `.angular` dari checkout (pemindaian sentinel atas image dibangun di langkah 3) → AC-1, AC-2
- [x] Label revision dan pohon sumber: selama run, `docker image inspect --format '{{json .Config.Labels}}' foundation-backend:deploy-<hex>` → `org.opencontainers.image.revision` sama dengan `git rev-parse HEAD`, `foundation.source-tree` sama dengan `candidate.sourceTree` di `result.json`, `foundation.test=deployment`, dan `foundation.run=<hex>` → AC-1
- [x] Bundle backend dan file statis frontend: `/app/backend.js` satu file hasil `bun build`; `/srv/frontend/` berisi `index.html`, `main-*.js`, `styles-*.css`, dan `chunk-*.js` hasil build production → AC-1
- [x] Nama migration yang dibutuhkan: `REQUIRED_MIGRATION` di `apps/backend/src/features/health/health.queries.ts` sama dengan nama file terakhir `database/migrations/*.sql` (sekarang `0001-common-metadata-comment.sql`) → AC-4
- [x] Hasil `applied`: readiness 503 sesudah provisioning dan 200 sesudah `database/migrate.ts --apply` pada topologi run, lewat pool role `foundation_backend` (bukti pencabutan `SELECT` dan database beku dibangun di langkah 3, DEP-009) → AC-3, AC-4
- [x] Batas jawaban dan statement: `createHealthReadiness` memakai `READINESS_DEADLINE_MS` 5.000 ms dari spec 0006 sebagai default, dan query memakai `statement_timeout` 2 detik → AC-4
- [x] Upstream backend dan resolver: `docker compose ... exec edge cat /tmp/nginx/upstream.conf` selama run → `resolver 127.0.0.11 valid=10s ipv6=off;` dan `server backend:8888 resolve;`; `FOUNDATION_BACKEND_UPSTREAM` bernilai tidak sah membuat `foundation-edge` mencetak `Edge configuration invalid` dan keluar 1 tanpa nginx → AC-8
- [x] Sertifikat dan key TLS: `docker compose ... exec edge ls -l /run/secrets/` selama run → `edge_tls_cert` dan `edge_tls_key` terbaca UID 101; key di folder run bermode 0644 di dalam folder 0700 dan key CA dihapus sesudah sertifikat edge dibuat → AC-8
- [x] Credential per service dan port host: env file run bermode 0600 berisi password acak dan DSN dengan host `postgres:5432`; `FOUNDATION_EDGE_BIND` `127.0.0.1` dan dua port bebas; credential provisioning hanya ada di environment perintah `compose run` provisioning, tidak di env file → AC-3, AC-8

## Acceptance-criteria coverage (langkah 1)

- AC-1: Dockerfile dan konteks daftar izin (semua langkah), Value sourcing base image, isi konteks, label, dan bundle; `image_pins` di `result.json`.
- AC-3: perintah bawaan runner `Use --apply`, provisioning, migration, rerun, seed, readiness 503 lalu 200 tanpa restart backend, serta pembersihan pada sinyal dan batas total.
- AC-4: health dan readiness pada kedua komposisi, kontrak OpenAPI dan SDK, `REQUIRED_OPERATIONS`, readiness pada topologi run. Readiness pada PostgreSQL nyata dengan hak dicabut dan database beku (DEP-009), DEP-002, dan DEP-003 menyusul di langkah 3 dan 4.
- AC-8 sebagian: deklarasi `deploy/compose.yaml`, environment per service, port terpublikasi hanya edge, override uji. Probe keterjangkauan, egress, `docker inspect` hardening, dan check `compose_declaration` menyusul di langkah 3.
- AC-6 disiapkan: objek `optimization` production. Header, CSP, dan alur browser menyusul di langkah 2.

## Catatan sesudah langkah 1 (2026-10-05)

- Probe build plan langkah 1, dijalankan dengan topologi manual di folder scratch: (1) `server backend:8888 resolve` dengan resolver `127.0.0.11` dari `/etc/resolv.conf` mengikuti backend yang dibuat ulang dengan alamat baru dalam sekitar 10 detik tanpa restart edge (`502` selama jendela resolusi ulang, lalu `404` dari backend), sehingga AC-9 memakai varian utama dan cadangan keputusan 35 (b) tidak dipakai; (2) nginx sebagai UID 101 membaca key bermode 0644 di dalam folder 0700 lewat secret file Compose; (3) `compose run -e <NAMA>` tanpa nilai mengambil nilai dari environment perintah itu dan provisioning keluar 0. `bun install --frozen-lockfile --production` dan bundle `--minify-whitespace --minify-syntax` lulus pada build nyata.
- PostgreSQL dari `foundation-postgres:18-pinned` berjalan dengan `cap_drop: [ALL]` dan `no-new-privileges` pada volume baru.
- Satu run SIGINT saat fase build butuh 31 detik sampai keluar; empat run sinyal lain selesai dalam 1 detik atau kurang. Penyebabnya belum terisolasi; semua run berakhir tanpa resource tersisa dan di bawah masa tenggang 180 detik. DEP-008 di langkah 4 mengukur waktu pembersihan sesudah sinyal.
- Dengan `--no-interpolate`, Compose menampilkan `file` secret sebagai path project digabung dengan variable mentah (`<root>/deploy/${FOUNDATION_EDGE_TLS_CERT_FILE:?}`); check `compose_declaration` di langkah 3 perlu memperhitungkan bentuk ini.
- Base image Bun mewariskan label `org.opencontainers.image.revision` milik Bun; orkestrasi menimpanya lewat `docker build --label`, sesuai spec. Build manual operator tanpa label itu tetap membawa revision Bun.

## Perintah: edge TLS, redirect, header, cache, API, stub, dan browser (langkah 2)

_Langkah 2 build plan (AC-5, AC-6, AC-7). Langkah bertanda "selama run" memakai port HTTPS dari baris `edge menjawab GET / 200 lewat https://localhost:<port>/`, port HTTP dari env file run, dan CA run di `$TMPDIR/foundation-deploy-<hex>-*/tls/ca.pem`; jalankan di antara baris itu dan baris pembersihan, atau naikkan topologi sendiri dengan `deploy/compose.yaml` dan sertifikat dari CA sementara._

- [x] `bun run test:deployment:real` → selain baris langkah 1, konsol mencetak `check tls_versions passed`, `check http_redirect passed`, `check document_headers passed`, `check static_cache_fallback passed`, `check api_forwarding passed`, `check api_headers passed`, `check cors_absent passed`, `check edge_errors passed`, `check health_not_public passed`, `check api_stub_forwarding passed`, `deployment: menjalankan alur browser DEP-006 lewat edge`, dan `check browser_flow passed`; exit 1 karena 19 check lain masih `not_run` sampai langkah 3 dan 4 (2026-10-05: 48 detik, `17 check passed, 0 failed, 19 not_run`) → AC-5, AC-6, AC-7
- [x] Baca `.local/feature-13/result.json` → kesebelas check langkah 2 `passed`, `reasons` kosong; detail menyebut 12 request redirect, 25 jawaban dokumen, 4 aset dari `index.html`, 22 jawaban `/api/`, 13 bentuk traversal, dan 9 URL health → AC-5, AC-6, AC-7
- [x] Baca `.local/feature-13/playwright-deployment.xml` → dua testcase `DEP-006 edge at 1280×812: ...` dan `DEP-006 edge at 375×812: ...` tanpa failure dan tanpa skip; lampiran `requested-origins` hanya berisi `https://fonts.googleapis.com` (dan `https://fonts.gstatic.com` bila diminta) → AC-6
- [x] `FOUNDATION_DEPLOY_EDGE_URL` tidak di set, lalu `node node_modules/@playwright/test/cli.js test --config playwright.deployment.config.ts` → kedua test gagal dengan pesan tetap `DEP-006 needs FOUNDATION_DEPLOY_EDGE_URL, ...`, bukan skip (2026-10-05 saat build: sesuai) → AC-6
- [x] `bun run test:e2e` → 12 test lulus dan DEP-006 tidak ikut, karena `playwright.config.ts` mengabaikan `**/*.deployment.e2e.spec.ts` (2026-10-05: 12 passed) → AC-6

### TLS dan redirect (selama run)

- [x] `openssl s_client -connect 127.0.0.1:<port HTTPS> -servername localhost -CAfile <ca.pem> -verify_return_error -alpn h2 </dev/null` → `ALPN protocol: h2` dan `Verify return code: 0 (ok)` → AC-5
- [x] Baris yang sama dengan `-tls1_2` sebagai ganti `-alpn h2` → `New, TLSv1.2, Cipher is <cipher>` dengan cipher dari baris *Listener HTTPS*, dan tidak ada baris yang memuat `TLS session ticket` → AC-5
- [x] Baris yang sama dengan `-tls1_2 -cipher DEFAULT@SECLEVEL=0` → berhasil (kontrol positif); lalu `-tls1_1 -cipher DEFAULT@SECLEVEL=0` → exit 1 dengan `tlsv1 alert protocol version` (`SSL alert number 70`), bukan `no protocols available` → AC-5
- [x] `curl -sS -o /dev/null -D - -X <method> "http://localhost:<port HTTP>/api/status?returnUrl=%2Fhome"` untuk GET, POST, PUT, PATCH, DELETE, dan OPTIONS → 308 dengan `Location: https://localhost/api/status?returnUrl=%2Fhome` dan `Cache-Control: no-store` (keputusan 67, dibuktikan check `http_redirect` pada langkah 8), tanpa `Strict-Transport-Security`; baris log edge untuk request itu memuat `"status":308` dan `"upstreamStatus":""` → AC-5
- [x] `curl --cacert <ca.pem> -sS -o /dev/null -D - https://localhost:<port HTTPS>/` → `Strict-Transport-Security: max-age=31536000` dan setiap header tabel *Header dokumen* tepat satu kali, termasuk CSP final dengan `trusted-types angular angular#bundler angular#components` → AC-5, AC-6

### Header dokumen, cache, dan fallback (selama run)

- [x] `curl --cacert <ca.pem> -sS -D - https://localhost:<port>/kesiapan`, `/health/live`, `/api`, dan `/a.b/c` → 200 dengan body sama dengan `/index.html`, `Content-Type: text/html`, `Cache-Control: no-cache`, dan Header dokumen → AC-6
- [x] Untuk setiap `main-*.js`, `chunk-*.js`, dan `styles-*.css` yang dirujuk `index.html` → 200 dengan `Cache-Control: public, max-age=31536000, immutable`, `text/css` untuk CSS dan `application/javascript` untuk JS; `/main-ZZZZZZZZ.js` → 404 dengan `Cache-Control: no-cache` (keputusan 68; sebelum langkah 8 harapannya immutable), dan `If-None-Match` dengan ETag aset → 304 dengan Cache-Control immutable; `/missing-file.png` → 404 `no-cache`; `/favicon.ico` → 200 `no-cache`; `POST /` → 405; semuanya dengan Header dokumen → AC-6
- [x] Body `/index.html` lewat edge → tidak ada elemen `<script>` tanpa `src` dan tidak ada `<style>` → AC-6

### API, galat edge, CORS, dan health (selama run)

- [x] `curl --cacert <ca.pem> --path-as-is -sS -D - 'https://localhost:<port>/api/a%2fb'`, lalu setiap target `TRAVERSAL_TARGETS` di `tests/orchestration/deployment-real.ts` (termasuk `/api/a/../status`, `/api/%2E%2E/api/status`, `/api/a%5Cb`, dan `/api/a\b`) → 400 `{"error":"Invalid request"}`, `Content-Type: application/json`, `Cache-Control: no-store`, Header API; baris log edge untuk `X-Request-Id` jawaban itu memuat `"upstreamStatus":""` → AC-7
- [x] `https://localhost:<port>/api/x.json` dan `/api/status?returnUrl=%2Fhome` → 404 `{"error":"Not found"}` dari backend dengan Header API, tanpa `X-Frame-Options`, `Cross-Origin-Opener-Policy`, dan `Permissions-Policy`; baris log edge memuat `"upstreamStatus":"404"` → AC-7
- [x] POST body 1.025 byte ke `/api/status` → 413 `{"error":"Payload too large"}` JSON dengan `no-store` dan `"upstreamStatus":""` di log edge → AC-7
- [x] `curl --cacert <ca.pem> --http1.1 -sS -D - -H "X-Large: <9.000 karakter>" https://localhost:<port>/api/status` → 400 dengan Header dokumen (bukan Header API), `Server: nginx` tanpa versi, body bawaan nginx dengan `<center>nginx</center>`, dan tanpa `Access-Control-*` (dikoreksi keputusan 74: versi sebelumnya tanpa `--http1.1`; 2026-10-05 saat /debug: sesuai) → AC-7
- [x] Perintah yang sama tanpa `--http1.1` (curl memilih HTTP/2 lewat ALPN) → 404 JSON backend dengan Header API, bukan 400: pada HTTP/2 nginx membandingkan `large_client_header_buffers` (8k) dengan panjang field sesudah dikodekan HPACK, dan kode Huffman membuat 9.000 karakter `x` sekitar 7.875 byte. Dengan 12.000 karakter `x` (sekitar 10.500 byte sesudah dikodekan) nginx mengakhiri stream tanpa jawaban (curl exit 16), bentuk yang dibuktikan check `log_structure` dengan `status` 0 di log edge (keputusan 74; 2026-10-05 saat /debug: sesuai) → AC-7, AC-10
- [x] `OPTIONS /api/status` dan `OPTIONS /` dengan `Origin: https://foreign.example`, `Access-Control-Request-Method: POST`, dan `Access-Control-Request-Headers: content-type`, serta `GET /` dan `GET /api/status` dengan `Origin` itu → tidak ada header `Access-Control-*` → AC-7
- [x] `/health/live`, `/health/ready`, `//health/ready`, `/api/../health/live` (`--path-as-is`), dan `/api/health/live` → tidak ada body `{"status":"live"}`, `{"status":"ready"}`, atau `{"status":"unavailable"}`: path di luar `/api/` mendapat `index.html`, dan `/api/health/*` mendapat 404 backend → AC-4, AC-7

### Upstream stub, mutasi, dan sinyal

- [x] Detail `api_stub_forwarding` di `result.json` → stub menerima `host` `localhost`, tidak menerima satu pun header *Header alamat client*, menerima `x-request-id` yang sama dengan header jawaban dan berbeda dengan milik client; `/api/stub/hang` 504 JSON antara 9.500 dan 13.000 ms; body 1.025 byte 413 tanpa menambah hitungan stub, body 1.024 byte sampai utuh → AC-7
- [x] Selama check stub: `docker ps --filter label=foundation.run=<hex>` → `foundation-deploy-stub-<hex>` dan `foundation-deploy-edgestub-<hex>`; sesudah baris `check api_stub_forwarding passed` → keduanya sudah tidak ada → AC-7
- [x] Uji mutasi di working tree sementara, lalu kembalikan file nya: `ssl_session_tickets on`, `X-Frame-Options` `SAMEORIGIN`, Cache-Control aset ber hash `public, max-age=3600`, `X-Content-Type-Options` API tanpa `always`, baris map `"~*%5c" 1;` dihapus, dan `proxy_set_header X-Real-IP "";` dihapus → masing masing `tls_versions`, `document_headers`, `static_cache_fallback`, `api_headers` (juga 413 dan 504 di `api_stub_forwarding`), `edge_errors` (`/api/a%5cb` dan `/api/a%5Cb`), dan `api_stub_forwarding` (`stub menerima X-Real-IP`) gagal, sedangkan check lain tetap lulus (2026-10-05 saat build: keenam mutasi tertangkap) → AC-5, AC-6, AC-7
- [x] Jalankan `bun --no-env-file tests/orchestration/deployment-real.ts` di latar belakang dan kirim SIGTERM saat edge stub menunggu `/api/stub/hang` → exit 143, alasan `signal SIGTERM`, `cleanup` `passed`, dan tidak ada container, network (termasuk `foundation-deploy-<hex>_app`), volume, image, atau folder milik run (2026-10-05 saat build: sesuai, pembersihan sekitar 1 detik) → AC-7, AC-11

### File konfigurasi

- [x] Baca `apps/frontend/edge/document-headers.conf` → nilai CSP sama persis dengan `CONTENT_SECURITY_POLICY` di `tests/orchestration/deployment-real.ts` dan tabel *Header dokumen*; `api-headers.conf` sama dengan tabel *Header API*; setiap `add_header` memakai `always` → AC-6, AC-7
- [x] Baca `apps/frontend/edge/nginx.conf` → `include` header dokumen pada level `server` HTTPS dan pada setiap location non API; `location ^~ /api/` dengan `api-headers.conf`, `error_page 400 413 502 504` ke empat named location JSON (tidak ada `error_page` pada level `server`, keputusan 64) (`types { }` dan `default_type application/json`), `proxy_set_header Host $host`, `X-Request-Id $request_id`, `proxy_hide_header X-Request-Id`, dan `""` untuk ketiga belas header *Header alamat client*; map `$foundation_bad_path` hanya atas `$foundation_path`; tidak ada location regex yang berawalan `/api`; `location = /api` tepat melayani `index.html` → AC-6, AC-7
- [x] `docker run --rm --entrypoint sh <image edge> -c 'ls -ld /etc/nginx/foundation /etc/nginx/foundation/*'` → folder `0755` dan kedua file `0444`, sehingga UID 101 dapat membacanya → AC-6, AC-7

## Perintah: sumber nilai (Value sourcing, langkah 2)

- [x] Correlation ID: kirim `X-Request-Id: 0123456789abcdef0123456789abcdef` ke `/` dan ke `/api/status` lewat edge → header jawaban `X-Request-Id` 32 heksadesimal lain (`$request_id`); lewat edge stub, stub menerima ID edge itu, bukan milik client → AC-7
- [x] Tujuan redirect HTTP: `curl -sS -o /dev/null -D - -H 'Host: contoh.test:9999' "http://localhost:<port HTTP>/x?y=1"` → `Location: https://contoh.test/x?y=1`, yaitu `$host` tanpa port ditambah `$request_uri`; pantulan `Host` ini batasan yang dicatat untuk `docs/rules/deployment.md` (langkah 5) → AC-5
- [x] Nilai header, cache, dan batas: setiap nilai yang dibandingkan check langkah 2 berasal dari konstanta `DOCUMENT_HEADERS`, `API_HEADERS`, `CLIENT_ADDRESS_HEADERS`, `EDGE_ERROR_BODIES`, `IMMUTABLE_CACHE`, `HASHED_ASSET`, `TLS12_CIPHERS`, dan `BODY_LIMIT_BYTES` di orkestrasi, yang sama dengan tabel *Header dokumen*, *Header API*, *Header alamat client*, *Cache dan fallback*, dan *Konfigurasi edge*; ubah satu nilai di file edge saja → check yang membandingkannya gagal (lihat uji mutasi) → AC-5, AC-6, AC-7

## Acceptance-criteria coverage (langkah 2)

- AC-5: `tls_versions` (ALPN h2, TLS 1.2 tanpa session ticket dengan cipher daftar, kontrol positif TLS 1.2, TLS 1.1 ditolak server), `http_redirect` (308 untuk setiap method, `Location` tepat, tanpa HSTS, tanpa upstream), HSTS pada setiap jawaban HTTPS di `document_headers` dan `api_headers`, verifikasi dengan CA run lewat client Bun dan `openssl s_client -verify_return_error`.
- AC-6: `document_headers`, `static_cache_fallback`, `browser_flow` (DEP-006 pada dua viewport tanpa pelanggaran CSP, error console, page error, request `/api/`, atau origin lain), dan objek `optimization` dari langkah 1 yang terbukti lewat `index.html` tanpa script dan style inline.
- AC-7: `api_forwarding` (path berekstensi dan query sampai ke backend), `api_headers`, `api_stub_forwarding` (header alamat client, `X-Request-Id`, `Host`, 504 nyata, 413 dan 1.024 byte), `cors_absent`, `edge_errors` (traversal, 413, header besar), dan `health_not_public`. Sisa AC-7 di langkah berikutnya: 502 `{"error":"Bad gateway"}` lewat backend nyata yang dihentikan dibuktikan `backend_shutdown_restart` (langkah 3), dan bagian "baris log backend" pada `api_forwarding` ditambahkan saat log request backend dibangun (langkah 3).
- AC-4 sebagian: `health_not_public` membuktikan edge tidak meneruskan route health.

## Catatan sesudah langkah 2 (2026-10-05)

- Pembersihan kini menghapus container bernama milik run sebelum `compose down` (keputusan 47 di `rationale.md`): Compose 5.5.1 meninggalkan network `app` yang masih dipakai stub dan tetap keluar 0. DEP-008 (langkah 4) perlu mengunci urutan `rm -f`, lalu `compose down`, lalu `image rm`. Karena `compose down` keluar 0 walau network tertinggal, check `cleanup` belum membuktikan network benar benar hilang; langkah 4 dapat menambah `network inspect` sesudah `down` bila dianggap perlu.
- `location = /api` ditambahkan (keputusan 48): tanpa itu `/api` dijawab 301 ke port container dengan Header API.
- `COPY --chmod=0444` ke folder yang belum ada memberi mode 0444 juga pada folder itu, sehingga nginx sebagai UID 101 gagal membaca include (`Permission denied`); `apps/frontend/Dockerfile` kini membuat `/etc/nginx/foundation` dengan mode 0755 lebih dulu.
- Target traversal dan header 9.000 byte dikirim sebagai request HTTP/1.1 mentah lewat TLS dengan CA run, karena parser URL WHATWG di `fetch` menghapus segmen titik, `%2e`, dan mengubah `\` menjadi `/` sebelum request terkirim; request lain memakai `fetch` Bun dengan `tls: { ca }`.
- Check langkah 2 tidak menghentikan run saat gagal (berbeda dengan langkah deployment), sehingga satu run memperlihatkan setiap check edge yang gagal.
- Cache-Control immutable juga terkirim pada 404 nama aset ber hash yang tidak ada, karena tabel *Cache dan fallback* dan aturan `always` berlaku untuk baris itu; browser dapat menyimpan 404 itu setahun, risiko kecil karena nama ber hash berubah bersama isinya. Diubah sesudah code review (keputusan 68, langkah 8): 404 itu kini `no-cache`, karena rollback ke versi lama dapat membuat 404 yang tersimpan setahun merusak aplikasi bagi client itu.
- DEP-006 belum mempunyai baris pemilik runner: `scripts/lib/test-inventory.ts` hanya mengecualikannya dari `test:e2e`, dan baris pemilik `test:deployment:real` masuk bersama langkah tier di langkah 4 (aturan satu baris pemilik dan satu langkah tier pada commit yang sama). Sampai itu, `bun run check:test-discovery` gagal dengan satu `unowned_file` untuk `tests/e2e/deployment/edge.deployment.e2e.spec.ts`, dan `bun run test:gate` gagal pada satu test GATE-001 (`the repository inventory has no unowned file, ...`). Harapan tabel pemilik GATE-001 untuk exclude `test:e2e` sudah diperbarui.

## Perintah: isolasi dan operasi topologi (langkah 3)

_Langkah 3 build plan (AC-2, AC-4, AC-8, AC-9, AC-10): probe konteks dan pemindaian sentinel image, `checkFrontendBundle` atas file statis image, `compose config` tanpa override, inspect hardening, environment, dan network, probe keterjangkauan dengan kontrol `public`, shutdown, restart, recreate, dan outage, log JSON backend dan edge, flag log PostgreSQL, serta DEP-002, DEP-007, dan DEP-009. Langkah bertanda "selama run" memakai nama project dari baris `run <hex> dimulai`; jalankan tanpa suite Docker lain yang sedang berjalan._

- [x] `bun run test:deployment:real` → `36 check passed, 0 failed, 0 not_run`, lalu `deployment: passed` dan exit 0 (2026-10-05 saat build: 84 detik) → AC-2, AC-4, AC-8, AC-9, AC-10
- [x] Baca `.local/feature-13/result.json` → `status` `passed`, `reasons` kosong, dan kesembilan belas check langkah 3 `passed`: `image_context_sentinels`, `image_filesystem`, `image_config`, `published_ports`, `network_isolation`, `egress_blocked`, `compose_declaration`, `container_hardening`, `container_environment`, `backend_shutdown_restart`, `backend_recreate`, `database_outage`, `edge_shutdown`, `log_structure`, `log_correlation`, `log_no_data`, `postgres_log_policy`, `topology_shutdown`, dan `artifact_scan` → AC-2, AC-8, AC-9, AC-10
- [x] Sesudah run: `docker ps -a --filter label=foundation.test=deployment`, `docker network ls`, `docker volume ls`, dan `docker images` tanpa nama atau tag yang memuat `<hex>`, dan tidak ada folder `foundation-deploy-<hex>-*` di `$TMPDIR` (2026-10-05: sesuai pada run bersih, run mutasi, dan kedua run sinyal) → AC-8

### Image dan konteks build

- [x] Detail `image_context_sentinels` → tiga probe konteks sama dengan `expectedContext` (2026-10-05: 65 file), tanpa nama dasar `.env` dan tanpa nilai sentinel; salinan tanpa `.env`, `node_modules`, `dist`, dan `.angular` → AC-1, AC-2
- [x] Ubah sementara `database/Dockerfile.dockerignore` di salinan (misalnya hapus baris `**/.env`) dan jalankan `docker build -f .context-probe/3.Dockerfile --output type=local,dest=<folder> <salinan>` dengan file ignore hasil ubahan → `database/migrations/.env` ikut ke `context/`, sehingga daftar berbeda dengan `expectedContext` dan sentinel terbaca → AC-2
- [x] Detail `image_filesystem` → ketiga filesystem hasil `docker export` tanpa nilai sentinel, password, atau DSN run dan tanpa path `.env`; `/app` image backend hanya `backend.js`; `/app` image runner tepat file konteks runner; `/etc/nginx/conf.d/` dan `/usr/share/nginx/html/` edge kosong; `checkFrontendBundle` lulus atas `/srv/frontend/` hasil export → AC-1, AC-2
- [x] Detail `image_config` → `docker image inspect` dan `docker history --no-trunc` tanpa nilai sentinel; `USER` `101:101`, `1000:1000`, `1000:1000`; entrypoint, `STOPSIGNAL`, `HEALTHCHECK` backend, `ENV`, dan label sesuai tabel *Image*; `Config.Env` tanpa key yang cocok pola secret → AC-1, AC-2
- [x] Baca `.local/feature-13/images.json` → `schema` 1, tiga image dengan `name`, `dockerfile`, `tag`, `imageId`, `sizeBytes`, `user`, `exposedPorts`, `stopSignal`, `healthcheck`, `bases`, `labels`, dan `files` `{ count, sha256 }`, ditambah `postgres` `{ image, imageId }`; `exposedPorts` edge berisi `80/tcp` turunan nginx selain `8080/tcp` dan `8443/tcp` (keputusan 51) → AC-1, AC-2

### Deklarasi, inspect, dan port

- [x] `docker compose -f deploy/compose.yaml config --no-interpolate --format json` dari root tanpa override dan tanpa env file → tepat empat service dan tiga network, nilai credential tidak ada (hanya `${...}`), `json-file` 10m × 3 pada setiap service, perintah postgres dengan ketiga flag log; check `compose_declaration` `passed` → AC-8, AC-10
- [x] Selama run: `docker inspect <container backend>` → network `<project>_app` dan `<project>_data`, `Config.User` `1000:1000`, `NanoCpus` 1000000000, `Memory` 536870912, `PidsLimit` 256, `ReadonlyRootfs` true, `Tmpfs` `/tmp` `rw,nosuid,nodev,noexec,size=64m`, `CapDrop` `["ALL"]`, `SecurityOpt` `["no-new-privileges:true"]`, `RestartPolicy.Name` `no`, `StopTimeout` 10, healthcheck image, `LogConfig` `json-file` 10m × 3; serupa untuk edge, postgres, dan `foundation-deploy-migrate-<hex>` menurut tabel *Topologi* → AC-8
- [x] Selama run: selisih `Config.Env` container dengan image → edge tanpa key, backend hanya `DATABASE_URL`, postgres `POSTGRES_DB`, `POSTGRES_PASSWORD`, `POSTGRES_USER`, runner hanya `FOUNDATION_MIGRATOR_DATABASE_URL` (nilai tidak perlu dicetak) → AC-8
- [x] Selama run: `docker compose -p <project> ... port backend 8888` → stdout `invalid IP:0` dan exit 0 pada Compose 5.5.1 (binding kosong, keputusan 50), sama untuk `port postgres 5432`; `port edge 8443` → `127.0.0.1:<port HTTPS>`; `HostConfig.PortBindings` kosong untuk backend, postgres, dan runner → AC-8

### Keterjangkauan

- [x] Detail `network_isolation` → `Internal` `true` untuk `app` dan `data`, `false` untuk `public`; probe di `app` menjawab `/health/live` 200, tidak menjangkau `postgres:5432`; probe di `data` menjangkau `postgres:5432` → AC-8
- [x] Detail `egress_blocked` → kontrol `public` menjangkau `1.1.1.1:443` dan probe `app` serta `data` gagal dalam 3 detik; di mesin tanpa internet check ini `not_run` dengan alasan `egress_control_failed` dan langkah tidak `passed` → AC-8

### Operasi

- [x] Detail `backend_shutdown_restart` → stop backend di bawah 6.000 ms dengan exit 0 dan baris `stopped`, `/` tetap 200, `/api/status` 502 atau 504 JSON edge lalu hanya 502 sesudah 15.000 ms, dan 404 backend lagi dalam 20 detik sesudah start tanpa restart edge (2026-10-05: stop 227 ms, 24 jawaban, 0 kali 504, kembali 6.533 ms) → AC-7, AC-9
- [x] Detail `backend_recreate` → container backend baru diteruskan edge dalam 20 detik tanpa restart edge; detail menyebut apakah alamat `app` berubah (2026-10-05: alamat sama pada kedua run bersih, lihat catatan) → AC-9
- [x] Detail `database_outage` → `/health/ready` 503 dalam 6 detik sesudah stop postgres, `/health/live` 200 dan edge `/` 200, lalu 200 dalam 30 detik sesudah start tanpa restart backend (2026-10-05: 113 ms dan 114 ms) → AC-4, AC-9
- [x] Detail `edge_shutdown` dan `topology_shutdown` → stop edge (SIGQUIT) di bawah 15 detik dengan exit 0; `compose stop` seluruh service dengan exit 0 untuk edge, backend, dan postgres (2026-10-05: 308 ms dan 381 ms) → AC-9

### Log

- [x] Selama run: `docker logs <container edge>` → setiap baris stdout objek JSON dengan key tepat `time`, `requestId`, `method`, `path`, `status`, `bytes`, `requestTime`, `upstreamStatus`, `upstreamTime`, tanpa `?` di `path`; stderr kosong atau hanya level `crit` → AC-10
- [x] Selama run: `docker logs <container backend>` → stdout hanya baris `info` (`listening`, request), stderr hanya baris `error` (misalnya `/health/ready` 503 sebelum migration dan saat database berhenti, keputusan 49); tidak ada baris untuk `/health/live` 200 dan untuk body 2.048 byte yang ditolak Bun → AC-10
- [x] Detail `log_correlation` → header `X-Request-Id` jawaban sama dengan `requestId` baris edge dan baris backend untuk satu request, ID client tidak dipakai, dan request langsung dari network `app` dengan `X-Request-Id` yang bukan 32 heksadesimal mendapat ID buatan backend → AC-10
- [x] Detail `log_no_data` → nilai sentinel lewat query, `Authorization`, `Cookie`, header bebas, dan body (termasuk saat 502), tiga password, dan tiga DSN run tidak ada di stdout maupun stderr edge, backend (sebelum dan sesudah recreate), postgres, runner, dan keluaran run provisioning, migration, dan seed (2026-10-05: 43 nilai, 14 keluaran) → AC-10
- [x] Detail `postgres_log_policy` → perintah container postgres memuat ketiga flag, `SHOW` memberi `log`, `panic`, `terse`, dan statement `SELECT $s$<sentinel>$s$::integer` yang gagal tidak muncul di log postgres (bentuk statement sebelum keputusan 76; bentuk sekarang `SELECT $s$x<sentinel>$s$::integer` dibuktikan langkah 9) → AC-10
- [x] Baca `.local/feature-13/artifact-scan.json` → `findings` kosong, `filesScanned` memuat `images.json`, JUnit Playwright, dan file `test-results/`, `outputsScanned` memuat log kelima container → AC-2, AC-11

### Backend dan database (DEP-002, DEP-007, DEP-009)

- [x] `bun --no-env-file test ./tests/integration/backend/health.test.ts` → 12 pass (DEP-002: live tanpa menyentuh pool, ready 200 hanya untuk `true`, satu probe per instance, 503 langsung sesudah batas, probe baru hanya sesudah probe lama selesai, urutan penjaga, production 404) → AC-4
- [x] `bun run build:backend && bun --no-env-file test ./tests/integration/backend/logging.test.ts` → 11 pass (DEP-007: key tepat, `requestId`, method, path 200 karakter, health di bawah 500 tidak dicatat, 500 ke stderr, lifecycle JSON, proses `index.ts` dan bundle production, `startup_failed`, development tetap diam) → AC-10
- [x] `bun run test:database:real` → 37 pass, termasuk 8 test DEP-009 (503 sebelum migration, nama berkutip sebagai parameter, `statement_timeout` tidak bocor, 200 sesudah migration, 503 saat tabel hilang dan saat `SELECT` dicabut lalu 200, database beku 503 dalam 5.500 ms dengan satu panggilan query selama lebih dari 5.000 ms lalu 200 dalam 15 detik, jawaban tanpa data), dan pemindaian artefak bersih (2026-10-05: 55 detik) → AC-4
- [x] `bun --no-env-file test ./tests/integration/gate/signal-cleanup.test.ts` → 10 pass; GATE-009 kini memeriksa `tests/integration/database/health.test.ts` (impor modul pembersihan, pendaftaran sebelum `docker run`, dan SIGTERM yang menghapus containernya pada dua putaran) → AC-4
- [x] `bun run api:sync` → exit 0 dan `openapi.json` serta `apps/frontend/sdk/` byte identik dengan sebelum perubahan backend → AC-4

### Uji mutasi dan sinyal

- [x] Ubah sementara, dalam satu run, `pids_limit` edge, environment backend (tambah `FOUNDATION_MIGRATOR_DATABASE_URL`), `log_format` edge (tambah `query`), `ENV` backend (tambah `API_TOKEN`), dan `requestIdOf` (percaya semua header), lalu kembalikan → `image_config`, `compose_declaration`, `container_hardening`, `container_environment`, `log_structure`, `log_correlation`, `log_no_data`, dan `artifact_scan` gagal (2026-10-05: 28 passed, 8 failed, file dikembalikan byte identik) → AC-1, AC-2, AC-8, AC-10
- [x] Kirim SIGTERM 3 detik sesudah `check browser_flow passed` → exit 143 dalam 1 detik, check operasi dan log `not_run`, `cleanup` `passed`, tanpa resource tersisa; kirim SIGINT saat pemindaian image (container scan `foundation-deploy-probe-<hex>-<n>` ada) → exit 130, container itu terhapus → AC-11

## Perintah: sumber nilai (Value sourcing, langkah 3)

- [x] `requestId` backend: request lewat edge membawa ID edge; request langsung dengan header 32 heksadesimal memakai header itu, header lain (huruf besar, panjang berbeda, dua header) mendapat `crypto.randomUUID()` tanpa tanda hubung (DEP-007 dan `log_correlation`) → AC-10
- [x] `time` dan `durationMs` backend: `time` ISO dengan `Z` dan `durationMs` bilangan bulat dari selisih `performance.now()` antara `onRequest` dan `onAfterResponse` (DEP-007) → AC-10
- [x] Correlation ID edge: `$request_id` 32 heksadesimal sama di header jawaban, log edge, dan log backend (`log_correlation`) → AC-10
- [x] Hasil `applied` dan batas readiness: pool nyata role `foundation_backend` memberi 200 hanya sesudah migration dan 503 saat tabel hilang, hak dicabut, database berhenti, atau beku; `SET LOCAL statement_timeout = '2s'` tidak mengubah `SHOW statement_timeout` koneksi pool (DEP-009, `database_outage`) → AC-4
- [x] Resource, hardening, dan network Compose: setiap nilai yang dibandingkan berasal dari konstanta `DECLARATION`, `RUNTIME`, dan `SERVICE_ENVIRONMENT` di orkestrasi, yang sama dengan tabel *Topologi* dan *Environment per service*; ubah satu nilai di `deploy/compose.yaml` saja → `compose_declaration` dan `container_hardening` gagal (uji mutasi) → AC-8
- [x] Retensi log: `docker inspect` setiap container menunjukkan `json-file` dengan `max-size` 10m dan `max-file` 3; retensi platform 30 hari ditulis di `docs/rules/deployment.md` pada langkah 5 → AC-10

## Acceptance-criteria coverage (langkah 3)

- AC-2: `image_context_sentinels`, `image_filesystem` (export, sentinel, `.env`, `checkFrontendBundle`), `image_config` (inspect dan history), `artifact_scan`, dan `images.json`.
- AC-4: DEP-002, DEP-009 pada PostgreSQL 18 nyata (tabel hilang, `SELECT` dicabut, parameter, `statement_timeout`, database beku), `database_outage`, dan readiness langkah 1. DEP-003 (test kesesuaian SDK) ada di langkah 4.
- AC-8: `compose_declaration`, `container_hardening`, `container_environment`, `published_ports`, `network_isolation`, dan `egress_blocked` dengan kontrol `public`.
- AC-9: `backend_shutdown_restart` (varian utama, tanpa restart edge), `backend_recreate`, `database_outage`, `edge_shutdown`, dan `topology_shutdown`.
- AC-10: plugin log backend dan lifecycle JSON (DEP-007), `log_structure`, `log_correlation`, `log_no_data`, `postgres_log_policy`, dan logging `json-file` di `compose_declaration` dan `container_hardening`. Retensi 30 hari dan risiko sisa pesan `crit` ditulis di `docs/rules/deployment.md` pada langkah 5.
- AC-7 sisa langkah 2: 502 lewat backend nyata dibuktikan `backend_shutdown_restart`, dan baris log backend kini bagian dari `api_forwarding`.

## Catatan sesudah langkah 3 (2026-10-05)

- Run bersih terakhir: 36 dari 36 check `passed`, 84 detik, tanpa resource tersisa. Run pertama gagal hanya pada `published_ports`, karena Compose 5.5.1 menjawab port yang di `EXPOSE` tetapi tidak dipublikasikan dengan `invalid IP:0`; check kini menerima bentuk itu sebagai binding kosong dan tetap menuntut `PortBindings` kosong (keputusan 50).
- Pada kedua run bersih Docker memberi backend yang dibuat ulang alamat `app` yang sama, sehingga `backend_recreate` lulus tanpa membuktikan resolusi ke alamat baru pada run itu; resolusi ke alamat baru dibuktikan probe langkah 1. Detail check kini menyebut apakah alamat berubah.
- Jendela resolusi ulang tidak memperlihatkan 504 pada run ini (24 jawaban, semua 502); cabang 504 tetap diterima sesuai AC-9.
- Baris request backend berlevel `error` ditulis ke stderr menurut AC-10, berbeda dengan kolom *Stream* tabel *Log backend production* (keputusan 49); `/health/ready` 503 karena itu muncul di stderr backend.
- DEP-009 memakai variable nama container READY-008 dan GATE-009 diperluas ke file itu (keputusan 52). Registry DEP-002, DEP-007, dan DEP-009 di `tests/scenarios/deployment.json` dibuat pada langkah 4; judul test sudah diawali tag ID nya.
- Batas yang belum dibuktikan langkah ini: `test:deployment:real` belum menjadi langkah tier (langkah 4), dan `check:test-discovery` serta satu test GATE-001 tetap gagal karena baris pemilik DEP-006 masuk bersama langkah tier di langkah 4.

## Perintah: integrasi gate (langkah 4)

### Langkah tier, pemilik runner, dan registry

- [x] `bun run test:deployment:plan` → 31 pass dalam sekitar 12 detik (21 test DEP-001 dan 10 test DEP-008) dan JUnit `.local/feature-13/plan.xml`, tanpa menyentuh `.local/feature-13/result.json` milik run nyata → AC-11
- [x] `bun run check:test-discovery` → lulus dengan baris `playwright playwright.deployment.config.ts 1 file (test:deployment:real)`; tidak ada lagi `unowned_file` untuk `tests/e2e/deployment/edge.deployment.e2e.spec.ts` → AC-11
- [x] `bun run test:scenarios` → lulus dengan 85 ID unik dan 121 check; `tests/scenarios/deployment.json` memuat DEP-001 sampai DEP-009, DEP-006 `critical`, dan setiap kriteria sesuai daftar *Critical test scenarios* → AC-11
- [x] `bun run test:gate` → 259 pass, termasuk GATE-001 (dua baris pemilik baru dan file inventaris tanpa pemilik nol), GATE-002 (lima alur kritis dengan DEP-006), GATE-004 (`test:deployment:plan` sesudah `test:performance:plan`), GATE-005 (key `deployment` sesudah `performance` dan `outOfScope` baru), GATE-008 (tujuh langkah, smoke tetap terakhir), PERF-008 yang disesuaikan, dan 6 test DEP-004 → AC-11
- [x] `git status --short .github/workflows/` → kosong, dan `bun run check:workflow` lulus: kedua file workflow tidak berubah → AC-11
- [x] `bun run test:ci` → 19 dari 19 langkah passed, `test:deployment:plan` di antara `test:performance:plan` dan `test:e2e` (2026-10-05: exit 0) → AC-11
- [x] `bun run test:ci:real` → 7 dari 7 langkah passed; `test:deployment:real` sesudah `test:readiness:real` dan sebelum `test:performance:smoke`, dengan `result.json` (jenis `deployment`), `images.json`, `playwright-deployment.xml`, dan `artifact-scan.json` di bundle `real` (2026-10-05: langkah deployment 97,3 detik, 36 check passed) → AC-1 sampai AC-11 (DEP-005)
- [x] `bun run test:ci:security && bun run test:report` → gate `passed`, 80 skenario `passed`, alur kritis APP-002, DEP-006, READY-006, READY-009, dan UI-001 `passed`, baris `deployment: passed (36 dari 36 check passed)`, dan kandidat release `bukan` karena working tree belum masuk commit → AC-11

### Jenis bukti `deployment` dan laporan

- [x] `bun --no-env-file test ./tests/integration/gate/release.test.ts` → 6 pass: check yang hilang, berlebih, berulang, tertukar, atau berstatus lain ditolak; langkah yang keluar 0 dengan `result.json` `failed` gagal `evidence_invalid`; exit 1 hanya `exit_code` → AC-11
- [x] Buka `.local/feature-11/report.json` → tiga key terakhir `outOfScope`, `performance`, `deployment`; `outOfScope` hanya `capacity_profiles` fitur 12; `deployment.images` berisi frontend, backend, dan migrate dengan `revision` dan `sourceTree` sama dengan `candidate` laporan → AC-11
- [x] Buka `.local/feature-11/report.md` → bagian *Deployment* sesudah *Performance k6* memuat tabel image, tabel check dengan kolom *Kriteria* dari `DEPLOYMENT_CHECKS`, teks `boundary`, dan kalimat bahwa image dibangun lokal, tidak didorong ke registry, dan bukan izin deploy → AC-11
- [x] Ubah satu byte `.local/feature-11/evidence/real/.local/feature-13/result.json` lalu jalankan `bun run test:report` → pengikatan `evidence_hash_differs` dan `deployment` `null` dengan kalimat bukti tidak tersedia (DEP-004 membuktikan hal yang sama pada fixture) → AC-11

### DEP-003 dan DEP-008

- [x] `bun --no-env-file test ./tests/integration/contract/openapi-contract.test.ts ./tests/integration/contract/readiness-contract.test.ts -t DEP-003` → 4 pass: operasi health sesuai tabel *Kontrak OpenAPI*, ekspor development sama dengan `openapi.json`, empat `REQUIRED_OPERATIONS`, mutasi operasi health ditolak `required-operation`, dan `HealthService` di SDK → AC-4
- [x] `bun run test:frontend` → 81 pass, termasuk dua test DEP-003: `getHealthLive()` 200 `{"status":"live"}` dan `getHealthReady()` 503 `{"status":"unavailable"}` dengan `Cache-Control: no-store` terhadap harness backend spec 0009 → AC-4
- [x] `bun run api:check` → lulus (langkah tier cepat) → AC-4
- [x] `bun --no-env-file test ./tests/integration/deployment/signal.test.ts` → 10 pass: SIGTERM, SIGINT, dan SIGHUP saat stub mulai menghasilkan satu `rm -f` dengan container runner dan stub, `compose down --volumes --remove-orphans --timeout 30`, dan satu `image rm` ketiga tag, tanpa signal dan dengan batas 15.000, 90.000, dan 30.000 ms; batas total saat `compose up --wait backend` memberi `timeout` dan check `not_run`; `main` sebagai grup proses dengan `docker` dan `openssl` palsu keluar 143, 130, dan 129 dari `compose up --wait edge` serta 143 dari `compose up --wait postgres`; folder `mkdtemp` terhapus dan password run tidak tercetak → AC-11

### Uji mutasi

- [x] Ubah sementara satu per satu lalu kembalikan byte identik: CSP tanpa Trusted Types, location regex untuk `/api`, `$remote_addr` di log edge, `X-Real-IP` tidak dikosongkan, file ignore tanpa `**/.env.*`, `pids_limit` backend, `USER nginx`, `inlineCritical: true`, `client_max_body_size 2k`, baris `docker push` di `deploy/`, `add_header` tanpa `always`, `dockerArgs` yang menerima `tag`, `compose down` sebelum `rm -f`, `compose down` yang dapat dibatalkan, folder run yang tidak dihapus, exit SIGHUP lain, urutan check yang tidak diperiksa, aturan exit 0 yang hilang, urutan image yang tidak diperiksa, dan kolom kriteria yang hilang → setiap mutasi menggagalkan paling sedikit satu test DEP-001, DEP-004, atau DEP-008 (2026-10-05: 20 dari 20 tertangkap; exit SIGHUP lain awalnya lolos karena test membaca kode exit dari orkestrasi, lalu test diubah memakai nilai tertulis AC-11) → AC-1, AC-6, AC-7, AC-8, AC-10, AC-11

## Perintah: sumber nilai (Value sourcing, langkah 4)

- [x] Field `deployment`: hanya dari `result.json` dan `images.json` langkah `test:deployment:real` di bundle `real` yang SHA 256 nya cocok manifest; file yang hilang, berubah sesudah run, atau tidak berbentuk sah (tiga image dalam urutan *Image*, keputusan 55) membuat seluruh field `null` → AC-11
- [x] Kolom *Kriteria*: dari `DEPLOYMENT_CHECKS` di `scripts/lib/gate.ts`, sama dengan tabel *Check deployment* (DEP-001); teks `boundary` disalin dari `result.json` (keputusan 53) → AC-11
- [x] Label `revision` dan `sourceTree` image di laporan: `gitCommit()` dan `sourceTree()` checkout saat run nyata, sama dengan `candidate` laporan pada run 2026-10-05 → AC-11

## Acceptance-criteria coverage (langkah 4)

- AC-4: DEP-003 (kontrak, ekspor, `REQUIRED_OPERATIONS`, SDK, dan `HealthService` terhadap harness) dan registry DEP-002, DEP-009.
- AC-11: langkah `test:deployment:plan` dan `test:deployment:real` di tabel tier, jenis bukti `deployment` dengan `deploymentEvidenceValid`, pemilik runner dan config Playwright, registry DEP-001 sampai DEP-009, field `deployment` dan bagian *Deployment* dengan kolom kriteria, `outOfScope` baru, DEP-001, DEP-004 bagian langkah 4, dan DEP-008.
- AC-1, AC-2, AC-6, AC-7, AC-8, AC-10: bagian statis DEP-001 (Dockerfile, file ignore, pin, `deploy/compose.yaml`, konfigurasi edge, log, `optimization`, larangan baris push) dan check DEP-005 yang kini berjalan sebagai langkah tier.
- AC-12: hanya larangan baris push di DEP-001; status release dan string wajib dokumen menunggu langkah 5.

## Catatan sesudah langkah 4 (2026-10-05)

- Gate lokal lengkap: tier cepat 19 dari 19, tier nyata 7 dari 7, tier keamanan 1 dari 1, dan `test:report` `passed` dengan 80 skenario. Kandidat release `bukan` karena working tree belum masuk commit; run itu terjadi sebelum kotak scope dan catatan ini ditulis, sehingga laporan ulang atas bundle itu kini mendapat `source_tree_differs`. Bukti gate akhir dikumpulkan langkah 5.
- `deployment` membawa key kelima `boundary` (keputusan 53), sehingga bentuknya berbeda dengan baris *Laporan per push* di `index.md` yang perlu disesuaikan `/architect`.
- String wajib tabel *Dokumen yang diperbarui* belum masuk DEP-001 dan ditambahkan bersama dokumennya di langkah 5 (keputusan 54).
- Penolakan project asing dibuktikan pada fungsi penjaga `projectAccepted` (DEP-001 dan DEP-008), karena project selalu diturunkan dari id run; DEP-008 juga menegaskan bahwa setiap `-p` pada run memakai project run itu.

## Perintah: status release dan dokumen (langkah 5)

_Langkah 5 build plan (AC-12, dan seluruh AC lewat gate): parameter `reportCi`, `bundleCi`, `test:report:release` dengan kode alasan dan `release.json` serta `release.md`, DEP-004 bagian status release, `docs/rules/deployment.md`, pembaruan aturan testing, keamanan, infrastruktur, Elysia, README, dan template laporan release, lalu gate lokal lengkap. Jalankan gate tanpa suite lain yang sedang berjalan._

### Status release pada fixture (DEP-004)

- [x] `bun --no-env-file test ./tests/integration/gate/release.test.ts` → 14 pass: tiga bundle per push dari run `push` 1000 dan bundle kapasitas dari run `workflow_dispatch` 2000, keduanya pada `refs/heads/main` untuk HEAD fixture, memberi `ready`, exit 0, `release.json` dengan key tepat `schema`, `generatedAt`, `candidate`, `perPush`, `capacity`, `deployment`, `status`, `reasons`, `grantsDeployment`, dan hanya dua file baru di `.local/` → AC-12
- [x] Di test yang sama: variable `GITHUB_*` milik run lain pada proses laporan tidak mengubah hasil; `buildReport` dan `buildCapacityReport` tanpa parameter ketiga tetap membaca identitas proses (`ci_identity_differs` atau `ci_mixed`) → AC-12
- [x] Di test yang sama: bundle run lokal tanpa identitas CI → `incomplete` dengan tepat `gate_not_candidate` dan `capacity_not_candidate`, exit 1 → AC-12
- [x] Di test yang sama: bundle per push dari commit lain → `gate_incomplete`, `gate_not_candidate`, `candidate_differs`; identitas CI berbeda antar tier per push → `gate_incomplete`; bundle kapasitas berevent `push` → `capacity_not_candidate`; image berlabel revision atau pohon sumber lain, label `null`, atau `images.json` tidak sah → `image_differs` → AC-12
- [x] Di test yang sama: gate per push `failed` → `blocked` dengan `gate_failed`; laporan kapasitas `failed` → `blocked` dengan `capacity_failed`; urutan kode tetap tabel *Status kesiapan release*; `grantsDeployment` `false` dan kedua kalimat tetap `release.md` ada pada status `ready`, `incomplete`, dan `blocked` → AC-12
- [x] Di test yang sama: `scripts/gate-report.ts release` di workspace tanpa bundle keluar 1 dengan `Status release incomplete` dan hanya menulis `.local/feature-13/release.json` serta `release.md`; argumen lain mencetak `Pemakaian: bun --no-env-file scripts/gate-report.ts [capacity|release]` → AC-12

### Status release pada bundle lokal

- [x] Sesudah `bun run test:ci`, `bun run test:ci:real`, dan `bun run test:ci:security` pada working tree ini, jalankan `bun run test:report` → gate `passed` dengan kandidat release `bukan` (`not_clean` dan `not_ci`) → AC-1 sampai AC-11 lewat gate
- [x] Lalu `bun run test:report:release` → exit 1, `Status release incomplete`, alasan memuat `gate_not_candidate` dan `capacity_not_candidate` (bundle kapasitas yang tidak ada atau berasal dari commit lain menambah `capacity_incomplete`, dan yang berasal dari commit lain juga `candidate_differs`), tanpa `image_differs` karena label image run ini sama dengan checkout, `perPush.ci` dan `capacity.ci` `null`, `grantsDeployment` `false`, dan `.local/feature-11/report.json` serta `.local/feature-12/report.json` tidak berubah waktu tulisnya → AC-12
- [x] Buka `.local/feature-13/release.md` → bagian *Status*, *Alasan*, *Kandidat*, *Run per push*, *Run kapasitas*, dan *Image*; kalimat "Status `ready` berarti bukti wajib lengkap ..." dan "Identitas run dibaca dari manifest bundle ..." ada apa adanya; tabel image menyebut `ya` pada kolom *Sama dengan checkout* untuk ketiga image dari run ini → AC-12
- [x] Ubah salinan `.local/feature-11/evidence/real/.local/feature-13/images.json` satu byte lalu jalankan `bun run test:report:release` → `deployment` `null`, `evidence_hash_differs` membuat gate `incomplete`, dan alasan memuat `gate_incomplete` serta `image_differs` → AC-12

### Dokumen

- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts` → 22 pass, termasuk string wajib tabel *Dokumen yang diperbarui* untuk ketujuh file, `docs/rules/deployment.md` wajib ada, dan tidak ada baris yang cocok `/\bdocker (image )?(push|login|tag)\b/` di `deploy/`, `.github/workflows/`, `README.md`, maupun `docs/rules/deployment.md` → AC-1, AC-12
- [x] Baca `docs/rules/deployment.md` → langkah build, `postgres`, provisioning sekali, backend, readiness, migration, dan edge berurutan; prosedur status release dengan checkout bersih, keempat `gh run download` ke folder bundle (`capacity-evidence` ke `.local`), `bun install --frozen-lockfile`, dan `bun run test:report:release`; retensi 30 hari dan rotasi `json-file`; kebijakan endpoint production; rotasi password dengan `ALTER ROLE`; pembaruan sertifikat dengan `--force-recreate --no-deps edge`; key pemilik root, grup GID 101, mode 0640; asumsi port 443 dan 80 serta pantulan `Host`; risiko sisa pesan `crit` nginx; batas pemindaian paket OS; dan pembaruan pin dengan `docker buildx imagetools inspect` → AC-5, AC-10, AC-12
- [x] Ikuti langkah deployment `docs/rules/deployment.md` sekali secara manual dengan `.env.deploy` sementara dan sertifikat buatan sendiri di satu host Docker → setiap perintah keluar 0, readiness 503 sebelum migration lalu 200, `https://localhost/` 200; hapus project dan volumenya sesudahnya → AC-3, AC-12
- [x] `git diff --stat -- .github/workflows` kosong dan `bun run check:workflow` lulus → AC-11, AC-12

### Gate lokal lengkap

- [x] `bun run test:ci` → 19 dari 19 langkah passed, termasuk `test:deployment:plan` sesudah `test:performance:plan` → AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12 (DEP-001, DEP-008)
- [x] `bun run test:ci:real` → 7 dari 7 langkah passed, `test:deployment:real` dengan 36 check `passed` → AC-1 sampai AC-11 (DEP-005, DEP-006, DEP-009)
- [x] `bun run test:ci:security` → gitleaks, `bun audit`, dan actionlint lulus → AC-11
- [x] `bun run test:report` → gate `passed` dengan seluruh skenario `passed` dan baris `deployment: passed (36 dari 36 check passed)` → AC-11

## Perintah: sumber nilai (Value sourcing, langkah 5)

- [x] Status release dari perhitungan ulang laporan: jalankan `bun run test:report:release` dua kali pada bundle yang sama → `perPush.gate` dan `capacity.status` sama dengan hasil `buildReport` dan `buildCapacityReport` atas bundle itu; ganti satu manifest per push dengan manifest dari run lain → `gate_incomplete` (DEP-004) → AC-12
- [x] Identitas CI per laporan dari `bundleCi`: jalankan `GITHUB_RUN_ID=9999 GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/1/merge GITHUB_SHA=$(git rev-parse HEAD) bun run test:report:release` → `release.json` sama dengan run tanpa variable itu kecuali `generatedAt` (DEP-004 membuktikan hal yang sama pada fixture) → AC-12
- [x] Commit dan pohon sumber kandidat dari checkout: ubah satu file yang dilacak Git tanpa menyentuh bundle lalu jalankan `bun run test:report:release` → `candidate.sourceTree` berubah, gate `incomplete` karena `source_tree_differs`, dan alasan memuat `candidate_differs` serta `image_differs`; kembalikan file itu → AC-12
- [x] `grantsDeployment`: konstanta `false` pada setiap status, juga pada `ready` fixture DEP-004 → AC-12
- [x] Retensi log: `docs/rules/deployment.md` menulis 30 hari dan rotasi `max-size` 10m × 3 yang sama dengan `deploy/compose.yaml` (DEP-001 membandingkan Compose dengan tabel *Topologi*) → AC-10

## Acceptance-criteria coverage (langkah 5)

- AC-12: `runReleaseReport`, `bundleCi`, parameter `reportCi`, kode `REASON_CODES.releaseReadiness`, `release.json` dan `release.md`, `grantsDeployment`, exit code, dan CLI `release` (DEP-004 bagian langkah 5); dokumen dan string wajib (DEP-001); prosedur unduh artifact di `docs/rules/deployment.md`; workflow tidak berubah.
- AC-1 sampai AC-11: dibuktikan ulang lewat gate lokal lengkap (`test:ci`, `test:ci:real`, `test:ci:security`, `test:report`) pada working tree akhir; DEP-001 kini juga mewajibkan `docs/rules/deployment.md`.
- AC-5 dan AC-10: asumsi port 443, risiko sisa pesan `crit`, dan retensi 30 hari kini tertulis di `docs/rules/deployment.md`.

## Catatan sesudah langkah 5 (2026-10-05)

- `perPush.releaseCandidate` dan `capacity.releaseCandidate` di `release.json` adalah salinan utuh objek `{ value, reasons }` laporan masing masing, sehingga alasan kandidat (misalnya `not_ci` per tier) terlihat tanpa membuka laporan lain (keputusan 56).
- Label image `null`, atau checkout tanpa commit atau pohon sumber, selalu memberi `image_differs`, sesuai keputusan 55 dan AC-12 ("tidak berlabel commit dan pohon sumber itu").
- Teks pemakaian `scripts/gate-report.ts` kini `[capacity|release]`, sehingga harapan PERF-008 untuk argumen yang tidak dikenal ikut diganti tanpa melemahkan pemeriksaannya.
- `test:report:release` atas bundle lokal selalu `incomplete` karena bundle lokal bukan run CI; status `ready` hanya dapat dibuktikan pada fixture DEP-004 atau dengan artifact CI nyata sesudah push dan run `capacity.yml` untuk commit yang sama.
- Hasil aktual gate lokal langkah ini dicatat di laporan build, bukan di file ini, agar bundle bukti tetap terikat pada pohon sumber yang sama.

## Perintah: penyelarasan sesudah verify (langkah 6)

_Langkah 6 build plan (AC-7, AC-9, AC-10, keputusan 60 sampai 63): kriteria DEP-007 di registry, check `health_not_public` yang diperketat, `/api/../../x` pada check `edge_errors`, dan test regresi jalur `connectionTimeout` DEP-007. Langkah bertanda "selama run" memakai port HTTPS, CA run, dan nama project seperti langkah 2; jalankan tanpa suite Docker lain yang sedang berjalan._

### Registry DEP-007

- [x] Baca `tests/scenarios/deployment.json` → DEP-007 berkriteria tepat `["AC-9", "AC-10"]`, sama dengan butir 7 *Critical test scenarios* → AC-9, AC-10
- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "scenario registry"` → 1 pass: kriteria setiap DEP di registry sama dengan tanda tebal sesudah kata "Membuktikan" pada butir *Critical test scenarios* (dengan "sampai" sebagai rentang), dan hanya DEP-006 yang `critical` → AC-9, AC-11
- [x] Ubah sementara kriteria DEP-007 kembali ke `["AC-10"]`, jalankan test yang sama, lalu kembalikan → test gagal pada key `DEP-007` (2026-10-05: tertangkap; `bun run test:scenarios` sendiri tetap lulus karena tidak membandingkan dengan butir spec) → AC-9
- [x] `bun run test:scenarios` → `Scenario registries passed (85 unique IDs, 121 checks)` (2026-10-05: sesuai) → AC-11

### Check `health_not_public` yang diperketat

- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "health_not_public"` → 1 pass: `HEALTH_DOCUMENT_TARGETS` tepat tujuh target paragraf *Check deployment*, `HEALTH_API_TARGETS` tepat `/api/health/live` dan `/api/health/ready`, tidak satu pun ada di `TRAVERSAL_TARGETS`, dan `healthNotPublicProblems` menolak 404, halaman lain, `upstreamStatus` `404` atau tidak ada di log, header dokumen yang hilang, `Access-Control-*`, body health, jawaban `/api/health` selain 404 JSON, dan 404 tanpa upstream → AC-4, AC-7
- [x] `bun run test:deployment:real` → `check health_not_public passed` dengan detail `7 target di luar /api/ index.html 200 dengan Header dokumen tanpa upstream; 2 target /api/health 404 JSON backend dengan Header API` (2026-10-05: dua run bersih, 36 dari 36 check passed, 86 dan 88 detik) → AC-4, AC-7
- [x] Selama run: `curl --cacert <ca.pem> --path-as-is -sS -D - 'https://localhost:<port>/api/x/..%2f..%2fhealth/live'`, lalu setiap target `HEALTH_DOCUMENT_TARGETS` (`/health/live`, `/health/ready`, `/health/live/`, `//health/ready`, `/api/../health/live`, `/api/%2e%2e/health/ready`) → 200 dengan body sama dengan `/index.html`, `Content-Type: text/html`, setiap header *Header dokumen* tepat satu kali, dan baris log edge untuk `X-Request-Id` jawaban itu memuat `"upstreamStatus":""` → AC-4, AC-7
- [x] Selama run: `curl --cacert <ca.pem> -sS -D - https://localhost:<port>/api/health/live` dan `/api/health/ready` → 404 `{"error":"Not found"}` JSON dengan *Header API* tanpa `X-Frame-Options`, `Cross-Origin-Opener-Policy`, dan `Permissions-Policy`; baris log edge memuat `"upstreamStatus":"404"` dan log backend memuat baris request dengan ID yang sama → AC-4, AC-7

### `/api/../../x` pada check `edge_errors`

- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "default nginx 400"` → 1 pass: `ABOVE_ROOT_TARGETS` tepat `/api/../../x`, dan `nginxDefault400Problems` menolak jawaban selain 400, galat JSON edge dengan *Header API*, versi nginx di body atau header `Server`, `Access-Control-*`, `upstreamStatus` tidak kosong, dan baris log yang hilang → AC-7
- [x] `bun run test:deployment:real` → `check edge_errors passed` dengan detail yang menyebut `header 9000 byte dan /api/../../x 400 bawaan nginx dengan Header dokumen` (2026-10-05: sesuai pada dua run bersih) → AC-7
- [x] Selama run: `curl --cacert <ca.pem> --path-as-is -sS -D - 'https://localhost:<port>/api/../../x'` (HTTP/2 lewat ALPN), lalu perintah yang sama dengan `--http1.1` → keduanya 400 dengan body bawaan nginx yang memuat `<center>nginx</center>` tanpa versi, `Server: nginx`, *Header dokumen* (bukan *Header API*), tanpa `Access-Control-*`; baris log edge yang `requestId` nya sama dengan header `X-Request-Id` jawaban memuat `"status":400`, `"path":""`, dan `"upstreamStatus":""`, karena nginx menolak path di atas root sebelum `$request_uri` terisi (dikoreksi pembaruan spec ketiga, keputusan 66; versi sebelumnya menuntut `"path":"/api/../../x"`) → AC-7, AC-10

### Uji mutasi edge

- [x] Salin `apps/frontend/edge/nginx.conf` ke folder sementara, tambahkan pada level `server` HTTPS `error_page 400 @api_bad_request;` dan `location ^~ /health/ { include /etc/nginx/foundation/document-headers.conf; return 404; }`, jalankan `bun run test:deployment:real`, lalu kembalikan file nya byte identik (`cmp`) → `health_not_public` gagal untuk ketujuh target di luar `/api/` (check lama meloloskan mutasi ini karena hanya menolak body health), `edge_errors` gagal dengan `/api/../../x 500, diharapkan 400` sementara header 9.000 byte tetap lulus, dan `static_cache_fallback` gagal untuk `/health/live`; tidak ada resource run tersisa (2026-10-05: `33 check passed, 3 failed, 0 not_run`). Jawaban 500 berasal dari redirect ke named location saat request belum mempunyai URI (error log `empty URI in redirect to named location`), dan header 9.000 byte tetap 400 bawaan karena nginx mencatatnya dengan status internal 494 yang tidak cocok `error_page 400` (keputusan 64) → AC-4, AC-7

### Regresi jalur `connectionTimeout` (DEP-007)

- [x] `bun run build:backend && bun --no-env-file test ./tests/integration/backend/logging.test.ts -t "connection timeout"` → 1 pass dalam sekitar 3 detik: proses `index.ts` production dengan `DATABASE_URL` ke alamat yang koneksi TCP nya tidak pernah selesai (macOS `127.0.0.2`; Linux listener di proses anak yang dihentikan SIGSTOP dengan antrean accept penuh) menjawab `/health/ready` 503 sesudah paling sedikit 2.900 ms, lalu SIGTERM memberi `listening` dan `stopped` di stdout, satu baris request `error` di stderr, exit 0 dalam 6 detik, dan tidak ada password atau host DSN di kedua stream (2026-10-05 di macOS: sesuai) → AC-9, AC-10
- [x] Salin `apps/backend/src/index.ts` ke folder sementara, jadikan baris `process.exit(0);` sesudah `stopped` komentar, jalankan test yang sama, lalu kembalikan file nya byte identik → test gagal dengan `Expected: 0` dan `Received: "still running"` (2026-10-05 di macOS: tertangkap; cabang Linux dibuktikan langkah berikut sebelum push dan job `application` sesudah push) → AC-9
- [x] `bun --no-env-file test ./tests/integration/backend/logging.test.ts` → 12 pass (2026-10-05: sesuai) → AC-9, AC-10

### Cabang Linux DEP-007 sebelum push (keputusan 65)

_Cabang Linux fixture `pendingConnectTarget()` (listener proses anak yang dihentikan SIGSTOP dengan antrean accept penuh) dijalankan di image Bun yang dipin pada mesin container lokal. Hanya path yang dibutuhkan yang di mount, semuanya baca saja, sehingga file `.env` tidak masuk container dan working tree tidak berubah. Langkah ini memakai `node_modules` hasil `bun install --frozen-lockfile` di host. Run ini bukan bukti runner GitHub; laporan menulisnya sebagai cabang Linux di container lokal._

- [x] Dari root checkout: `docker run --rm --name foundation-verify-dep007-<hex> -v "$PWD/package.json:/repo/package.json:ro" -v "$PWD/apps/backend:/repo/apps/backend:ro" -v "$PWD/libs:/repo/libs:ro" -v "$PWD/node_modules:/repo/node_modules:ro" -v "$PWD/tests/integration/backend:/repo/tests/integration/backend:ro" -w /repo oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 bun --no-env-file test ./tests/integration/backend/logging.test.ts -t "connection timeout"` → exit 0, `1 pass`, `0 fail`, testcase sekitar 3,4 detik, sehingga readiness memang menunggu batas koneksi 3 detik (2026-10-05, kernel `Linux 7.0.12-linuxkit`, Bun 1.4.2, `net.core.somaxconn` 4096: sesuai, 3.433 ms dan 3.430 ms) → AC-9
- [x] Uji mutasi tanpa menyentuh working tree: tulis salinan `apps/backend/src/index.ts` ke folder sementara dengan baris `process.exit(0);` dijadikan komentar, lalu jalankan perintah yang sama dengan tambahan `-v <salinan>:/repo/apps/backend/src/index.ts:ro` sesudah mount `apps/backend` → exit 1, test gagal dengan `Expected: 0` dan `Received: "still running"`; `grep -n 'process.exit(0);' apps/backend/src/index.ts` sesudahnya tetap menunjukkan satu baris tanpa `//` (2026-10-05: tertangkap) → AC-9
- [x] `docker ps -a --filter name=foundation-verify-dep007` sesudah kedua run → kosong → AC-9

### Cabang Linux DEP-007 di runner sesudah push (keputusan 65)

- [ ] Sesudah push, unduh artifact `application-evidence` run push commit itu (`gh run download <run push> -n application-evidence -D <folder sementara>`) → `<folder>/.local/feature-4/server.xml` memuat testcase `DEP-007 a production process whose readiness check ran into the database connection timeout still writes stopped and exits 0 on SIGTERM` tanpa elemen `failure` atau `skipped`, dari job `application` di runner `ubuntu-24.04` (belum ada sebelum push; bila gagal padahal langkah container lulus, jalankan `/debug`) → AC-9

### Jalankan ulang

- [x] `bun run test:deployment:plan` → 36 pass (26 test DEP-001 dan 10 test DEP-008) (2026-10-05: sesuai) → AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12
- [x] `bun run test:integration` → 658 pass dan 0 fail (2026-10-05: sesuai) → AC-4, AC-9, AC-10
- [x] `bun run check:test-discovery` → lulus dengan baris `playwright playwright.deployment.config.ts 1 file (test:deployment:real)` (2026-10-05: sesuai) → AC-11
- [x] `bun run test:gate` → 267 pass (2026-10-05: sesuai) → AC-11, AC-12
- [x] `bun run test:deployment:real` → `36 check passed, 0 failed, 0 not_run`, `deployment: passed`, exit 0, tanpa container, network, volume, image, atau folder milik run sesudahnya (2026-10-05: sesuai) → AC-1 sampai AC-11

## Acceptance-criteria coverage (langkah 6)

- AC-4: `health_not_public` kini menuntut `index.html` 200 untuk setiap target di luar `/api/` dan 404 JSON backend untuk `/api/health/*`, sehingga tidak ada URL lewat edge yang sampai ke route `/health/` backend.
- AC-7: `health_not_public` (Header dokumen dan `upstreamStatus` kosong untuk path yang dinormalisasi ke luar `/api/`, Header API dan `upstreamStatus` `404` untuk `/api/health/*`) dan `edge_errors` (`/api/../../x` dengan 400 bawaan nginx, Header dokumen, `Server: nginx` tanpa versi, tanpa upstream), dikunci DEP-001 lewat `healthNotPublicProblems` dan `nginxDefault400Problems`, dan dibuktikan uji mutasi edge.
- AC-9: kalimat di luar topologi dibuktikan test regresi DEP-007 dan uji mutasi `process.exit(0)` pada kedua cabang fixture: macOS di host, Linux di image Bun yang dipin sebelum push, dan Linux di runner `ubuntu-24.04` lewat job `application` sesudah push (keputusan 65); registry kini mencatat DEP-007 untuk AC-9, dan DEP-001 menjaga registry tetap sama dengan butir *Critical test scenarios*.
- AC-10: DEP-007 (12 pass) dan baris log edge untuk `/api/../../x`.

## Catatan sesudah langkah 6 (2026-10-05)

- Dengan `error_page 400 @api_bad_request;` pada level `server`, nginx 1.30.5 menjawab `/api/../../x` dengan 500, bukan galat JSON, sedangkan header 9.000 byte tetap mendapat 400 bawaan. Pengamatan ini tidak mengubah pilihan (a) keputusan 62, tetapi kalimat opsi (b) di `rationale.md` yang menyebut galat itu berubah menjadi JSON dengan *Header API* tidak cocok dengan hasil mutasi ini dan dapat diperbaiki `/architect`.
- Komentar `apps/frontend/edge/nginx.conf` untuk include header dokumen pada level `server` kini menyebut path yang naik di atas root, sesuai AC-7. Perilaku edge tidak berubah.
- Bukti 2.900 ms DEP-007 hanya dijalankan di macOS pada sesi ini; cabang Linux (listener yang dihentikan SIGSTOP) dijalankan runner CI sesudah push.
- Pembaruan spec kedua (`/architect`, 2026-10-05): keputusan 64 mengoreksi kalimat opsi (b) keputusan 62 di `rationale.md` dengan probe nginx 1.30.5 (500 karena `empty URI in redirect to named location`, dan status internal 494 untuk header besar), dan baris *API* *Konfigurasi edge* kini menulis bahwa `error_page` hanya berada di dalam `location ^~ /api/`. Keputusan 65 menambah langkah cabang Linux DEP-007 di image Bun yang dipin sebelum push, dengan uji mutasinya, serta langkah bukti runner sesudah push. Probe `/architect` menjalankan langkah container itu dua kali (lulus dalam 3.433 ms dan 3.430 ms) dan uji mutasinya satu kali (mutasi `process.exit(0)` tertangkap); `/check verify` tetap menjalankan langkah ini sendiri. Kode, gate, dan workflow tidak berubah.
- Pembaruan spec ketiga (`/architect`, 2026-10-05): verify menemukan baris log edge `/api/../../x` dengan `"path":""`, bukan `"path":"/api/../../x"`. Keputusan 66 mencatat probe nginx 1.30.5 (`$request_uri` belum terisi saat nginx menolak path di atas root atau request line yang tidak sah, dan pada HTTP/2 `$request` juga kosong), mengoreksi langkah curl di atas menjadi `"path":""` untuk HTTP/2 dan `--http1.1`, mempersempit kalimat log pada keputusan 62, dan menolak cadangan dari `$request`. Langkah 7 di bawah mengunci baris itu pada check `edge_errors`.

## Perintah: baris log edge untuk path di atas root (langkah 7)

_Langkah 7 build plan (AC-7, AC-10, keputusan 66): check `edge_errors` menilai baris log edge `/api/../../x`, kriteria check itu menjadi AC-7 dan AC-10, dan `docs/rules/deployment.md` menjelaskan baris tanpa `path`. Konfigurasi edge tidak berubah. Langkah bertanda "selama run" memakai port HTTPS, CA run, dan nama project seperti langkah 2; jalankan tanpa suite Docker lain yang sedang berjalan._

### Penilaian baris log

- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "default nginx 400"` → 1 pass: `nginxDefault400Problems` untuk `/api/../../x` menerima baris log dengan `status` 400 serta `path` dan `upstreamStatus` kosong, dan menolak baris yang hilang, `status` selain 400 (misalnya 200), `path` yang tidak kosong (misalnya `/api/../../x`, bentuk cadangan `$request` yang ditolak keputusan 66), dan `upstreamStatus` yang tidak kosong; header 9.000 byte tetap dinilai dari jawaban saja → AC-7, AC-10
- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "DEPLOYMENT_CHECKS"` → 1 pass: `edge_errors` berkriteria tepat `["AC-7", "AC-10"]`, sama dengan tabel *Check deployment*, dan check lain tidak berubah → AC-10, AC-11
- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "traversal map"` → 1 pass: daftar map tetap `$request_uri $foundation_path`, `$foundation_path $foundation_bad_path`, dan `$status $foundation_status`, sehingga `path` hanya berasal dari `$request_uri` → AC-10

### Uji mutasi cadangan `$request`

- [x] Salin `apps/frontend/edge/nginx.conf` ke folder sementara, tambahkan sesudah map `$request_uri $foundation_path` sebuah `map $request $foundation_request_path { "~^[A-Z]+ (?<rp>[^? ]*)" $rp; }` dan ganti `"path":"$foundation_path"` pada `log_format` dengan `"path":"$foundation_request_path"`, jalankan `bun --no-env-file test ./tests/integration/deployment/static.test.ts`, lalu kembalikan file nya byte identik (`cmp`) → test DEP-001 gagal pada daftar map dan pada `log_format` yang tidak lagi sama persis, sehingga cadangan `$request` tertangkap di tier cepat sebelum tier nyata → AC-10

### Tier nyata

- [x] `bun run test:deployment:real` → `check edge_errors passed` dengan detail yang memuat `header 9000 byte dan /api/../../x 400 bawaan nginx dengan Header dokumen` dan diakhiri `; baris log edge /api/../../x 400 dengan path dan upstreamStatus kosong`; `36 check passed, 0 failed, 0 not_run`, `deployment: passed`, exit 0, tanpa resource run tersisa → AC-7, AC-10, AC-11
- [x] Baca `deploymentCriteria` di `scripts/lib/gate-report.ts` (fungsi kolom kriteria bagian *Deployment*) → kolom itu diambil dari `DEPLOYMENT_CHECKS`, sehingga baris `edge_errors` di `report.md` menampilkan `AC-7, AC-10` tanpa perubahan kode laporan; `result.json` tidak menyimpan kriteria → AC-10, AC-11
- [x] Selama run: langkah curl `/api/../../x` HTTP/2 dan `--http1.1` pada langkah 6 → kedua baris log edge memuat `"status":400`, `"path":""`, dan `"upstreamStatus":""` → AC-7, AC-10

### Dokumen

- [x] Baca bagian *Log dan retensi* `docs/rules/deployment.md` → ada kalimat bahwa request yang ditolak nginx sebelum URI nya selesai diurai (path di atas root atau request line yang tidak sah) tercatat dengan `status` 400 dan `requestId` tetapi `path` kosong, `method` dapat kosong, dan operator mencarinya lewat `requestId` dari header `X-Request-Id` jawaban → AC-10

### Jalankan ulang

- [x] `bun run test:deployment:plan` → lulus tanpa fail; jumlah test sama dengan langkah 6 bila tidak ada test baru, atau bertambah sebanyak test baru yang dicatat laporan build → AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12
- [x] `bun run test:gate` → lulus tanpa fail → AC-11, AC-12
- [x] `bun run check:test-discovery` → lulus → AC-11

## Acceptance-criteria coverage (langkah 7)

- AC-7: `edge_errors` tetap menuntut 400 bawaan nginx dengan *Header dokumen* untuk `/api/../../x`, kini bersama baris log nya.
- AC-10: kalimat baru AC-10 (baris ada dengan `status` 400, `path` dan `upstreamStatus` kosong) dibuktikan check `edge_errors` untuk HTTP/1.1 per push dan langkah curl HTTP/2 serta `--http1.1`; cadangan `$request` yang ditolak keputusan 66 tertangkap DEP-001 lewat uji mutasi.

## Perintah: perbaikan sesudah code review (langkah 8)

_Langkah 8 build plan (AC-5, AC-6, AC-8, AC-10, AC-11, keputusan 67 sampai 73): redirect HTTP dengan `Cache-Control: no-store`, 404 aset ber hash `no-cache` dengan 304 tetap immutable, tmpfs edge `noexec`, timer batas total sesudah folder bukti siap, sinyal yang dibaca lagi sesudah pemindaian bukti, kasus DEP-008 dan DEP-007 baru, serta dokumen operator. Dijalankan agent pada 2026-10-05._

### Reproduksi sebelum perbaikan

- [x] `bun --no-env-file test ./tests/integration/deployment/signal.test.ts` dengan test baru dan orkestrasi lama → 2 fail: `main` dengan `.local` berupa file masih berjalan sesudah 15 detik (timer 1.200.000 ms aktif), dan SIGTERM sesudah `result.json` ditulis memberi exit 1, bukan 143; kasus pembersihan gagal, kegagalan sebelum topologi, cabang kontrol egress, dan sinyal selama pembersihan lulus pada kode lama (celah cakupan) → AC-11, AC-8
- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts` dengan harapan baru dan konfigurasi lama → gagal pada tmpfs edge, redirect tanpa `add_header`, map `$foundation_asset_cache`, dan baris aset ber hash → AC-5, AC-6, AC-8
- [x] Uji mutasi DEP-007: `onAfterResponse` yang tidak menemukan entri awal (salinan `request-log.ts` diubah sementara, lalu dikembalikan byte identik dengan `cmp`) → hanya dua test baru yang gagal (`durationMs` dan satu ID per request), 15 test lain tetap lulus → AC-10

### Sesudah perbaikan

- [x] `bun run test:deployment:plan` → 50 pass, 0 fail → AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12
- [x] `bun run test:integration` → 668 pass, 0 fail (termasuk dua test DEP-007 baru) → AC-4, AC-10
- [x] `bun run test:gate`, `bun run test:scenarios`, `bun run check:test-discovery`, `bun run typecheck:tooling`, `bun run typecheck:contract`, dan `bun run typecheck:backend` → lulus; registry mencatat DEP-008 `["AC-8", "AC-11"]` → AC-8, AC-11
- [x] `nginx -t` dengan image nginx 1.30.5 alpine yang dipin atas `apps/frontend/edge/` yang diubah → `syntax is ok` → AC-5, AC-6
- [x] `bun run test:deployment:real` → `36 check passed, 0 failed, 0 not_run`; detail `http_redirect` memuat `dengan Cache-Control no-store`, detail `static_cache_fallback` memuat `aset ber hash immutable termasuk 304, 404 aset ber hash dan file berekstensi lain no-cache`, dan `container_hardening` lulus dengan tmpfs edge `rw,nosuid,nodev,noexec,size=16m`; tidak ada container atau image berlabel `foundation.test=deployment` tersisa → AC-5, AC-6, AC-8
- [x] Uji mutasi tier nyata: `nginx.conf` tanpa `add_header` 8080 dan dengan Cache-Control immutable tetap untuk aset ber hash, serta `deploy/compose.yaml` tanpa `noexec` pada edge, lalu kedua file dikembalikan byte identik (`cmp`) → `32 check passed, 4 failed`: `compose_declaration` (`edge: tmpfs`), `container_hardening` (`edge: Tmpfs`), `http_redirect` (setiap request `tanpa Cache-Control no-store`), dan `static_cache_fallback` (`/main-ZZZZZZZZ.js 404, diharapkan 404 no-cache`) → AC-5, AC-6, AC-8

### Probe readiness pada koneksi setengah terbuka (keputusan 70)

- [x] Network Docker tersendiri dengan `foundation-postgres:18-pinned` dan client `oven/bun:1.4.2-slim` yang dipin (`Bun.SQL` `max: 1`, `connectionTimeout: 3`); sesudah `SELECT 1` berhasil, `docker network disconnect` atas container database, lalu transaksi berbentuk `migrationApplied` → dengan `--sysctl net.ipv4.tcp_retries2=4` gagal `ERR_POSTGRES_CONNECTION_CLOSED` sesudah 13.415 ms; dengan nilai bawaan 15 masih tertunda pada 950.503 ms dan gagal dengan galat yang sama sesudah 959.432 ms; container dan network probe dihapus sesudahnya → AC-4

### Dokumen

- [x] `docker compose config` dengan env file berisi `ab$cd1234` dan `x${HOME}y` → `ab` dengan peringatan `variable is not set` dan path host; `new URL` menolak DSN dengan `#` atau `/` pada password tanpa encoding → aturan nilai `.env.deploy` di bagian *Topologi* `docs/rules/deployment.md` dan `.env.deploy.example`
- [x] Baca `docs/rules/deployment.md` → bagian *Topologi* memuat aturan nilai env file dan risiko password admin di `.env.deploy` (keputusan 71); bagian *Memantau* menyatakan `/health/*` lewat edge bukan sinyal, probe luar `GET /`, readiness hanya dari jaringan internal dengan GET, edge tanpa healthcheck, dan batas pemulihan readiness; bagian TLS memuat `Cache-Control: no-store` pada 308, `Host` yang tidak dipercaya (keputusan 72), key di luar checkout, dan pemeriksaan GID 101; `docs/rules/security.md` memuat kalimat `Host`; `.gitignore` menolak `*.key`, `*.pem`, dan `*.crt` (`git check-ignore`) → AC-5, AC-8, AC-10

## Acceptance-criteria coverage (langkah 8)

- AC-5: `http_redirect` kini juga menuntut `Cache-Control: no-store` pada setiap 308.
- AC-6: `static_cache_fallback` menuntut 404 aset ber hash `no-cache` dan 304 immutable.
- AC-8: tmpfs edge `noexec` dibuktikan `compose_declaration`, `container_hardening`, dan DEP-001; cabang `egress_control_failed` kini dibuktikan DEP-008.
- AC-10: DEP-007 menangkap entri awal request yang hilang lewat `durationMs` dan satu ID per request.
- AC-11: DEP-008 mencakup langkah pembersihan yang gagal, alasan sebelum topologi, sinyal selama pembersihan dan sesudah `result.json`, serta folder bukti yang tidak dapat disiapkan.

## Perintah: penyelarasan sesudah verify kedua (langkah 9)

_Langkah 9 build plan (AC-7, AC-10, keputusan 74 sampai 76): konfigurasi edge, Dockerfile, gate, workflow, dan check tidak berubah. Langkah di bawah membuktikan statement gagal `postgres_log_policy` yang diperbaiki `/debug` dan batas `large_client_header_buffers` per protokol. Ditulis `/architect` pada 2026-10-05; langkah tanpa tanda centang belum dijalankan dan menunggu verify._

### Statement gagal `postgres_log_policy` (keputusan 76)

- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "failing statement"` → 1 pass, 16 expect: `failingStatement` memberi literal yang diawali huruf, memuat sentinel, dan tanpa tanda kutip tunggal untuk sentinel `4131676112dffbc3819f9455729329ab`, `21474836490abcdef0123456789abcde`, `0b` diikuti 32 digit biner, dan `0123456789abcdef0123456789abcdef` (2026-10-05 saat /architect: sesuai) → AC-10
- [x] Uji mutasi: ubah sementara `failingStatement` di `tests/orchestration/deployment-real.ts` menjadi `SELECT $s$${sentinel}$s$::integer` (tanpa huruf `x`), jalankan test yang sama, lalu kembalikan file nya byte identik (`cmp`) → test gagal karena literal tidak diawali huruf (2026-10-05 saat /check verify: mutan exit 1 dengan `Expected substring or pattern: /^[a-z]/`, file dikembalikan byte identik dengan SHA 256 sama) → AC-10
- [x] `bun run test:deployment:real` → `check postgres_log_policy passed` dengan detail `postgres berjalan dengan log_min_messages=log, log_min_error_statement=panic, log_error_verbosity=terse; statement gagal bersentinel tidak masuk log`. Check itu hanya lulus bila `exec postgres failing` keluar bukan 0 dengan stderr memuat `invalid input syntax` (bukan `out of range`) dan log postgres tidak memuat sentinel itu, `invalid input syntax`, maupun `STATEMENT:` (2026-10-05 saat /check verify: sesuai pada dua run bersih; pada topologi manual psql keluar 1 dengan `invalid input syntax` dan log postgres tanpa sentinel, `invalid input syntax`, atau `STATEMENT:`) → AC-10

### Batas `large_client_header_buffers` per protokol (keputusan 74 dan 75)

- [x] Selama run: `curl --cacert <ca.pem> --http1.1 -sS -D - "https://localhost:<port>/api/<9.000 karakter a>"` → 414 `Request-URI Too Large` dengan Header dokumen (bukan Header API), `Server: nginx` tanpa versi, body bawaan nginx dengan `<center>nginx</center>`, dan tanpa `Access-Control-*`; baris log edge yang `requestId` nya sama dengan header `X-Request-Id` jawaban itu memuat `"method":""`, `"path":""`, `"status":414`, dan `"upstreamStatus":""` (2026-10-05 saat /check verify: sesuai pada topologi manual `deploy/compose.yaml` dengan CA sementara, dan sekali lagi pada edge tunggal untuk body lengkap) → AC-7, AC-10
- [x] Selama run: `curl --cacert <ca.pem> --http2 -sS -D - "https://localhost:<port>/api/<9.000 karakter a>"` → 404 JSON backend dengan Header API, karena `:path` itu sekitar 5.625 byte sesudah dikodekan HPACK; perintah yang sama dengan 9.000 karakter `~` (kode Huffman 13 bit) → curl exit 16 tanpa jawaban, dan log edge mendapat satu baris baru `"status":0` dengan `"path":""` (2026-10-05 saat /check verify: sesuai pada topologi manual; baris log backend dengan ID yang sama memuat path 200 karakter) → AC-7, AC-10
- [x] Baca `index.md` → pengecualian AC-7 menyebut 400 untuk baris header HTTP/1.1 dan path di atas root, 414 untuk request line HTTP/1.1, serta ukuran sesudah dikodekan HPACK pada HTTP/2; uraian check `edge_errors` menyebut request mentah HTTP/1.1 dengan 9.000 karakter `h`, dan uraian `log_structure` menyebut 9.000 karakter `~` lewat `node:http2` (2026-10-05 saat /check verify: sesuai, dan orkestrasi memakai `'h'.repeat(9_000)` serta `'~'.repeat(...)` lewat `node:http2`) → AC-7, AC-10

### Jalankan ulang

- [x] `bun run test:deployment:plan` → seluruh test lulus, termasuk test DEP-001 statement gagal (2026-10-05 saat /check verify: 51 pass, 0 fail) → AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12
- [x] `bun run test:deployment:real` → `36 check passed, 0 failed, 0 not_run`, `deployment: passed`, exit 0, tanpa resource run tersisa (2026-10-05 saat /check verify: dua run bersih, masing masing 87 detik) → AC-1 sampai AC-11

## Acceptance-criteria coverage (langkah 9)

- AC-7: kalimat pengecualian yang diperbaiki (414 untuk request line HTTP/1.1, field HTTP/2 diukur sesudah dikodekan) dibuktikan langkah curl langkah 9; 400 header besar HTTP/1.1 dan `/api/../../x` tetap dikunci check `edge_errors` per push.
- AC-10: baris log 414 dibuktikan langkah curl langkah 9; statement gagal yang kini selalu memberi `invalid input syntax` dibuktikan check `postgres_log_policy` dan DEP-001.

## Perintah: nama backend yang berhenti di DNS Docker (langkah 10)

_Langkah 10 build plan (AC-8, AC-9, keputusan 77): service `edge` mendapat `dns_opt: [ndots:0]`, dan check `compose_declaration`, `container_hardening`, serta DEP-001 menguncinya. Ditulis `/debug` pada 2026-10-06 sesudah run GitHub Actions 37371338557 gagal pada check `backend_shutdown_restart`._

### Reproduksi di daemon Linux

- [x] Daemon `docker:28.0.4-dind` (privileged) dengan `/etc/resolv.conf` seperti runner (`nameserver 127.0.0.53`, `options edns0 trust-ad`, `search`, tanpa `ndots`) dan resolver lokal di `127.0.0.53` yang meneruskan nama bertitik tetapi tidak menjawab nama satu label; client Linux `mcr.microsoft.com/playwright:v1.63.0-noble` dengan Bun 1.4.2, Docker CLI 28.0.4, dan Compose 2.38.2 atas salinan `git archive` commit `826b328` → `bun run test:deployment:real` keluar 1 dengan pesan yang sama dengan run CI: `check backend_shutdown_restart failed: 1 jawaban sesudah 15000 ms, diharapkan paling sedikit 3; 1 jawaban sesudah 15000 ms bukan 502`, dan 35 check lain lulus (2026-10-06) → AC-9
- [x] Probe di daemon yang sama dengan image edge dan backend commit itu, network biasa dan internal seperti topologi: `resolv.conf` edge menulis `# Option ndots from: internal` dan `# ExtServers: [host(127.0.0.53)]`; sesudah `docker stop` backend, `dig backend @127.0.0.11` dari namespace network edge → `SERVFAIL` sesudah sekitar 4 detik; `/api/status` setiap 500 ms → 504 dengan `time_total` 3,0 detik sampai detik ke 18; sesudah `docker start` 404 backend lagi dalam 613 ms karena alamat lama tidak pernah dilepas (2026-10-06) → AC-9
- [x] Probe yang sama dengan `--dns-option ndots:0` pada edge → `# Option ndots from: override`; sesudah stop, `backend` → `NOERROR` tanpa jawaban dalam sekitar 20 ms, `/api/status` 504 sampai detik ke 9 lalu 502, dan 404 backend lagi 10,7 detik sesudah start (2026-10-06) → AC-9
- [x] Docker Desktop 29.8.0: `resolv.conf` container pada network buatan pengguna menulis `# Option ndots from: internal` dan `# ExtServers: [host(192.168.65.7)]`, dan `dig backend @192.168.65.7` → `NXDOMAIN`, sehingga suite lulus di Mac tanpa perbaikan (2026-10-06)

### Sesudah perbaikan

- [x] `bun --no-env-file test ./tests/integration/deployment/static.test.ts -t "DEP-001"` → 29 pass, 0 fail (2026-10-06) → AC-8
- [x] Uji mutasi: hapus `dns_opt` dari service `edge` di `deploy/compose.yaml`, jalankan test yang sama, lalu kembalikan file nya byte identik (`cmp`) → 2 fail: tabel *Topologi* (`dns_opt` hilang) dan `declarationProblems` (`edge: dns_opt`) (2026-10-06) → AC-8
- [x] `bun run test:deployment:plan` → 51 pass, 0 fail (2026-10-06) → AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12
- [x] Daemon Linux runner seperti di atas, salinan commit `826b328` ditambah perbaikan → `bun run test:deployment:real` `36 check passed, 0 failed, 0 not_run`, exit 0 dalam 75 detik; `backend_shutdown_restart` `stop backend 153 ms, exit 0, baris stopped; 24 jawaban (0 kali 504) lalu 502; 404 backend lagi 8630 ms sesudah start tanpa restart edge`; tidak ada container, network, volume, atau image run tersisa (2026-10-06) → AC-8, AC-9
- [x] Mac (Docker Desktop 29.8.0) → `bun run test:deployment:real` `36 check passed, 0 failed, 0 not_run`, exit 0; `backend_shutdown_restart` `stop backend 209 ms, exit 0, baris stopped; 30 jawaban (0 kali 504) lalu 502; 404 backend lagi 6063 ms sesudah start tanpa restart edge` (2026-10-06) → AC-8, AC-9
- [x] `bun run test:ci` → `gate fast: tier passed (19 dari 19 langkah passed)`, exit 0 (2026-10-06) → AC-11
- [x] `bun run check:workflow` → `Workflow lulus` untuk `application.yml` dan `capacity.yml`, tanpa perubahan workflow (2026-10-06) → AC-11
- [x] Sesudah push: job `real` run GitHub Actions commit perbaikan → `check backend_shutdown_restart passed` dan `deployment: passed` pada runner `ubuntu-24.04` (2026-10-06: run 37378048630 commit `dec4dda`, `36 check passed, 0 failed, 0 not_run`, `test:deployment:real` 93,1 detik, `test:performance:smoke` passed, tier nyata 7 dari 7 langkah passed, dan job `application`, `real`, `security`, serta `report` sukses) → AC-8, AC-9

## Acceptance-criteria coverage (langkah 10)

- AC-8: `dns_opt` `ndots:0` hanya pada edge dibuktikan check `compose_declaration` (deklarasi) dan `container_hardening` (`DnsOptions` container), dan DEP-001 menguji tabel *Topologi* serta mutasi tanpa opsi itu.
- AC-9: `backend_shutdown_restart` lulus pada daemon Linux dengan DNS host seperti runner yang sebelumnya mereproduksi kegagalan CI, dan pada Docker Desktop; jendela 15.000 ms dan 20 detik tidak berubah.
