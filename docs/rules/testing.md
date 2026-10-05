# Aturan testing dan kesiapan production release

Setiap pekerjaan menilai dampak perubahan, menentukan skenario yang perlu dibuktikan, menjalankan pemeriksaan yang relevan, dan melaporkan bukti serta keterbatasannya. Aturan ini berlaku untuk agent utama dan subagent bersama [workflow development](development-workflow.md).

Tidak setiap perubahan memerlukan semua jenis test. Perubahan dokumentasi atau perubahan kecil tanpa dampak perilaku cukup diverifikasi sesuai dampaknya, dengan alasan yang jelas. Jangan membuat test yang hanya menyalin implementasi atau menguji detail internal tanpa manfaat.

## Jenis test dan runner

| Jenis | Runner | Bukti yang dicari |
| --- | --- | --- |
| Unit frontend | Vitest melalui Angular CLI. | Perilaku komponen, validasi, state, dan service secara terisolasi. |
| Integration frontend | Vitest melalui Angular CLI. | Interaksi komponen, service, routing, dan komposisi UI. |
| Unit backend, worker, dan kode server bersama | `bun:test`. | Aturan bisnis dan fungsi tanpa database atau layanan eksternal nyata. |
| Integration backend, worker, dan database | `bun:test` dengan PostgreSQL 18 sebagai baseline. | Route, service, query, constraint, transaksi, migration, dan pemrosesan job bekerja bersama. |
| E2E | Playwright Test. | Alur pengguna melalui frontend, backend, database, dan worker yang relevan. |
| Performance dan ketahanan | k6. | Hasil bisnis, latency, kapasitas, kestabilan, serta pemulihan pada pola beban yang ditentukan. |

Seluruh dependency dan script tetap dikelola melalui `package.json` root. Angular memakai integrasi test Angular CLI sesuai versi project. Backend dan worker memakai runner native Bun. Playwright dan k6 menggunakan runner masing-masing; jangan mengimpor modul khusus runtime Bun ke script yang dijalankan runner lain.

## Struktur test

```text
foundation/
├── package.json
├── playwright.config.ts
├── apps/
│   ├── frontend/src/app/features/<fitur>/
│   │   ├── <komponen>.spec.ts
│   │   └── <komponen>.integration.spec.ts
│   ├── backend/src/features/<fitur>/
│   │   └── <service>.test.ts
│   └── worker/<worker>/src/
│       └── <handler>.test.ts
├── tests/
│   ├── scenarios/
│   │   └── <fitur>.json
│   ├── fixtures/
│   ├── integration/
│   │   ├── backend/
│   │   ├── worker/
│   │   ├── database/
│   │   ├── gate/
│   │   ├── deployment/
│   │   └── performance/
│   ├── e2e/
│   │   ├── fixtures.ts
│   │   └── <fitur>/
│   │       └── <alur>.e2e.spec.ts
│   ├── orchestration/
│   │   ├── <suite>-real.ts
│   │   ├── performance-real.ts
│   │   ├── deployment-real.ts
│   │   ├── security-scan.ts
│   │   └── signal-cleanup.ts
│   ├── security/
│   │   ├── scanners.json
│   │   ├── gitleaks.toml
│   │   ├── actionlint.yaml
│   │   └── exceptions.json
│   └── performance/
│       ├── images.json
│       ├── journeys/
│       ├── profiles/
│       │   ├── smoke.ts
│       │   ├── load.ts
│       │   ├── stress.ts
│       │   ├── spike.ts
│       │   ├── outage.ts
│       │   └── soak.ts
│       ├── browser/
│       └── helpers/
│           ├── plan.ts
│           ├── expectations.ts
│           ├── metrics.ts
│           └── lifecycle.ts
└── docs/testing/
    └── release-report-template.md
```

Struktur menunjukkan lokasi ketika file diperlukan, bukan kewajiban membuat seluruh file contoh. Unit test library bersama berada dekat kode library tersebut dan menggunakan runner yang sesuai.

Unit test berada dekat kode yang diuji. Integration komponen Angular juga berada dekat fitur. Integration server serta E2E dan performance lintas aplikasi berada di `tests/` root.

Model beban, fase, alokasi VU, dan thresholds k6 (spec 0011) hanya ada di modul murni `tests/performance/helpers/plan.ts`, dan klasifikasi respons di `tests/performance/helpers/expectations.ts`; keduanya tanpa impor sehingga dipakai k6 maupun unit `bun:test` di `tests/integration/performance/`. Orkestrasi Docker setiap profil k6 berada di `tests/orchestration/performance-real.ts`.

Setiap runner mempunyai cakupan file eksplisit. Jangan menjalankan `bun test` tanpa filter dari root sehingga file Angular dan Playwright ikut ditemukan. Konfigurasi Playwright hanya menemukan suite E2E; konfigurasi Angular hanya menemukan suite frontend.

