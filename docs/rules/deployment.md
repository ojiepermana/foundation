# Deployment container

Frontend, backend, dan runner migration masing masing dibangun menjadi image sendiri dengan root monorepo sebagai build context ([spec 0012](../specs/0012-build-container-deployment-terpisah/index.md)). `deploy/compose.yaml` adalah topologi rujukan untuk satu host Docker yang netral terhadap penyedia: satu edge nginx melayani frontend statis, mengakhiri TLS, dan meneruskan `/api/` ke backend; backend dan PostgreSQL hanya berada di network internal; migration berjalan sebagai job sekali jalan. Aturan ini berlaku bersama [aturan keamanan](security.md), [aturan database](database.md), [aturan infrastruktur](infrastructure.md), dan [aturan testing](testing.md).

Kode proyek tidak mendorong image ke registry dan tidak melakukan deploy. Status kesiapan release dari `bun run test:report:release` adalah ringkasan bukti, bukan izin deploy; keputusan deploy dicatat terpisah oleh pemilik release. Pipeline deploy, registry, dan platform tujuan kelak memerlukan spec sendiri.

## Image

| Image | Dockerfile | Isi | User | Proses | Stop signal |
| --- | --- | --- | --- | --- | --- |
| Edge | `apps/frontend/Dockerfile` | Build production Angular di `/srv/frontend/` dan nginx 1.30.5 dengan `apps/frontend/edge/` | `101:101` | `foundation-edge`, lalu nginx di foreground | `SIGQUIT` |
| Backend | `apps/backend/Dockerfile` | Satu bundle `bun build` komposisi production di `/app/backend.js` | `1000:1000` | `bun --no-env-file /app/backend.js` | `SIGTERM` |
| Runner | `database/Dockerfile` | `database/` dan `libs/server/database/` dari konteks daftar izin | `1000:1000` | `bun --no-env-file`, perintah bawaan `database/migrate.ts` | `SIGTERM` |

Bangun ketiganya dari root checkout, dengan tag lokal pilihan Anda:

```sh
docker build -f apps/frontend/Dockerfile -t foundation-frontend:<tag> .
docker build -f apps/backend/Dockerfile -t foundation-backend:<tag> .
docker build -f database/Dockerfile -t foundation-migrate:<tag> .
```

- Konteks build selalu root monorepo. Setiap Dockerfile mempunyai file ignore `<Dockerfile>.dockerignore` yang menolak semua path (`*`), hanya memasukkan kembali path tabel *Daftar izin konteks build* spec 0012, lalu menolak `**/.env` dan `**/.env.*`. `.dockerignore` root adalah daftar tolak pengaman untuk build root lain. File `.env` dan `.env.*` dari checkout tidak pernah masuk konteks.
- Credential tidak pernah diberikan saat build: tidak ada `ARG`, build secret, atau `ENV` credential. Credential hanya masuk saat runtime lewat environment service yang membutuhkannya, dan sertifikat serta key TLS hanya lewat secret file Compose.
- Image ditandai lokal saja lewat `-t`. Jangan mendorong image ke registry dari mesin operator atau dari CI; mendorong image dengan digest adalah bagian pipeline deploy yang belum dirancang.
- Orkestrasi uji memberi label `org.opencontainers.image.revision` (commit), `foundation.source-tree` (SHA 256 pohon sumber), `foundation.test`, dan `foundation.run` lewat `--label`. Build manual tanpa `--label` mewarisi label `org.opencontainers.image.revision` milik image dasar Bun pada image backend dan runner, jadi jangan membaca label itu sebagai commit proyek. Berikan `--label org.opencontainers.image.revision=<commit>` sendiri bila Anda membutuhkannya.
- Image PostgreSQL `foundation-postgres:18-pinned` dibangun dari `infrastructure/postgres/pins.json` menurut [aturan infrastruktur](infrastructure.md), misalnya lewat `bun run test:infrastructure`.

## Topologi