Setiap file yang namanya cocok pola discovery `^.+[._](test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$` dimiliki tepat satu runner menurut tabel pemilik di `scripts/lib/test-inventory.ts` (spec 0010 AC-1). `bun run check:test-discovery` gagal dengan path file yang tidak dimiliki runner mana pun, dimiliki dua runner, atau berbeda dari daftar `playwright test --list` dan `ng test --list-tests`; sesudah run, laporan gate juga membandingkan file pada JUnit setiap script dengan file miliknya. Lokasi test baru, misalnya test unit backend `apps/backend/src/features/<fitur>/<service>.test.ts`, membutuhkan satu baris pemilik di `scripts/lib/test-inventory.ts` dan langkah tier untuk script pemiliknya pada commit yang sama. Fixture yang namanya cocok pola discovery dibuat saat runtime di folder `mkdtemp`, tidak di-commit.

`tests/fixtures/` berisi data atau factory yang tidak bergantung pada runner. Setup khusus Bun, Angular, Playwright, atau k6 tetap berada di area masing-masing.

Orkestrasi test yang memanggil Docker, misalnya untuk menyalakan, menghentikan, atau menghapus PostgreSQL terisolasi, berada di `tests/`, tidak pernah di `scripts/`. Folder `scripts/` hanya berisi tooling development, build, dan pemeriksaan repository, dan INFRA-001 spec 0002 gagal bila ada file `.ts` di bawahnya yang memuat kata `docker`. Orkestrasi Bun yang dijalankan root script, seperti `test:database:real` dan `test:readiness:real`, berada di `tests/orchestration/` bersama modul penjaga container `readiness-container.ts`; smoke `test:tooling:real` berada di `tests/integration/tooling-real/`. Orkestrasi di `tests/` boleh mengimpor modul `scripts/lib/` yang tidak memanggil Docker, seperti `process-group.ts` dan `ports.ts`. File di `tests/orchestration/` tidak memakai akhiran `.test.ts` atau `.e2e.spec.ts`, sehingga tidak ditemukan `bun test` maupun Playwright.

Setiap file `bun:test` nyata yang membuat container atau project Compose wajib mendaftarkan resource itu pada `tests/orchestration/signal-cleanup.ts` sebelum resource dibuat, satu callback per project, container, folder sementara, atau proses backend, lalu melepasnya sesudah jalur normal (`afterAll`, `finally`, atau penghapusan project) menghapusnya. `bun test` tidak menjalankan `afterAll` maupun `finally` saat menerima SIGINT, SIGTERM, atau SIGHUP; modul itu menjalankan callback secara sinkron dalam urutan terbalik, dua putaran, lalu keluar 130, 143, atau 129. Callback hanya menghapus nama yang dibuat proses itu sendiri, tidak pernah lewat pencarian pola nama atau label, sehingga run lain yang berjalan bersamaan tidak tersentuh. GATE-009 memeriksa bahwa setiap file test di `tests/integration/infrastructure/` dan `tests/integration/database/` yang memanggil Docker mengimpor modul ini, membaca source nya bahwa setiap `docker run` atau perintah Compose yang membuat resource didahului pendaftaran di fungsi yang sama dan setiap pelepasan didahului penghapusan jalur normal, lalu menjalankan suite itu sendiri dengan executable `docker` palsu dan SIGTERM untuk membuktikan argumen penghapusan yang dijalankan callback nya; suite nyata baru di folder lain memperluas pemeriksaan itu pada commit yang sama.

## Pemetaan skenario

Specs fitur menjadi sumber kriteria penerimaan dan target performance. Beri setiap skenario ID stabil, seperti `AUTH-001`, dan hubungkan ke kriteria yang dibuktikan.

Registry `tests/scenarios/<fitur>.json` memetakan ID skenario ke rujukan specs, kriteria penerimaan, file dan nama atau tag test, runner, serta profil yang wajib dijalankan. Registry tidak menyalin seluruh requirements dan tidak menyimpan hasil lulus secara manual.

Untuk tooling repository yang kriterianya ditetapkan langsung dalam rules, registry boleh merujuk kriteria pada rule tersebut sebagai sumber. Tooling doctor/serve memakai `tests/integration/tooling/` dan root script `test:tooling`; test cleanup menggunakan proses fixture pada port sementara, bukan menghentikan layanan aplikasi nyata.

Untuk setiap skenario, tentukan prasyarat, data awal, tindakan, hasil yang diharapkan, pemeriksaan, dan kondisi lulus. Performance juga menentukan model beban, durasi, campuran aktivitas, environment, serta thresholds.

Pilih jenis test yang mampu membuktikan skenario; tidak semua skenario harus dijalankan oleh semua runner. Cakup alur utama, kegagalan penting, otorisasi, concurrency, retry, dan perubahan data yang relevan dengan fitur.