`deploy/compose.yaml` (project `foundation-deploy`) mendefinisikan service `edge`, `backend`, `postgres`, dan `migrate` (profil `migrate`), serta network `public`, `app` (`internal: true`), dan `data` (`internal: true`). Hanya edge yang mempublikasikan port. Backend dan runner tidak dapat menjangkau internet, edge tidak dapat menjangkau PostgreSQL, dan setiap service berjalan sebagai user non root (edge 101, backend dan runner 1000, PostgreSQL 26), tanpa capability, dengan `no-new-privileges`, batas CPU, memory, dan PIDs, serta root filesystem read only kecuali PostgreSQL. File ini tidak membangun image; image dirujuk lewat variable.

Salin `.env.deploy.example` ke `.env.deploy`, beri mode 0600, lalu isi nilainya. File asli diabaikan Git lewat pola `.env.*`.

| Variable | Fungsi |
| --- | --- |
| `FOUNDATION_FRONTEND_IMAGE`, `FOUNDATION_BACKEND_IMAGE`, `FOUNDATION_MIGRATE_IMAGE` | Tag image hasil build lokal, wajib |
| `FOUNDATION_POSTGRES_IMAGE` | Image PostgreSQL, default `foundation-postgres:18-pinned` |
| `FOUNDATION_POSTGRES_PASSWORD` | Password `foundation_admin`, hanya dipakai saat cluster pertama kali dibuat, secret |
| `FOUNDATION_BACKEND_DATABASE_URL` | DSN `foundation_backend` ke `postgres:5432/foundation`, menjadi `DATABASE_URL` backend, secret |
| `FOUNDATION_MIGRATOR_DATABASE_URL` | DSN `foundation_migrator`, hanya untuk service `migrate`, secret |
| `FOUNDATION_EDGE_TLS_CERT_FILE`, `FOUNDATION_EDGE_TLS_KEY_FILE` | Path host sertifikat (rantai lengkap) dan key TLS, secret file |
| `FOUNDATION_EDGE_BIND`, `FOUNDATION_EDGE_HTTPS_PORT`, `FOUNDATION_EDGE_HTTP_PORT` | Alamat dan port host edge, default `0.0.0.0`, 443, dan 80 |

`FOUNDATION_ADMIN_DATABASE_URL`, `FOUNDATION_MIGRATOR_PASSWORD`, dan `FOUNDATION_BACKEND_PASSWORD` hanya ada di shell operator untuk run provisioning dan tidak ditulis ke `.env.deploy`. Path relatif pada kedua variable TLS dibaca relatif terhadap folder `deploy/` (folder file Compose), jadi pakai path absolut. Siapa pun dengan akses Docker setara root di host dan dapat membaca environment container lewat `docker inspect`; karena itu setiap service hanya menerima credential miliknya, dan edge tidak menerima credential apa pun.

Aturan nilai `.env.deploy`:

- Compose mengganti `$` di dalam env file. Password `ab$cd1234` menjadi `ab` hanya dengan peringatan `variable is not set`, dan `${HOME}` menjadi path host. Pakai password huruf dan angka saja, misalnya hasil `openssl rand -hex 24`, atau tulis setiap `$` sebagai `$$`.
- Tulis DSN dalam bentuk `postgres://<role>:<password>@postgres:5432/foundation`, untuk `FOUNDATION_BACKEND_DATABASE_URL`, `FOUNDATION_MIGRATOR_DATABASE_URL`, dan `FOUNDATION_ADMIN_DATABASE_URL` di shell provisioning. Backend dan runner membaca DSN dengan `new URL`, jadi karakter khusus pada password harus ditulis dengan persen encoding (`@` menjadi `%40`, `:` menjadi `%3A`, `/` menjadi `%2F`, `#` menjadi `%23`, `?` menjadi `%3F`, `%` menjadi `%25`). Password dengan `#` atau `/` tanpa encoding membuat DSN ditolak.
- Perlakukan peringatan Compose `variable is not set` sebagai nilai yang terpotong. Hentikan langkah itu dan perbaiki `.env.deploy` sebelum melanjutkan.
- `.env.deploy` memuat password `foundation_admin` bersama DSN kedua role runtime, karena Compose rujukan memakai satu env file untuk semua service. Ini risiko yang diterima (rationale spec 0012, keputusan 71), bukan pemisahan seperti `.env.infrastructure` di [aturan infrastruktur](infrastructure.md): siapa pun yang dapat membaca file ini mendapat credential admin dan kedua role runtime. Perlakukan `.env.deploy` sebagai secret setingkat admin: mode 0600 milik operator, jangan ikutkan ke backup biasa, bundel dukungan, atau ekspor secret CI, dan pindahkan nilainya ke secret manager saat platform dipilih.

## Langkah deployment berurutan

Jalankan dari root checkout. Setiap langkah harus keluar 0 sebelum langkah berikutnya.

1. Build ketiga image dengan perintah di bagian *Image*, dan pastikan `foundation-postgres:18-pinned` tersedia.
2. Jalankan PostgreSQL dan tunggu healthcheck `pg_isready`:

   ```sh
   docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --wait postgres
   ```

3. Provisioning sekali per database. Isi ketiga variable provisioning di shell dari secret manager Anda, tanpa menaruh nilainya di argumen perintah. `-e <NAMA>` tanpa nilai membuat Compose mengambil nilai dari environment perintah itu, dan `--rm` menghapus container begitu langkah selesai:

   ```sh
   docker compose --env-file .env.deploy -f deploy/compose.yaml --profile migrate run --rm \
     -e FOUNDATION_ADMIN_DATABASE_URL -e FOUNDATION_MIGRATOR_PASSWORD -e FOUNDATION_BACKEND_PASSWORD \
     migrate database/provision.ts --apply
   ```

   Hapus ketiga variable dari shell sesudahnya. Provisioning tidak membuat schema, role, atau grant di luar spec 0004, dan pengulangan tidak mengganti password role yang sudah ada.
4. Jalankan backend:

   ```sh
   docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --wait backend
   ```

5. Baca readiness dari dalam container backend, karena `/health/ready` hanya terjangkau dari jaringan internal. Sebelum migration jawabannya `503 {"status":"unavailable"}`:

   ```sh
   docker compose --env-file .env.deploy -f deploy/compose.yaml exec -T backend \
     bun --no-env-file -e "fetch('http://127.0.0.1:8888/health/ready').then(async (r) => console.log(r.status, await r.text()))"
   ```

6. Jalankan migration sebagai job sekali jalan. Runner hanya menerima `FOUNDATION_MIGRATOR_DATABASE_URL`, dan rerun mencetak `Migrations: 0 applied, <jumlah file> skipped`. Seed opsional memakai `database/seed.ts --apply` dengan bentuk perintah yang sama. Perintah bawaan image tanpa `--apply` keluar 1 dengan `Use --apply` tanpa mengubah database.

   ```sh
   docker compose --env-file .env.deploy -f deploy/compose.yaml --profile migrate run --rm migrate database/migrate.ts --apply
   ```

   Baca readiness lagi dengan perintah langkah 5: jawabannya menjadi `200 {"status":"ready"}` tanpa restart backend.
7. Jalankan edge, lalu periksa `https://<host>/` dari luar:

   ```sh
   docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --wait edge
   ```

Edge tidak mempunyai `depends_on`, jadi Compose rujukan tidak menahan trafik sampai readiness. Urutan di atas, atau platform yang membaca `/health/ready`, yang menjaga agar edge baru menerima trafik sesudah backend siap. Backend dan edge tidak pernah menjalankan provisioning, migration, atau seed.

Hentikan seluruh topologi dengan `docker compose --env-file .env.deploy -f deploy/compose.yaml stop`. Backend berhenti dengan SIGTERM dalam stop grace 10 detik, edge dengan SIGQUIT (shutdown halus nginx) dalam 15 detik, dan PostgreSQL dengan SIGINT dalam 30 detik. `down` tanpa `--volumes` mempertahankan volume `pgsql_data`; menghapus volume adalah reset data yang terpisah.