Validasi registry dalam CI: ID unik, rujukan specs dan test valid, serta seluruh skenario wajib mempunyai implementasi test. Rujukan file saja belum membuktikan bahwa test tersebut dijalankan atau mempunyai assertion yang sesuai.

`bun run test:scenarios` menerapkan schema tetap registry (spec 0010 AC-2) dan melaporkan seluruh pelanggaran sekaligus dengan path registry dan ID. Setiap skenario memakai bentuk `checks` yang tidak kosong; setiap check mempunyai `runner` (`bun:test`, `vitest`, `playwright`, atau `command`), `script` yang menjadi langkah satu tier gate, `file` reguler di dalam repository, dan `testTag` untuk runner selain `command`. Tag wajib muncul sebagai literal string di file test dan sebagai awalan judul lengkap test diikuti spasi; tag yang hanya ada di komentar tidak dihitung. Skenario `critical` mempunyai minimal satu check Playwright dan dilaporkan pada bagian alur kritis.

Laporan menghubungkan hasil runner dengan ID skenario dan membedakan:

- `passed`: pemeriksaan wajib dijalankan dan memenuhi kriteria.
- `failed`: pemeriksaan berjalan tetapi hasil tidak memenuhi kriteria.
- `skipped`: test tersedia tetapi tidak dijalankan, dengan alasan.
- `not_run`: belum ada eksekusi atau bukti yang sesuai.
- `missing_test`: skenario belum mempunyai implementasi test.
- `not_applicable`: tidak berlaku untuk perubahan atau release ini, dengan alasan dan rujukan cakupan.

Coverage skenario berbeda dari coverage kode. Persentase coverage kode tidak menggantikan bukti kriteria penerimaan. Test yang dilewati atau belum dijalankan tidak boleh dilaporkan sebagai lulus.

## Unit dan integration

Unit test memeriksa perilaku, bukan sekadar pemanggilan fungsi mock. Mock digunakan pada batas dependensi agar logika dapat diuji secara terisolasi.

Integration memakai implementasi nyata untuk bagian yang sedang dibuktikan. Test query atau transaksi menggunakan PostgreSQL nyata, bukan database pengganti atau mock SQL. Gunakan PostgreSQL 18 sebagai baseline dan ikuti [aturan database](database.md).

Siapkan database test melalui runner migration di `database/`, terpisah dari startup aplikasi. Data test disiapkan secara eksplisit dan diisolasi antar test atau proses paralel. Jangan memakai database atau kredensial production untuk eksekusi test rutin.

Gunakan unit test untuk aturan bisnis, integration untuk constraint dan transaksi, serta pemeriksaan migration untuk perubahan skema yang relevan. Pengujian migration berasal dari `tests/integration/database/` dan menjalankan runner atau file di `database/`.

## E2E dengan Playwright

Uji perilaku pengguna menggunakan frontend dan backend nyata, dengan database dan worker nyata ketika termasuk dalam alur yang dibuktikan. Mock hanya batas yang dinyatakan, seperti layanan eksternal yang tidak dikendalikan project; catat batas tersebut dalam bukti.

Gunakan locator berdasarkan role, label, teks, atau test ID yang disepakati. Hindari ketergantungan pada DOM internal `@ojiepermana/angular` dan jeda waktu tetap. Gunakan assertion yang menunggu kondisi serta timeout yang terbatas.

Test frontend membuktikan integrasi dan penggunaan komponen library dalam fitur, bukan mengulang pengujian seluruh implementasi internal library. Cakup state UI, keyboard, dan ukuran layar yang relevan sesuai [aturan UI/UX](ui-ux.md).

Playwright dapat menyalakan frontend dan backend melalui `webServer`. Infrastruktur database, migration, data awal, dan kesiapan worker ditangani orchestration test. Setup yang membutuhkan Bun dijalankan sebagai proses Bun terpisah; fixture Playwright dapat memakai API yang sesuai.

## Performance dengan k6

Alur bisnis berada di `journeys/`, pola beban berada di `profiles/`, dan helper k6 berada di `helpers/`. Gunakan alur yang sama untuk beberapa profil bila memungkinkan.

| Profil | Tujuan |
| --- | --- |
| Smoke | Memvalidasi script dan perilaku dasar pada beban ringan. |
| Load | Memenuhi target pada beban normal yang ditentukan. |
| Stress | Memeriksa perilaku di atas beban normal. |
| Spike | Memeriksa lonjakan mendadak dan pemulihan. |
| Outage | Memeriksa berhentinya database pada beban normal: penolakan terkontrol selama database berhenti, lalu pulihnya layanan sesudah database berjalan lagi. |
| Soak | Memeriksa kestabilan dalam durasi panjang. |
| Breakpoint, jika diperlukan | Mencari batas kapasitas. |