## Kebijakan endpoint production

| Jenis | Keputusan |
| --- | --- |
| OpenAPI JSON dan UI | Tidak dilayani production. Plugin hanya dipasang komposisi development, kontrak resmi adalah `openapi.json` di repository, dan dokumen itu tidak masuk image mana pun. |
| Route diagnostik development (`/api/status`, `/api/readiness`) | Hanya komposisi development; production dan edge menjawab 404 dari backend. |
| Health (`/health/live`, `/health/ready`) | Tanpa login, hanya jaringan internal (probe container, orkestrator, dan operator). Edge tidak meneruskannya, dan jawabannya tidak mengungkap waktu, versi, nama, atau pesan error. |
| Admin | Tidak ada. Endpoint admin kelak memerlukan autentikasi dan otorisasi backend (fitur 15) serta spec sendiri, dan tidak pernah dibuka publik tanpa itu. |
| Metrics | Tidak ada endpoint. Pengamatan lewat log dan statistik mesin container. Endpoint metrics kelak hanya jaringan internal di luar `/api/`, seperti health. |

`/health/live` menjawab 200 tanpa menyentuh database, sehingga orkestrator tidak memulai ulang backend yang sehat saat database berhenti. `/health/ready` menjawab 200 hanya bila migration `REQUIRED_MIGRATION` tercatat di `common.schema_migrations`, dan 503 bila database tidak terjangkau, lalu kembali 200 tanpa restart.

### Memantau

- `/health/live` dan `/health/ready` lewat edge publik bukan sinyal. Edge tidak meneruskannya dan menjawab path itu dengan `index.html` 200, seperti path lain tanpa ekstensi. Probe dari luar memeriksa edge dengan `GET https://<host>/` dan mengharapkan 200.
- Readiness backend hanya dibaca dari jaringan internal: probe orkestrator ke `backend:8888`, atau `compose exec` seperti langkah 5. Route health menjawab HEAD dengan 404, jadi probe memakai GET.
- Service `edge` tidak mempunyai healthcheck di Compose rujukan. Platform yang membutuhkan healthcheck edge memakai probe `GET /` di atas; healthcheck di dalam image edge adalah tindak lanjut spec 0012.
- Readiness menjalankan paling banyak satu query per proses. Bila query itu macet tanpa galat, misalnya koneksi ke database putus tanpa reset di tengah jaringan, `/health/ready` tetap 503 sampai kernel host menyerah pada koneksi itu, walaupun database sudah terjangkau lagi. Pada Linux dengan `net.ipv4.tcp_retries2` bawaan (15) itu sekitar 16 menit (959 detik pada probe 2026-10-05); sesudahnya query gagal dan pemeriksaan berikutnya kembali 200 tanpa restart bila database terjangkau (rationale spec 0012, keputusan 70). Bila readiness tetap 503 lebih lama dari itu padahal `pg_isready` di container `postgres` sehat, buat ulang backend dengan `docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --force-recreate --no-deps backend`.

## TLS, port publik, dan redirect

Edge mengakhiri TLS pada port container 8443 dengan TLS 1.2 dan TLS 1.3 saja, HTTP/2, dan HSTS `max-age=31536000`. Port container 8080 menjawab setiap request dengan 308 ke `https://$host$request_uri`. `$host` tidak membawa port dan berasal dari header `Host` client, jadi topologi rujukan mengasumsikan HTTPS publik pada port 443 dan HTTP pada port 80. Bila Anda mempublikasikan HTTPS pada port lain, redirect tetap mengarah ke port 443. Redirect juga memantulkan `Host` client sampai `server_name` dan daftar host ditetapkan saat domain dipilih (tindak lanjut spec 0012). Karena itu jawaban 308 membawa `Cache-Control: no-store`, sehingga browser atau cache bersama di depan edge tidak menyimpan redirect dengan `Host` pilihan client (rationale spec 0012, keputusan 67).

Edge juga meneruskan `Host` client apa adanya ke backend (`proxy_set_header Host $host`), dan kedua listener menerima `Host` apa pun. Backend dan setiap fitur berikutnya memperlakukan `Host`, seperti header alamat dan skema client, sebagai tidak dipercaya: URL absolut (tautan reset password, redirect, tautan email) dibangun hanya dari konfigurasi, tidak pernah dari `Host` request (rationale spec 0012, keputusan 72). Saat domain dipilih, tetapkan `server_name` dan jawab `Host` yang tidak dikenal dengan 421 atau 444 di edge.

Izin file key TLS: pemilik root, grup GID 101 (user nginx di image edge), mode 0640, misalnya `chown root:101 <key>` lalu `chmod 0640 <key>`. Sertifikat (rantai lengkap) boleh 0644. Edge tidak dapat start bila UID 101 tidak dapat membaca key.

- Simpan sertifikat dan key di luar checkout, misalnya di `/etc/foundation/tls/` milik root dengan mode 0750, dan isi kedua variable TLS dengan path absolut ke sana. `.gitignore` menolak `*.key`, `*.pem`, dan `*.crt` sebagai pengaman, tetapi pemindaian secret tier keamanan hanya membaca riwayat commit, bukan working tree.
- GID 101 di host sering sudah dipakai grup sistem lain. Periksa dengan `getent group 101` sebelum `chown`. Bila GID itu milik grup yang mempunyai anggota, jangan beri grup itu akses baca: pakai grup khusus tanpa anggota yang GID nya 101 hanya untuk keperluan ini, atau, pada filesystem host yang mendukung ACL POSIX, beri akses baca hanya kepada UID 101 (`chown root:root <key>`, `chmod 0600 <key>`, lalu `setfacl -m u:101:r <key>`).

Pembaruan sertifikat TLS: ganti file sertifikat dan key di path host yang sama, lalu buat ulang edge:

```sh
docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --force-recreate --no-deps edge
```

nginx membaca sertifikat dan key saat start, dan secret file Compose adalah bind mount yang tidak mengikuti file pengganti dengan inode baru, jadi reload atau restart saja dapat tetap memakai file lama. Backend tidak terganggu karena `--no-deps`.

## Rotasi password role

1. Buka koneksi admin, misalnya `docker compose --env-file .env.deploy -f deploy/compose.yaml exec postgres psql -h 127.0.0.1 -U foundation_admin -d foundation`, lalu jalankan `ALTER ROLE <role> PASSWORD ...` untuk `foundation_backend` atau `foundation_migrator`. Perintah `\password <role>` di psql mengirim `ALTER ROLE` dengan password yang sudah di hash, sehingga teks password tidak tersimpan di riwayat psql.
2. Perbarui DSN di `.env.deploy` (`FOUNDATION_BACKEND_DATABASE_URL` atau `FOUNDATION_MIGRATOR_DATABASE_URL`), atau variable shell provisioning bila Anda menyimpannya di secret manager.
3. Buat ulang backend agar memakai DSN baru: `docker compose --env-file .env.deploy -f deploy/compose.yaml up -d --force-recreate --no-deps backend`. Runner membaca DSN baru pada run berikutnya tanpa langkah tambahan.

Password `foundation_admin` hanya dipakai entrypoint saat cluster dibuat. Sesudah itu ganti lewat `ALTER ROLE foundation_admin PASSWORD ...` dengan koneksi admin, lalu perbarui `FOUNDATION_POSTGRES_PASSWORD` di `.env.deploy`, seperti aturan infrastruktur.

## Log dan retensi