Mulai dengan smoke sebelum pengujian beban lebih tinggi. Tentukan profil wajib berdasarkan dampak dan risiko perubahan. Stress, spike, soak, dan breakpoint tidak wajib dijalankan untuk setiap pekerjaan kecil.

Definisikan target pengguna virtual atau laju kedatangan, durasi, data, dan campuran aktivitas. Bedakan laju iterasi dari request per detik jika satu alur melakukan beberapa request. Catat beban aktual dan iterasi yang tidak berhasil dimulai agar target yang tidak tercapai tidak dianggap terbukti.

Tetapkan checks untuk respons dan hasil bisnis, serta thresholds per skenario untuk menentukan kelulusan CI. Check yang gagal sendiri tidak cukup untuk membuat run gagal. Penolakan yang diharapkan, seperti akses tanpa izin, dinilai sesuai skenarionya dan dibedakan dari kegagalan tak terduga.

Target latency, throughput, tingkat kegagalan, dan waktu penyelesaian job ditentukan dalam specs. Jangan mengarang target universal atau melonggarkan threshold hanya agar test lulus. Angka contoh dalam percakapan bukan target project yang telah disepakati.

Untuk pekerjaan asynchronous, buktikan status akhir, waktu penyelesaian, dan efek bisnisnya. Respons bahwa job diterima saja belum membuktikan keberhasilan worker. Periksa efek duplikat ketika retry relevan. Gunakan status job, metrik khusus, atau pemeriksaan hasil melalui proses Bun yang terpisah sesuai skenario.

Amati resource aplikasi, pool dan query database, serta backlog worker bersama hasil k6 untuk menjelaskan bottleneck. k6 browser digunakan ketika perlu mengukur pengalaman browser saat sistem menerima beban; Playwright tetap menguji alur pengguna.

k6 berjalan melalui binary atau container k6. Root script mengorkestrasinya, bukan menjalankannya melalui `bun:test`. Eksekusi beban dilakukan pada environment test yang ditetapkan dengan data terkontrol.

### Profil k6 Foundation (spec 0011)

Model beban, durasi, data, batas resource, dan target ditetapkan [spec 0011](../specs/0011-kapasitas-pemulihan-beban-meningkat/index.md) untuk `GET /api/status` dan `GET /api/readiness`. Setiap profil dijalankan `bun run test:performance:<profil>` (smoke, load, stress, spike, outage, atau soak), dan nilai target hanya dapat diubah lewat spec itu dan `plan.ts`, tidak lewat environment, argumen, atau file lain.

- **Image yang dipin**: k6 dan Bun dipin tag beserta digest indeks di `tests/performance/images.json`, ditarik dengan digest sebelum dipakai, lalu dijalankan dengan `--pull never`. Tag Bun wajib `<engines.bun>-slim`, jadi pin ini diperbarui bersama `engines.bun`. PostgreSQL memakai `foundation-postgres:18-pinned` dari `infrastructure/postgres/pins.json`.
- **Topologi container**: setiap run membuat network sendiri, PostgreSQL 18 dengan credential acak, backend komposisi development di container Bun, dan k6 yang berbagi network namespace backend. Setiap container berbatas CPU, memory, dan jumlah proses, berjalan tanpa capability dengan `no-new-privileges`, dan berlabel `foundation.test=performance` serta `foundation.run=<hex>`. Backend tidak dipublikasikan ke host, PostgreSQL hanya ke port loopback acak, dan tidak ada file `.env` maupun PostgreSQL Compose bersama yang dipakai.
- **Syarat mesin container**: paling sedikit 4 CPU dan 4 GiB memory menurut `docker info`, selain itu run gagal `environment_too_small`. Run juga gagal `environment_busy` bila container lain berlabel `foundation.test` sedang berjalan, jadi jalankan profil tanpa suite lain.
- **Tier**: smoke adalah langkah terakhir tier nyata `test:ci:real` pada setiap push, dan unit modul murni `test:performance:plan` adalah langkah tier cepat `test:ci`. Load, stress, spike, outage, dan soak adalah tier kapasitas manual `bun run test:ci:capacity` (sekitar 110 menit, soak sekitar 61 menit) dengan laporan `bun run test:report:capacity`; tier ini tidak termasuk gate per push.
- **Lokasi bukti**: setiap profil menulis `.local/feature-12/<profil>/result.json`, `k6/summary.json`, `observation.json`, dan `artifact-scan.json`. Bundle tier kapasitas ada di `.local/feature-11/evidence/capacity/`, dan laporannya di `.local/feature-12/report.json` serta `.local/feature-12/report.md`. Laporan per push memuat smoke di bagian *Performance k6*.

Pembersihan manual sesudah run yang terhenti tanpa pembersihan, misalnya karena SIGKILL atau mesin container yang dijalankan ulang:

1. Daftar resource yang tersisa dengan `docker ps -a --filter label=foundation.test=performance --format '{{.Names}} {{.Label "foundation.run"}} {{.Status}}'` dan `docker network ls --filter label=foundation.test=performance --format '{{.Name}} {{.Label "foundation.run"}}'`.
2. Periksa label `foundation.run` setiap resource, dan pastikan tidak ada run lain yang masih berjalan dengan label yang sama.
3. Sesudah Anda tinjau, hapus dengan nama eksplisit, misalnya `docker rm -f foundation-perf-db-<hex>` lalu `docker network rm foundation-perf-net-<hex>`. Folder sementara `foundation-perf-*` di `TMPDIR` milik run yang sama dapat dihapus sesudahnya.

Orkestrasi sendiri tidak pernah menghapus berdasarkan pola nama atau label; ia hanya menghapus nama yang dibuat run itu sesudah penjaga container lulus.

## Workflow pemeriksaan dan CI

Sinkronisasi kontrak mengikuti [aturan OpenAPI/SDK](openapi-sdk.md). Setiap perubahan backend wajib ekspor OpenAPI, validasi, dan generate SDK, meskipun perubahan internal menghasilkan file yang sama. Jalankan build Angular sesudah regenerasi dan uji pemakaian SDK yang terdampak terhadap backend nyata sesuai skenario.

Pengujian kontrak membuktikan bahwa path, parameter, body, status, response, dan autentikasi SDK sesuai perilaku backend untuk operasi yang digunakan. Tambahkan skenario serialisasi array/query, nullable, enum, tanggal, atau upload ketika kontrak menggunakannya. Generated types dan build yang berhasil tidak menggantikan bukti perilaku runtime.

CI menjalankan `api:check` sebelum pemeriksaan frontend yang bergantung pada SDK. Pemeriksaan memvalidasi OpenAPI, meregenerasi SDK, membuktikan hasil yang dapat diulang, dan mendeteksi perbedaan terhadap artefak kandidat, termasuk file baru atau dihapus. OpenAPI atau SDK yang tertinggal membuat pemeriksaan gagal. Suite independen dapat berjalan paralel setelah artefak yang diperlukan tersedia.

Validasi kontrak OpenAPI menggunakan script Bun sesuai [aturan OpenAPI/SDK](openapi-sdk.md), tanpa dependency validator tambahan. Saat checker diimplementasikan, buktikan fixture valid diterima dan pelanggaran aturan wajib ditolak. Hasil checker hanya membuktikan cakupan pemeriksaan project; kelulusan seluruh standar OpenAPI tidak boleh diasumsikan. Build Angular dan pengujian integrasi SDK terhadap backend nyata tetap wajib sesuai dampak perubahan.

Nama script root yang digunakan saat suite diimplementasikan:

| Script | Cakupan |
| --- | --- |
| `test:tooling` | Integration tooling doctor, cleanup port, seleksi worker, dan supervisor proses melalui Bun. |
| `api:sync` | Ekspor backend ke `openapi.json`, validasi, lalu generate SDK Angular secara berurutan. |
| `api:check` | Validasi, reproduksibilitas, dan kesesuaian OpenAPI/SDK dengan sumber kandidat. |
| `test:frontend` | Unit dan integration komponen Angular. |
| `test:unit:server` | Unit backend, worker, dan library server. |
| `test:integration` | Integration server dan database melalui Bun. |
| `test:e2e` | E2E melalui Playwright. |
| `test:e2e:ui` | Playwright dalam mode UI untuk debugging. |
| `test:infrastructure` | Suite infrastruktur PostgreSQL 18 (INFRA-001 sampai INFRA-006); langkah pertama tier nyata `test:ci:real`. |
| `test:database:real` | Integration database pada PostgreSQL 18 terisolasi lewat orkestrasi `tests/orchestration/database-real.ts`; langkah tier nyata. |
| `test:database:migration` | Pengujian migration dari `tests/integration/database/migration.test.ts`; langkah tier nyata. |
| `test:readiness:real` | Alur browser nyata kesiapan (READY-009) melalui Playwright terhadap PostgreSQL 18 terisolasi di Docker serta backend dan frontend yang dijalankan orkestrasi Bun `tests/orchestration/readiness-real.ts`, beserta pemindaian credential pada output dan artefak; langkah tier nyata `test:ci:real`. |
| `test:tooling:real` | Smoke doctor dan serve (TOOL-001 dan TOOL-007) pada PostgreSQL 18 terisolasi di Docker yang mengikuti penjaga READY-009: doctor dengan role backend minimum, `serve` untuk frontend dan backend nyata, alur browser READY-009 dengan `playwright.real.config.ts` terhadap `serve`, shutdown, kegagalan preflight, serta pemindaian credential pada output dan artefak di `.local/feature-2/`; langkah tier nyata `test:ci:real`. |
| `test:scenarios` | Validasi registry `tests/scenarios/*.json` dengan schema tetap spec 0010. |
| `check:test-discovery` | Inventaris file test terhadap tabel pemilik `scripts/lib/test-inventory.ts` serta daftar `playwright test --list` dan `ng test --list-tests`. |
| `check:workflow` | Daftar izin struktur `.github/workflows/application.yml` dan `.github/workflows/capacity.yml`; file workflow lain di folder itu ditolak. |
| `test:gate` | Suite gate `tests/integration/gate/` (GATE-001 sampai GATE-009) dengan fixture yang dibuat saat runtime. |
| `check:security` | Tiga pemindai yang dipin (gitleaks, `bun audit`, actionlint) dengan konfigurasi tetap di `tests/security/`; menulis `.local/feature-11/security.json`. |
| `test:performance:plan` | Unit modul murni k6 (`plan.ts`, `expectations.ts`) dan orkestrasi tanpa Docker nyata (PERF-001 dan PERF-009); langkah tier cepat `test:ci`. |
| `test:performance:smoke` | Smoke k6 pada beban ringan, termasuk `k6 inspect` keenam profil; langkah terakhir tier nyata `test:ci:real`. |
| `test:performance:load` | Load k6 pada beban normal selama 600 detik; langkah tier kapasitas. |
| `test:performance:stress` | Stress k6 dengan beban lebih lalu kembali ke normal; langkah tier kapasitas. |
| `test:performance:spike` | Spike k6 dengan lonjakan beban lebih selama 60 detik; langkah tier kapasitas. |
| `test:performance:outage` | Outage k6: PostgreSQL dihentikan lalu dijalankan lagi pada beban normal; langkah tier kapasitas. |
| `test:performance:soak` | Soak k6 pada beban normal selama 3.600 detik; langkah tier kapasitas. |
| `test:deployment:plan` | Suite statis DEP-001 dan test sinyal orkestrasi DEP-008 di `tests/integration/deployment/` tanpa Docker nyata (spec 0012); langkah tier cepat `test:ci` sesudah `test:performance:plan`. |
| `test:deployment:real` | Orkestrasi `tests/orchestration/deployment-real.ts` (spec 0012): build ketiga image dari salinan input, topologi `deploy/compose.yaml` pada container nyata, check `result.json`, alur browser DEP-006 lewat edge, dan pemindaian artefak di `.local/feature-13/`; langkah tier nyata `test:ci:real` sesudah `test:readiness:real` dan sebelum `test:performance:smoke`. |
| `test:ci` | Tier cepat gate CI tanpa Docker: `bun --no-env-file scripts/gate.ts fast`. |
| `test:ci:real` | Tier nyata gate CI dengan Docker, PostgreSQL 18, dan Chromium: `bun --no-env-file scripts/gate.ts real`. |
| `test:ci:security` | Tier keamanan gate CI: `bun --no-env-file scripts/gate.ts security`, yang menjalankan `check:security`. |
| `test:report` | Laporan gate dari ketiga bundle bukti: `.local/feature-11/report.json` dan `.local/feature-11/report.md`. |
| `test:ci:capacity` | Tier kapasitas manual (spec 0011): `bun --no-env-file scripts/gate.ts capacity`, yang menjalankan load, stress, spike, outage, dan soak berurutan; tidak termasuk gate per push. |
| `test:report:capacity` | Laporan kapasitas dari bundle `.local/feature-11/evidence/capacity/`: `.local/feature-12/report.json` dan `.local/feature-12/report.md`. |
| `test:report:release` | Status kesiapan release (spec 0012) dari bundle `fast`, `real`, `security`, dan `capacity` hasil unduhan artifact CI: `.local/feature-13/release.json` dan `.local/feature-13/release.md`; keluar 0 hanya untuk `ready`. |

Gate CI (spec 0010) terdiri dari tiga tier yang dijalankan `scripts/gate.ts` dan satu laporan. Tabel tier di `scripts/lib/gate.ts` menetapkan langkah, batas waktu, masa tenggang, dan bukti setiap langkah. Workflow `.github/workflows/application.yml` menjalankan setiap push dan pull request dengan empat job: `application` (`bun run test:ci`), `real` (`bun run test:ci:real`), `security` (`bun run test:ci:security`), dan `report` (`bun run test:report`) yang berjalan setelah ketiga job itu, juga ketika salah satunya gagal. Seluruh suite berjalan pada setiap push tanpa seleksi berdasarkan perubahan. Setiap langkah CI adalah script root yang sama dengan yang dapat Anda jalankan lokal; tier nyata membutuhkan Docker, dan tier keamanan membutuhkan Docker serta akses ke registry npm.