- Baca log per container dengan `docker logs <container>`, yang memisahkan stdout dan stderr. `docker compose logs` menggabungkan keduanya.
- Edge menulis satu objek JSON per request ke stdout dengan key `time`, `requestId`, `method`, `path`, `status`, `bytes`, `requestTime`, `upstreamStatus`, dan `upstreamTime`. `path` tidak memuat query string, dan log tidak memuat IP client, user agent, referer, header, cookie, atau body. `status` bernilai `0` bila nginx mengakhiri request tanpa mengirim jawaban, misalnya stream HTTP/2 dengan header di atas batas. Error log edge ditulis ke stderr pada level `crit`.
- Request yang ditolak nginx sebelum URI nya selesai diurai, yaitu path yang naik di atas root (misalnya `/api/../../x`) atau request line yang tidak sah, tetap tercatat satu baris dengan `status` 400 dan `requestId`, tetapi `path` kosong dan `method` dapat kosong, karena nginx belum mengisi `$request_uri` saat menolaknya. Cari baris itu lewat `requestId`, yang sama dengan header `X-Request-Id` jawaban 400 nya. Edge sengaja tidak mengisi `path` dari request line mentah, karena request line itu memuat query string.
- Backend production menulis satu baris JSON per request yang sampai ke Elysia, kecuali jawaban health di bawah 500, dan baris JSON lifecycle (`listening`, `stopped`, dan kegagalan shutdown atau startup). Baris `info` ke stdout dan baris `error` ke stderr. Jawaban `/health/ready` 503 sebelum migration dan selama database tidak terjangkau tercatat sebagai baris `error` di stderr; itu wajar pada kedua keadaan itu.
- Header jawaban `X-Request-Id`, baris log edge, dan baris log backend untuk satu request memuat ID yang sama. Backend tidak mempercayai `X-Request-Id` dari client yang bukan 32 heksadesimal kecil, dan edge selalu menimpa header itu.
- PostgreSQL berjalan dengan `log_min_messages=log`, `log_min_error_statement=panic`, dan `log_error_verbosity=terse`, sehingga statement gagal tidak masuk log.
- Setiap service memakai log driver `json-file` dengan `max-size` `10m` dan `max-file` `3`. Retensi log di platform paling lama 30 hari. Penyimpanan log platform dengan retensi itu ditetapkan saat platform dipilih.
- Risiko sisa: pesan `crit` nginx yang jarang, misalnya gagal menulis file sementara, masih dapat memuat baris request beserta query string. Perlakukan stderr edge sebagai log yang dapat memuat data request, dengan retensi yang sama.

## Batas bukti

- Bukti per push adalah `bun run test:deployment:plan` (tier cepat) dan `bun run test:deployment:real` (tier nyata): topologi rujukan di satu host Docker dengan sertifikat dari CA sementara. Bukti itu bukan bukti platform deployment, kapasitas, image di registry, atau ketiadaan kerentanan paket OS image.
- Paket OS ketiga image tidak dipindai pemindai kerentanan. `bun audit` di tier keamanan hanya mencakup paket npm. Pemindai image memerlukan spec tersendiri.
- Tidak ada TLS di dalam host antara edge, backend, dan PostgreSQL, dan tidak ada rate limit. Topologi multi host atau database terkelola memerlukan spec baru.
- Browser pengguna memuat font dari Google sampai font di host sendiri.

## Status kesiapan release

`bun run test:report:release` menghitung ulang laporan per push dan laporan kapasitas dari bundle CI yang diunduh untuk commit kandidat, lalu menulis `.local/feature-13/release.json` dan `.local/feature-13/release.md` dengan status `ready`, `blocked`, atau `incomplete`. Perintah keluar 0 hanya untuk `ready`. Status `ready` bukan izin deploy, dan `grantsDeployment` selalu `false`. Identitas run dibaca dari manifest bundle yang ditulis run itu sendiri dan tidak diverifikasi ke GitHub.