Runner tier menjalankan langkah berurutan sebagai `bun --no-env-file run <script>` dengan environment daftar izin, menghapus bukti lama sebelum langkah, berhenti pada langkah pertama yang tidak lulus, lalu menulis bundle `.local/feature-11/evidence/<tier>/` berisi salinan bukti pada path repository aslinya dan `manifest.json` (commit, status bersih, SHA 256 pohon sumber, identitas run CI, versi runtime, checksum input dan output, serta SHA 256 setiap file bukti). Langkah yang memuat testcase dilewati dicatat `skipped` dan membuat tier gagal; Docker yang tidak tersedia tidak pernah membuat tier nyata lulus. File bukti teks dan setiap file folder screenshot yang memuat nilai variable environment sensitif milik proses gate, apa adanya, di-escape XML atau JSON, atau dalam percent encoding, menggagalkan langkah dan tidak disalin. SIGINT, SIGTERM, atau SIGHUP (terminal yang tertutup) menghentikan grup proses langkah, manifest tetap ditulis, dan runner keluar 130, 143, atau 129. Setelah langkah tier cepat atau nyata dihentikan, PID yang masih mendengarkan port 8888 atau 8889 dicatat di `leftoverPorts`.

`test:report` menghitung ulang status setiap check dari manifest dan JUnit di bundle, membedakan `passed`, `failed`, `skipped`, `not_run`, dan `missing_test`, mengikat ketiga tier pada commit, pohon sumber, dan run serta attempt CI yang sama, membuktikan discovery dari JUnit, merangkum `security.json`, mencatat identitas PostgreSQL tier nyata, dan menandai kandidat release. Gate `passed` hanya bila seluruh skenario lulus, ketiga tier lulus, discovery sesuai, ketiga pemindai lulus, dan pengikatan sah; `test:report` keluar 0 hanya untuk gate `passed`. Run lokal pada working tree yang belum masuk commit dapat lulus gate tetapi bukan kandidat release. Di GitHub hanya *Re-run all jobs* yang menghasilkan gate sah. Laporan release di `docs/testing/releases/` tetap ditulis manual dengan menyalin `report.md` run kandidat.

Tier kapasitas (spec 0011) berada di luar gate per push: `TIER_NAMES` tetap `fast`, `real`, dan `security`, dan `test:report` tidak menuntut bundle kapasitas. Workflow `.github/workflows/capacity.yml` hanya dipicu manual (`workflow_dispatch`), menjalankan `bun run test:ci:capacity` lalu `bun run test:report:capacity`, dan mengunggah artifact `capacity-evidence`. Skenario yang semua check nya merujuk script tier kapasitas hanya dihitung `test:report:capacity`, dan `test:scenarios` menolak skenario yang mencampur script tier kapasitas dengan script tier lain. Laporan kapasitas `passed` bila tier kapasitas lulus, seluruh skenario kapasitas lulus, dan bundle terikat pada checkout; kandidat release kapasitas hanya dari run CI bersih dengan event `workflow_dispatch` pada `refs/heads/main`. Laporan release menyalin `report.md` per push dan `.local/feature-12/report.md` kapasitas untuk commit yang sama.

Deployment container (spec 0012) menambah satu langkah pada dua tier per push. `test:deployment:plan` di tier cepat membuktikan bentuk statis Dockerfile, file ignore, pin, `deploy/compose.yaml`, konfigurasi edge, string wajib dokumen, dan fungsi murni orkestrasi. `test:deployment:real` di tier nyata membangun ketiga image dan menjalankan topologi rujukan, lalu menulis `.local/feature-13/result.json` (jenis bukti `deployment`: `schema` 1 dan tepat check `DEPLOYMENT_CHECKS` dalam urutannya), `images.json`, `playwright-deployment.xml`, dan `artifact-scan.json`. `test:report` menyalin status dan check itu ke field `deployment` dan bagian *Deployment* `report.md`, tanpa mengubah status gate. Image hanya dibangun lokal dan tidak didorong ke registry. Prosedur operasi dan pembersihan manual ada di [aturan deployment](deployment.md).

`bun run test:report:release` menghitung ulang laporan per push dan laporan kapasitas dari keempat bundle di `.local/feature-11/evidence/` pada checkout bersih commit kandidat. Identitas CI setiap laporan dibaca dari `candidate.ci` manifest bundle nya, tidak dari variable `GITHUB_*` proses laporan, sehingga bundle per push dari run `push` dan bundle kapasitas dari run `workflow_dispatch` dapat dinilai bersama. Perintah hanya menulis `.local/feature-13/release.json` dan `.local/feature-13/release.md`, dengan status `blocked` bila gate per push atau laporan kapasitas `failed`, `incomplete` bila salah satunya `incomplete`, salah satu laporan bukan kandidat release, bundle tidak berasal dari commit dan pohon sumber checkout, atau image tidak berlabel commit dan pohon sumber itu, serta `ready` hanya tanpa alasan. Bundle dari run lokal tidak mempunyai identitas CI, sehingga statusnya selalu `incomplete`. `grantsDeployment` selalu `false`. Prosedur mengunduh artifact ada di [aturan deployment](deployment.md).

Setiap pekerjaan menjalankan pemeriksaan yang relevan dengan dampaknya. CI perubahan kode menjalankan build atau pemeriksaan tipe yang diperlukan, validasi registry, test area yang berubah, regression terkait, serta E2E alur kritis yang terdampak. Jalankan smoke k6 bila perubahan menyentuh perilaku atau performance yang diukur.

Suite independen dapat berjalan paralel dengan data terisolasi. Jalankan pengujian performance pada environment yang tidak terganggu suite lain agar hasil dapat dibandingkan. Pengujian berdurasi panjang menjadi pipeline tersendiri yang dijalankan sesuai rencana verifikasi, bukan otomatis dipicu untuk setiap edit.

Ketika skenario gagal, cari dan perbaiki penyebabnya sebelum menjalankan ulang pemeriksaan yang terdampak. Catat kegagalan awal dan retry; hasil yang lulus setelah retry tidak boleh menyembunyikan test yang tidak stabil.

## Bukti sebelum production release

Ikuti [aturan keamanan](security.md). Perubahan terkait data persisten membuktikan schema dan privilege sesuai specs, termasuk penolakan query oleh role yang tidak diberi akses. Perubahan autentikasi/otorisasi mencakup skenario negatif lintas pengguna atau role, lifecycle sesi, dan CSRF sesuai model. Input berbahaya, rate limit, upload, serta batas worker diuji ketika masuk cakupan. Catat kontrol yang diuji dan temuan yang belum terselesaikan pada laporan release.

Sebelum production release, jalankan seluruh skenario wajib untuk kandidat release, termasuk regression alur kritis, perubahan migration, dan profil performance yang ditetapkan. Gunakan build dan konfigurasi yang mewakili deployment production. Perbedaan environment harus dicatat, bukan dianggap setara tanpa bukti.

Gunakan [template laporan release](../testing/release-report-template.md) untuk menghasilkan `docs/testing/releases/<identitas-release>.md`. Laporan menghubungkan bukti runner dan artefak CI, tanpa menyimpan token, password, atau data sensitif.

Catat commit atau identitas build, waktu dan run CI, versi runtime serta database, jumlah container, batas resource, pool database, volume data, model beban, target dan hasil aktual, cakupan browser, serta batas mock yang digunakan jika relevan. Sertakan checksum atau identitas OpenAPI, versi generator, bukti regenerasi SDK dari kontrak kandidat, hasil `api:check`, build Angular, dan test kontrak yang relevan.

Seluruh skenario wajib harus memiliki bukti yang valid untuk kandidat release. Perubahan setelah pengujian memerlukan verifikasi ulang area yang terdampak; agent utama menentukan dan mencatat cakupan pengujian ulang berdasarkan dampaknya.

Status kesiapan adalah `ready` ketika bukti wajib lengkap dan memenuhi kriteria, `blocked` ketika skenario wajib gagal atau hasil menunjukkan masalah, dan `incomplete` ketika bukti wajib belum tersedia. Untuk kandidat release, status itu diambil dari `.local/feature-13/release.json` hasil `bun run test:report:release` atas bundle CI commit kandidat, tidak ditulis tangan. Jangan menyatakan siap production dengan skenario wajib yang dilewati, belum dijalankan, atau belum memiliki test.

Jika ada keputusan untuk menerima pengecualian, catat skenario, alasan, dampak, penanggung jawab, dan keputusan pengguna atau pemilik release secara terpisah. Status test tetap mencerminkan hasil sebenarnya. Bukti kesiapan tidak dengan sendirinya memberi izin untuk deploy.

## Tanggung jawab agent

Agent utama menetapkan cakupan verifikasi, ID skenario, batas file test, dan penanggung jawab integrasi sebelum delegasi. Setiap subagent menyertakan test yang relevan untuk bagiannya serta laporan perintah, hasil, skenario yang dibuktikan, dan keterbatasan.

Agent utama menggabungkan hasil, memverifikasi alur lintas aplikasi, dan memastikan laporan tidak menganggap mock development sebagai bukti integrasi nyata. Perubahan registry, konfigurasi runner, fixture bersama, dan orchestration CI memiliki satu penanggung jawab yang ditetapkan.

## Referensi

- [Testing Angular](https://angular.dev/guide/testing).
- [Test runner Bun](https://bun.com/docs/test).
- [Praktik Playwright](https://playwright.dev/docs/best-practices).
- [Web server Playwright](https://playwright.dev/docs/test-webserver).
- [Scenarios k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/).
- [Checks k6](https://grafana.com/docs/k6/latest/using-k6/checks/).
- [Thresholds k6](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
- [Jenis load test k6](https://grafana.com/docs/k6/latest/testing-guides/test-types/).
- [k6 browser](https://grafana.com/docs/k6/latest/using-k6-browser/).