1. Pilih run per push yang sah: event `push` ke `refs/heads/main` dengan gate `passed`, misalnya dari `gh run list --workflow application.yml --commit <commit> --event push --branch main`, dan run kapasitas `workflow_dispatch` pada `refs/heads/main` untuk commit yang sama dari `gh run list --workflow capacity.yml --commit <commit>`. Artifact disimpan 90 hari.
2. Siapkan checkout bersih commit kandidat (`git switch --detach <commit>`, lalu `git status --porcelain` harus kosong), dan kosongkan folder bundle lama dengan `rm -rf .local/feature-11/evidence .local/feature-12`.
3. Unduh keempat artifact ke folder bundle. Isi artifact `capacity-evidence` berakar di `.local/`, jadi artifact itu diunduh ke `.local`:

   ```sh
   gh run download <run push> -n application-evidence -D .local/feature-11/evidence/fast
   gh run download <run push> -n real-evidence -D .local/feature-11/evidence/real
   gh run download <run push> -n security-evidence -D .local/feature-11/evidence/security
   gh run download <run kapasitas> -n capacity-evidence -D .local
   ```

4. Pasang dependency dari lockfile, lalu hitung status:

   ```sh
   bun install --frozen-lockfile
   bun run test:report:release
   ```

5. Baca `.local/feature-13/release.md`. Alasan yang tercatat menunjukkan apa yang kurang: `gate_failed` dan `capacity_failed` membuat status `blocked`; `gate_incomplete`, `capacity_incomplete`, `gate_not_candidate`, `capacity_not_candidate`, `candidate_differs`, dan `image_differs` membuat status `incomplete`. Bundle dari run lokal tidak mempunyai identitas CI, sehingga selalu `incomplete`.
6. Salin hasilnya ke laporan release menurut [template laporan release](../testing/release-report-template.md). Keputusan deploy dan pengecualian apa pun dicatat terpisah oleh pemilik release.

## Pembaruan pin image dasar

Pin image dasar hanya ditulis di Dockerfile, dalam bentuk `<repo>:<tag>@sha256:<digest>`. Pin Bun juga ada di `tests/performance/images.json` dengan digest yang sama, dan tag mengikuti `engines` di `package.json`: Node `<engines.node>-trixie-slim`, Bun `<engines.bun>-slim`, dan nginx jalur stable dengan tag patch tepat `-alpine`.

1. Baca digest indeks multi arch dengan `docker buildx imagetools inspect <image>:<tag>`. Pakai baris `Digest` teratas (media type image index), bukan digest satu platform.
2. Perbarui `FROM` dan `COPY --from` di Dockerfile terkait, serta `tests/performance/images.json` bila pin Bun berubah, dalam satu PR.
3. Jalankan `bun run test:deployment:plan` (DEP-001 membandingkan pin dengan `engines` dan `tests/performance/images.json`) dan `bun run test:deployment:real`, lalu lampirkan `.local/feature-13/images.json` pada PR. Reviewer menolak digest satu platform.

Tidak ada bot update otomatis untuk pin; jadwalkan pemeriksaan berkala.

## Tanggung jawab agent dan verifikasi

Agent yang mengubah Dockerfile, file ignore, `apps/frontend/edge/`, `deploy/compose.yaml`, atau orkestrasi `tests/orchestration/deployment-real.ts` membaca aturan ini dan spec 0012, lalu menjalankan `bun run test:deployment:plan` dan `bun run test:deployment:real`. Perubahan nilai CSP, header, batas body, atau resource hanya lewat pembaruan spec 0012 dengan alasan tertulis. Setiap migration baru memperbarui `REQUIRED_MIGRATION` di `apps/backend/src/features/health/health.queries.ts` pada commit yang sama.

Pembersihan manual sesudah run uji yang terhenti tanpa pembersihan, misalnya karena SIGKILL: daftar resource berlabel `foundation.test=deployment` dengan `docker ps -a --filter label=foundation.test=deployment` dan `docker image ls --filter label=foundation.test=deployment`, periksa label `foundation.run` setiap resource, lalu hapus dengan nama eksplisit sesudah Anda tinjau (project `foundation-deploy-<hex>` lewat `docker compose -p foundation-deploy-<hex> down --volumes --remove-orphans`). Orkestrasi sendiri tidak pernah menghapus lewat pola nama atau label.
