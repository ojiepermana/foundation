# Rationale: SDK yang sesuai kontrak backend

## Context

> ⚠️ Premise note: scope fitur 9 meminta "setiap perubahan backend menjalankan regenerasi meskipun output identik". Kewajiban itu tidak dapat dipaksakan di mesin pengembang tanpa hook yang mudah dilewati, sehingga bentuk yang dapat dibuktikan adalah gerbang CI yang selalu meregenerasi tanpa deteksi perubahan, ditambah kewajiban `api:sync` pada aturan proyek. Scope juga menyebut "adapter fitur Angular", padahal belum ada fitur yang memakai SDK sampai fitur 10. Membuat adapter tanpa pemakai hanya menambah kode mati; kerangka yang tepat adalah menetapkan dan menegakkan batas adapter, memasang konfigurasi aplikasi, dan menyediakan harness backend nyata, lalu adapter pertama dibangun fitur 10.

Fitur 4 dan 8 sudah menyediakan `api:openapi`, `api:validate`, `sdk:generate`, `api:sync`, dan `api:check`. SDK standalone hasil `@ojiepermana/angular:sdk` 22.1.14 tersimpan di `apps/frontend/sdk/` bersama manifest generator, `tsconfig.app.json` memasukkan `sdk/**/*.ts`, dan alias `@sdk` sudah ada. Spec 0008 menyerahkan drift SDK, manifest, dan bukti request/response SDK terhadap backend nyata kepada fitur ini. Workspace frontend Angular 22.2 (`apps/frontend/`), backend Elysia 1.4.30, dan satu `package.json` root; tidak ada data persisten.

Pemeriksaan kode saat ini menemukan celah nyata:

- `scripts/check-api.ts` menjalankan `api:sync` dua kali langsung di checkout, lalu membandingkan snapshot sebelum dan sesudah. Ketika drift ada, artefak tersimpan sudah tertimpa saat pesan gagal muncul, dan pesannya tidak menyebut file mana pun. Aturan proyek meminta pembandingan terhadap artefak kandidat dengan output terisolasi atau checkout CI bersih.
- Generator mengurutkan operasi dengan `localeCompare` tanpa locale eksplisit. Probe menunjukkan urutan ekspor di `public-api.ts` dan method service berbeda antara proses `en_US` dan `cs_CZ`, sehingga SDK yang dihasilkan pengembang dengan locale lain akan dianggap drift oleh CI.
- `scripts/lib/frontend-bundle.ts` melarang `@sdk` di seluruh `apps/frontend/src/app`. Aturan yang benar untuk kerangka UI fitur 7 kini menghalangi pola konsumsi yang diwajibkan aturan Angular (`<fitur>-api.ts` memakai SDK).
- `app.config.ts` belum memasang `provideHttpClient()` maupun `provideApiConfiguration(...)`, dan belum ada test yang menjalankan kode SDK hasil generate terhadap backend nyata. Build yang lulus hanya membuktikan tipe, bukan perilaku HTTP.
- Kewajiban regenerasi meskipun hasil identik serta pemilik tunggal artefak saat pekerjaan paralel hanya tertulis di aturan, tanpa bukti yang dapat diperiksa.

Kekuatan yang membatasi: aturan OpenAPI/SDK menetapkan generator, mode, lokasi, dan larangan mengedit SDK; aturan testing meminta bukti runtime terhadap backend nyata dan runner yang sesuai area; scope tidak memilih teknologi baru. Fitur 10 akan menjadi konsumen pertama dan membutuhkan pola yang sudah jelas, termasuk cara mengetik body error 429 dan 503.

## Options considered

### Perkuat tooling yang ada

`api:check` meregenerasi dari keadaan kosong di workspace sementara dua kali dan membandingkan pohon file secara utuh dengan checkout; `sdk:generate` mempin locale; batas impor `@sdk` diubah menjadi aturan adapter; harness Vitest melalui Angular CLI memulai backend nyata untuk test kesesuaian. (basis: `docs/rules/openapi-sdk.md`, `docs/rules/testing.md` bagian workflow CI, helper `workspace()` spec 0008)

**Pros**:
- Command, generator, lokasi artefak, dan urutan `api:sync` tetap; APP-003 tetap berlaku.
- Pemeriksaan hanya membaca checkout dan menyebut setiap file yang berbeda.
- Kode SDK yang diuji adalah kode yang dikompilasi Angular, dengan `HttpClient` dan konfigurasi aplikasi yang sama.
- Tanpa dependency baru.

**Cons**:
- Daftar input regenerasi harus dirawat.
- `test:frontend` selalu memulai satu backend Bun.
- Harness bergantung pada perilaku `runnerConfig` Angular 22.2 yang memanggil `globalSetup` dua kali.

### Pertahankan pemeriksaan di tempat dan buktikan konsumsi lewat Playwright

`api:check` tetap meregenerasi di checkout, ditambah pemeriksaan `git status` untuk file baru; kesesuaian dibuktikan oleh halaman development sementara yang memanggil SDK dan diuji Playwright melalui proxy.

**Pros**:
- Bukti melewati browser, proxy, dan backend nyata sekaligus.
- Perubahan `check-api.ts` kecil.

**Cons**:
- Pemeriksaan tetap menimpa checkout dan bergantung pada git, padahal APP-003 menjalankan `api:check` di workspace tanpa `.git`.
- Membutuhkan halaman atau route uji di aplikasi sebelum fitur 10 ada, yang menjadi permukaan produk tanpa kebutuhan.
- Locale tetap memengaruhi hasil generate.

### Validasi runtime response di adapter

Setiap adapter memvalidasi body response terhadap schema yang diturunkan dari `openapi.json` dengan validator runtime.

**Pros**:
- Menangkap response yang menyimpang saat aplikasi berjalan, bukan hanya saat test.

**Cons**:
- Membutuhkan validator baru atau schema yang ditulis tangan, sehingga muncul salinan kontrak kedua yang dilarang aturan.
- Menambah ukuran bundle dan biaya setiap request untuk backend milik tim sendiri yang kontraknya sudah diperiksa checker dan test.
- Tidak menyelesaikan drift artefak maupun locale.

## Rationale

Celah terbesar ada di `api:check`: pemeriksaan yang menimpa artefak tersimpan tidak dapat melaporkan apa yang berbeda, dan pemeriksaan yang bergantung pada keadaan awal folder SDK membutuhkan aturan khusus untuk file tanpa pemilik. Regenerasi dari kosong di workspace sementara membuat satu aturan cukup untuk semua kasus: pohon file checkout harus sama dengan fungsi murni dari input. Run kedua di workspace yang sama membuktikan generator stabil terhadap outputnya sendiri, termasuk jalur manifest. Karena APP-003 menjalankan `api:check` di workspace tanpa `.git`, solusi berbasis git tidak dapat dipakai.

Pin locale dipilih karena urutan generator tidak dapat diubah dari proyek, sedangkan probe membuktikan locale proses mengubah file SDK. Nilai `en_US.UTF-8` dipilih, bukan `C`, karena ICU dapat memetakan `C` ke varian POSIX yang urutan huruf besarnya berbeda, sehingga hasil macOS dan Linux berisiko berbeda; nilai eksplisit menghindari pemetaan itu.

Harness Vitest dipilih karena satu satunya konsumen SDK sebelum fitur 10 adalah test, dan probe membuktikan `HttpClient` Angular 22.2 dengan backend `fetch` bawaan di Vitest jsdom dapat memanggil backend Bun nyata. Bukti proxy sudah ada di APP-002 (`request.get('/api/status')` melalui port 8889), dan alur browser penuh menjadi kewajiban fitur 10. Batas impor ditegakkan di checker yang sudah dijalankan CI, sehingga pola adapter tidak hanya bergantung pada review.

## Keputusan agent atas delegasi pemilik

Pemilik proyek mendelegasikan keputusan desain fitur ini ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"). Tidak ada manusia selama run. Percakapan desain dijalankan sebagai pertimbangan internal: setiap pertanyaan dicatat dengan pilihan, rekomendasi, dan pilihan akhir. Semua keputusan berikut diambil oleh agent pada 2026-10-03 atas delegasi tersebut, tanpa konfirmasi manusia.

**Tahap kebutuhan**
1. **Cakupan inti.** Pilihan: (a) gerbang drift, pola konsumsi, dan bukti kesesuaian; (b) gerbang drift saja; (c) termasuk adapter dan halaman pertama. Dipilih (a): scope meminta bukti request/response nyata dan fitur 10 membutuhkan pola; (c) menyerobot spec 0006.
2. **Cara `api:check` membandingkan.** Pilihan: (a) workspace sementara, regenerasi dari kosong, bandingkan dengan checkout; (b) regenerasi di checkout dengan snapshot (kode lama); (c) regenerasi di checkout lalu `git status`. Dipilih (a): hanya membaca checkout, tanpa git, dan file tanpa pemilik tertangkap oleh kesamaan pohon. Pilihan kedua: (b), ditolak karena menimpa artefak tersimpan.
3. **Dua run.** Pilihan: (a) dua run berurutan di workspace yang sama; (b) dua workspace kosong terpisah; (c) satu run. Dipilih (a): membuktikan hasil dari kosong sama dengan checkout dan generator stabil terhadap outputnya sendiri. Pilihan kedua: (b), yang tidak menguji jalur manifest.
4. **Locale generator.** Pilihan: (a) `LC_ALL=en_US.UTF-8` pada `sdk:generate`; (b) `LC_ALL=C`; (c) preload yang mengganti `localeCompare`; (d) hanya dicatat. Dipilih (a); (c) menjadi cadangan bila CI Linux membuktikan (a) tidak berlaku.
5. **Format laporan.** Pilihan: (a) baris `added`, `changed`, `removed` per path lalu baris akhir tetap; (b) pesan tetap saja (kode lama); (c) diff isi. Dipilih (a): scope meminta deteksi file baru, berubah, dan dihapus, dan path artefak bukan data sensitif; (c) ditolak karena membanjiri log.
6. **Regenerasi pada setiap perubahan backend.** Pilihan: (a) gerbang CI yang selalu meregenerasi tanpa cache atau filter path, ditambah kewajiban `api:sync` di aturan; (b) hook git sebelum commit; (c) `serve` mengawasi file backend lalu menjalankan `api:sync`; (d) file stamp berisi hash sumber backend. Dipilih (a). (b) mudah dilewati dan menambah tooling; (c) berebut dengan editor dan menulis artefak di tengah development; (d) menimbulkan konflik merge di setiap perubahan backend.
7. **Pemilik artefak saat paralel.** Pilihan: (a) aturan proses, agent utama sebagai pemilik tunggal, dengan `api:check` sebagai penangkap; (b) file lock pada `api:sync`; (c) worktree per subagent. Dipilih (a): lock membutuhkan pemulihan lock basi seperti `scripts/lib/invocation.ts` untuk risiko yang sudah tertangkap CI.

**Tahap model data**
8. Tidak ada data persisten; scope fitur 9 menyatakan tidak membutuhkan perubahan database, sehingga pertanyaan schema menurut `AGENTS.md` tidak berlaku.

**Tahap stack dan tool**
9. **Runner bukti kesesuaian.** Pilihan: (a) Vitest melalui Angular CLI dengan `HttpClient` nyata dan backend nyata dari `globalSetup`; (b) Playwright melalui halaman uji; (c) `bun:test` yang menjalankan SDK lewat Angular JIT; (d) Vitest browser mode. Dipilih (a): kode dikompilasi Angular yang sama dan tanpa dependency baru. (d) membutuhkan package baru; (c) memakai pipeline kompilasi lain.
10. **Cakupan harness.** Pilihan: (a) satu `runnerConfig` untuk semua test frontend; (b) konfigurasi test dan script terpisah. Dipilih (a): biaya backend sekitar setengah detik, dan test adapter fitur 10 dapat memakainya. Pilihan kedua: (b), bila waktu atau keandalan run frontend kelak terganggu.
11. **Tingkat rujukan.** `sources`: rujukan proyek dan praktik bernama tanpa tautan, karena tidak ada tautan yang diverifikasi web pada run ini. Penawaran skill dan MCP tidak dijalankan karena tidak ada tool baru.

**Tahap antarmuka**
12. **Konfigurasi aplikasi.** Pilihan: (a) `provideHttpClient()` dan `provideApiConfiguration('')` di `app.config.ts`; (b) fungsi provider di `core/http/`; (c) mengandalkan default Angular tanpa provider. Dipilih (a), sesuai aturan Angular proyek dan cukup satu baris; (c) ditolak karena aturan meminta konfigurasi eksplisit.
13. **Batas impor SDK.** Pilihan: (a) `@sdk` hanya di `app.config.ts` dan `features/<fitur>/<fitur>-api.ts`, ekspor ulang tipe saja, ditegakkan `check:frontend:bundle`; (b) `@sdk` boleh di seluruh `features/`; (c) hanya dokumentasi. Dipilih (a).
14. **Bentuk adapter.** Pilihan: (a) class `@Service()` dengan method `Observable` memakai service tag SDK dan pemetaan error ke tipe fitur; (b) fungsi berbasis `Promise`; (c) adapter yang menyimpan state `httpResource` atau `rxResource`. Dipilih (a): `@Service()` direkomendasikan Angular 22 dan dipakai SDK, `Observable` dapat dibatalkan, dan state tetap di component atau store. `httpResource` ditolak karena memakai URL tulisan tangan.
15. **Tipe body error.** Pilihan: (a) body error yang dibutuhkan UI dideklarasikan sebagai model bernama sehingga SDK mengeluarkan tipenya, lalu adapter mempersempit `HttpErrorResponse.error` lewat field pembeda; (b) interface error tulisan tangan di fitur; (c) semua error diperlakukan umum. Dipilih (a); (b) melanggar larangan DTO manual.
16. **Adapter contoh di fitur ini.** Pilihan: (a) tidak ada, adapter pertama di fitur 10; (b) adapter status tanpa pemakai UI. Dipilih (a) untuk menghindari kode mati.
17. **Isi bukti kesesuaian.** Pilihan: (a) bentuk request lewat `HttpTestingController` dengan `appConfig`, respons nyata lewat `DevelopmentService` dan `FoundationApi`, serta semantik 404 dan status 0; (b) validator schema generik terhadap `openapi.json`; (c) kesamaan body saja. Dipilih (a); (b) ditunda sampai operasi bertambah.

**Tahap keamanan**
18. **Secret.** `api:check` hanya menyalin daftar input tanpa `.env`, berjalan dengan `--no-env-file` dan environment minimum, workspace `mkdtemp` dihapus; harness backend tanpa `DATABASE_URL`; test sentinel memeriksa artefak. Pilihan kedua, menyalin seluruh checkout kecuali yang diabaikan git, ditolak karena bergantung pada git dan `.gitignore`.
19. **Output.** Hanya teks tetap, path artefak yang di escape bila tidak biasa, dan paling banyak 200 baris per daftar.

**Tahap kegagalan**
20. Batas 120 detik per `api:sync`; pilihan kedua 300 detik.
21. Entry selain file biasa di folder SDK dilaporkan `removed` tanpa diikuti atau dibuka.
22. SIGINT atau SIGTERM menghentikan child, menghapus workspace, dan keluar dengan exit 130 atau 143.
23. Backend harness yang tidak siap dalam 10 detik dihentikan sebelum error dilempar; port dicoba ulang paling banyak tiga kali.
24. `globalSetup` yang dipanggil dua kali oleh Angular 22.2 berbagi satu backend lewat `Symbol.for('foundation.sdkContractBackend')` dengan hitungan pemakai, dibuktikan probe.

**Tahap pemeriksaan silang** (keputusan 25 sampai 40 menutup temuan pemeriksaan silang oleh model lain; diambil agent pada 2026-10-03 atas delegasi pemilik, tanpa konfirmasi manusia, dan menggantikan bagian keputusan 13, 19, 20, 22, dan 23 yang bertentangan)
25. **Deklarasi `ProvidedContext`.** Pilihan: (a) satu file `apps/frontend/vitest-provided-context.d.ts` di luar `src/`, diawali `import type {} from 'vitest'`, dicakup `tsconfig.spec.json` dan `tsconfig.contract.json`; (b) deklarasi identik di file spec dan file setup; (c) `src/vitest-provided-context.d.ts`. Dipilih (a): satu sumber tipe untuk kedua program. (c) ikut masuk program `tsconfig.app.json` dan pemindaian checker bundle. Keputusan ini menggantikan deklarasi di file spec saja, yang membuat `typecheck:contract` gagal dengan TS2345 begitu file setup ikut diperiksa.
26. **Penghentian tahap `api:check`.** Pilihan: (a) child dimulai `detached` sebagai pemimpin process group, SIGTERM lalu SIGKILL dikirim ke group, `groupAlive` dari `scripts/lib/process-identity.ts` ditunggu sampai `false`, baru direktori dihapus; (b) SIGKILL ke proses `bun run` saja (rancangan awal); (c) menelusuri pohon proses lewat parent pid. Dipilih (a). (b) meninggalkan cucu `node ng.js` yang terus menulis ke workspace (dibuktikan pemeriksa silang); (c) rapuh terhadap proses yatim yang berpindah induk.
27. **Batas waktu yang dapat diuji.** `runApiCheck({ root, syncTimeoutMs })` di `scripts/lib/api-check.ts`, dengan CLI tipis yang memberi 120.000 ms. Variable environment ditolak karena spec ini tidak menambah variable environment.
28. **Bukti siklus proses.** AC-10 dan `SDK-010` ditambahkan agar invariant 1 dapat dibuktikan: SIGTERM, SIGINT, batas waktu, cucu mati, dan `TMPDIR` kosong.
29. **Urutan pembandingan.** Pilihan: (a) run pertama terhadap run kedua lebih dulu, lalu checkout hanya bila keduanya sama; (b) checkout lebih dulu; (c) mencetak kedua daftar. Dipilih (a): perbedaan antar run membuat pembandingan dengan checkout tidak bermakna, dan satu daftar dengan satu pesan akhir tetap mudah dibaca. Hasil run pertama disalin ke `run1/` karena run kedua menimpa workspace.
30. **Pemformat laporan.** `formatDiffLines` menjadi pemilik format: kelompok `added`, `changed`, `removed`, batas 200 per jenis, dan baris luapan `... and <n> more <jenis>`. Jenis ikut ditulis agar baris luapan tidak ambigu bila lebih dari satu kelompok meluap.
31. **Pembacaan artefak.** `readArtifacts` hanya memakai `lstat` dan tidak membuka file; `diffArtifacts` menghitung hash hanya untuk pasangan file berukuran sama. Setiap segmen path sampai `apps/frontend/sdk` diperiksa `lstat`, dan nama di luar ASCII cetak keluar sebagai `\uXXXX`, termasuk DEL, kontrol C1, U+2028, U+2029, dan override bidi yang tidak di escape `JSON.stringify`.
32. **Symlink di input.** Pilihan: (a) `verbatimSymlinks: true` dan tolak target absolut atau target yang keluar dari root checkout; (b) `cp` bawaan; (c) tolak semua symlink. Dipilih (a). (b) menulis ulang symlink relatif menjadi path absolut ke checkout sehingga workspace dapat menjangkau `.env` asli; (c) terlalu ketat untuk symlink yang sah di dalam repo.
33. **Arti `removed`.** `removed` berarti ada di checkout dan tidak dibuat regenerasi. File tanpa pemilik dihapus manual oleh pemilik artefak, dan itu bukan penghapusan paksa yang dilarang invariant 6. Pilihan untuk `.DS_Store`: (a) dilaporkan seperti file lain; (b) daftar abaikan sempit. Dipilih (a), konsisten dengan invariant 2 dan tanpa aturan khusus.
34. **Checker bundle.** `scripts/check-frontend-bundle.ts` menangkap error dan mencetak hanya pesan tetap (`FrontendBundleError`) atau `Frontend bundle check failed.`; akar pemeriksaan menjadi `apps/frontend/src` agar `main.ts` ikut diperiksa; file diperiksa dalam urutan code unit; tabel *Bentuk impor SDK* menetapkan bentuk per jenis file; ekspor lokal binding impor `@sdk` ditolak. Ekspor nilai lewat konstanta atau nilai kembali method dicatat sebagai keterbatasan yang diperiksa review, karena melacak aliran nilai di luar cakupan checker berbasis deklarasi.
35. **Harness.** Nilai kedua `sdkContractClosedUrl` diberikan harness untuk status 0, karena spec test berjalan di bundle browser tanpa `node:net`. Timeout 1 detik per polling, tiga percobaan total dengan exit atau `error` child dihitung satu percobaan, stdio child `ignore`, state bersama berupa promise yang diisi sinkron, `process.once('exit')` sebagai upaya terakhir, kesiapan yang menuntut child hidup dan body persis, serta `sdkContractBackendEnvironment` yang diekspor sebagai fungsi murni. Kontrol negatif `DATABASE_URL=not-a-url` dipilih karena `createDatabasePool` melempar `Invalid database URL` untuk nilai itu sehingga backend gagal start bila nilai bocor; sentinel penghitung koneksi tidak membedakan karena pool `Bun.SQL` tidak terhubung sebelum query.
36. **Model error bernama.** `ProbeUnavailable` pada 503 masuk AC-5 dan `SDK-005` agar klaim kontrak adapter butir 6 punya regresi otomatis. User story 2 diubah menjadi hasil yang dibuktikan fitur ini (batas impor, kontrak tertulis, harness).
37. **Helper test.** `workspace({ artifacts = true } = {})`, `run(dir, script, { timeout = 30000, env } = {})`, dan `runBun(dir, args, { env, guard, timeout = 10000 } = {})`, semuanya memakai `runProcessGroup`.
38. **Bukti Linux untuk pin locale.** Fixture locale dijalankan di kontainer Linux sebelum AC-7 dinyatakan terbukti; bila tidak dapat dijalankan, dicatat `not_run`. Cadangan preload tetap di Follow-up.
39. **Spec 0007 AC-5 dan ukuran bundle.** AC-5 spec 0007 kini diartikan untuk halaman dan component; kenaikan bundle karena barrel `@sdk` dicatat di Consequences dan diukur ulang saat build.
40. **Kelengkapan gerbang.** File checker bundle masuk `tsconfig.contract.json`, JUnit yang disalin ke bukti tanpa atribut `hostname`, dan perintah JUnit SDK diawali `mkdir -p .local/feature-9` karena Bun tidak membuat direktori induk `--reporter-outfile`.

**Tahap review kode** (keputusan 41 sampai 48 menutup temuan [review kode](../../reviews/2026-10-03-main-sdk-contract.md) dan temuan reviewer lain pada model berbeda; diambil agent atas delegasi pemilik tertanggal 2026-10-03, dikerjakan 2026-10-04, tanpa konfirmasi manusia. Keputusan 41 mempersempit keputusan 32, dan keputusan 42 serta 43 melengkapi keputusan 34)
41. **Symlink input yang diterima.** Pemeriksaan leksikal `resolve(dirname(link), target)` terbukti terlalu longgar: `../node_modules/../.env` sampai ke `.env` checkout lewat symlink `node_modules` di workspace, `up/../..` di samping `up -> ..` naik dua tingkat di atas workspace, dan `apps` yang berupa symlink membuat `apps/backend` tersalin dari luar checkout. Pilihan: (a) hanya target relatif kanonik (`..` hanya di awal dan tetap di dalam root, lalu nama biasa tanpa `..` dan tanpa `node_modules`) dan setiap segmen induk input harus direktori nyata menurut `lstat`; (b) `realpath` pada salinan sesudah `cp` untuk setiap symlink; (c) tolak semua symlink. Dipilih (a): diputuskan sebelum apa pun tersalin, hasil leksikal sama dengan tujuan fisik di workspace, dan symlink kanonik yang sah tetap diterima. (b) harus mengikuti link di workspace yang memuat symlink ke checkout dan baru menolak sesudah salinan dibuat; (c) tetap terlalu ketat seperti pada keputusan 32. Bentuk tidak kanonik yang sebenarnya tetap di dalam root, misalnya `../scripts/../.env`, ikut ditolak; tidak ada symlink seperti itu di input checkout saat ini.
42. **Path pada pesan checker bundle.** Path ketiga pesan berpath memakai `formatArtifactPath` dari `scripts/lib/api-artifacts.ts`, aturan yang sama dengan baris laporan `api:check`. Nama biasa tetap byte identik, sedangkan nama dengan newline atau karakter kontrol tidak dapat menambah baris, termasuk baris `::error::` yang dibaca GitHub Actions sebagai perintah workflow.
43. **Symlink pada checker bundle.** Checker membaca file tanpa mengikuti link, sedangkan build Angular mengikutinya. Pilihan: (a) tolak setiap symlink dengan pesan tetap `Frontend bundle check does not follow the symlink <path>.`; (b) ikuti link lalu periksa targetnya; (c) error umum `Frontend bundle check failed.`. Dipilih (a): pengembang tahu path mana yang harus diganti, tanpa penanganan siklus dan target di luar `src`. (c) tidak menyebut file. Aturan yang sama berlaku untuk `dist`, karena aset yang berupa symlink juga lolos dari pemindaian credential; build Angular tidak membuat symlink. Symlink pertama menurut urutan code unit path dilaporkan sebelum aturan impor atau pemindaian aset.
44. **Timer tunggu.** `runProcessGroup` mode `pipe` dan harness (`waitForEnd` serta jeda polling kesiapan) membersihkan timer begitu yang ditunggu selesai, bukan memakai `unref()`, karena polling `groupGone` harus tetap menahan proses selama group dihentikan. Tanpa ini proses pemanggil, termasuk setiap run `test:frontend`, tertahan sekitar 5 detik sesudah teardown.
45. **Abort saat child dimulai.** Sesudah listener `abort` dipasang, `runProcessGroup` memeriksa `signal.aborted` sekali lagi. Abort yang tiba antara `spawn()` dan event `spawn` sebelumnya hilang, sehingga SIGINT atau SIGTERM pada jeda itu tidak menghentikan tahap `api:check`.
46. **Start harness yang gagal.** Promise start yang ditolak menghapus state `globalThis` bila state itu masih miliknya. Vitest tidak memanggil teardown untuk setup yang melempar error, sehingga tanpa ini setiap setup berikutnya di proses yang sama (mode watch, runner yang hidup lama) langsung gagal dengan error lama.
47. **Bukti cabang pertahanan tanpa parameter test baru.** Kegagalan `rm` dibuktikan dengan `sdk:generate` workspace yang meninggalkan folder tanpa izin tulis, `Process group did not stop` dengan `ps` pengganti di `PATH` proses probe yang selalu melaporkan group hidup, dan `SDK contract backend did not stop` dengan `ChildProcess.prototype.kill` yang dibuat tidak bekerja selama test. Pilihan lain, parameter test untuk `groupAlive` dan masa tenggang, ditolak agar permukaan `runProcessGroup` dan `startSdkContractBackend` tetap seperti tabel API surface; harganya dua test sekitar 10 detik karena masa tenggang 5 detik dijalani penuh.
48. **Kontrak CLI `api:check`.** Test membaca script `api:check` di `package.json` dan nilai `syncTimeoutMs` yang diteruskan `scripts/check-api.ts` ke `runApiCheck` lewat AST TypeScript. Konstanta tetap di `scripts/check-api.ts` sesuai baris *Batas waktu* pada Value sourcing, sehingga tidak ada export baru.

## Pemeriksaan silang

Spec ini diperiksa silang oleh model lain secara read only pada 2026-10-03. Pemeriksa mengembalikan 26 temuan (7 major, 19 minor), sebagian tumpang tindih. Semua temuan major diterima dan ditutup lewat keputusan 25 sampai 40 serta perubahan pada `index.md`. Agent mengulang tiga klaim pemeriksa dengan probe sendiri (lihat *Bukti pemeriksaan*); angka ukuran bundle 654,09 kB ke 675,94 kB berasal dari pemeriksa dan belum diulang agent.

### Cross check

Bagian usulan yang ditolak atau diganti, masing masing dengan alasan satu baris:
- Menerima `export type * from '@sdk'` dan `export type * as ns from '@sdk'` di adapter: ditolak, karena mengalirkan semua tipe SDK termasuk class service ke component, sedangkan daftar bernama tetap dapat direview.
- Aturan checker yang menolak `HttpClient` atau string `/api/` di adapter: ditolak, karena heuristik teks mudah positif palsu; user story 2 diubah dan butir 2 kontrak adapter diperiksa review.
- Test terpisah untuk port harness yang sudah terpakai: ditolak sebagai kasus sendiri, karena harness memilih port sendiri dan jalurnya sama dengan child yang keluar sebelum siap, yang diuji dengan perintah yang keluar berkode 1.
- Batas symlink terhadap "pohon input": diganti batas root checkout, karena workspace hanya berisi salinan input sehingga target relatif di dalam root hanya menjangkau workspace.
- Asersi memori untuk file sparse 2 GiB: diganti bukti tidak pernah dibuka dengan mode `000`, karena pengukuran memori di test rapuh dan file tanpa pasangan tidak dibaca sama sekali.
- Baris luapan tanpa jenis (`... and <n> more`): diganti `... and <n> more <jenis>` agar tidak ambigu bila lebih dari satu kelompok meluap.

## Bukti pemeriksaan

Pemeriksaan berikut dijalankan agent pada 2026-10-03 di salinan workspace dalam scratchpad sesi, tanpa menulis file repo. Semua proses backend yang dimulai probe sudah dihentikan, dan `git status` tetap bersih.

- **Regenerasi dari kosong**: di workspace yang hanya berisi `package.json`, `scripts/`, `apps/backend/`, `apps/frontend/angular.json`, `sdk.config.json`, `.prettierrc`, `.editorconfig`, dan symlink `node_modules`, `bun --no-env-file run api:sync` tanpa `openapi.json` dan tanpa folder SDK menghasilkan `openapi.json` dan sembilan file SDK beserta manifest yang byte identik dengan artefak tersimpan. Path yang bertambah di workspace hanya `openapi.json` dan `apps/frontend/sdk/`.
- **Format oleh Angular CLI**: tanpa `apps/frontend/.prettierrc`, lima file SDK berbeda dari artefak tersimpan. Konfigurasi prettier dan versi prettier yang dipin adalah input generator.
- **Locale**: Node 24.21.0 memberi urutan `getChart`, `getCode`, `getHelp` pada `en-US` dan `getCode`, `getHelp`, `getChart` pada `cs-CZ`; tanpa `LC_ALL`, dengan `LC_ALL=C`, dan dengan `en_US.UTF-8` hasilnya `en-US` di macOS. Fixture dengan operasi `getChart` dan `getHelp` menghasilkan `public-api.ts` dan `services/development.service.ts` yang berbeda antara proses `en_US.UTF-8` dan `cs_CZ.UTF-8`. Dengan `LC_ALL=en_US.UTF-8` di script `sdk:generate`, kedua locale induk menghasilkan folder SDK yang byte identik. Perilaku di Linux belum diperiksa.
- **Manifest**: route uji dengan model `ProbeAvailable` dan `ProbeUnavailable` membuat file model, operasi, dan entri manifest; setelah route dihapus, generator mencetak `DELETE` untuk ketiga file dan folder SDK kembali sama dengan artefak tersimpan, sedangkan `notes.txt` yang tidak tercantum di manifest tetap ada. File tanpa entri manifest pada path `models/probe-unavailable.ts` dengan isi berbeda membuat `sdk:generate` exit 1 dengan pesan `Refusing to overwrite unmanaged SDK output`, dan hash seluruh folder SDK tidak berubah.
- **Model untuk status error**: response 503 yang merujuk model bernama diekspor sebagai `$ref` ke `#/components/schemas/ProbeUnavailable`, lulus `api:validate`, dan generator mengeluarkan `models/probe-unavailable.ts` serta ekspor tipenya di `public-api.ts`. Generator mengeluarkan model untuk setiap entri `components.schemas`, tidak hanya response 2xx.
- **Build**: baris bertipe salah yang ditambahkan ke `sdk/models/development-status.ts` membuat `ng build` gagal dengan `TS2322` pada file itu walau file tidak diimpor aplikasi, karena `tsconfig.app.json` memasukkan `sdk/**/*.ts`.
- **HttpClient**: `provideHttpClient()` di `@angular/common` 22.2.0 memasang `FetchBackend` sebagai backend bawaan dan `FetchFactory` opsional. Di Vitest 4.1.11 dengan jsdom melalui `ng test`, `DevelopmentService.getDevelopmentStatus$Response()` ke backend Bun nyata memberi 200, `url` `http://127.0.0.1:<port>/api/status`, `Content-Type` `application/json;charset=utf-8`, dan body `{"status":"ok"}`; `FoundationApi.invoke` memberi body yang sama; `rootUrl` dengan `/nope` memberi `HttpErrorResponse` 404 dengan body `{"error":"Not found"}`; port 9 memberi `HttpErrorResponse` status 0. Dengan `appConfig` dan `provideHttpClientTesting()`, request yang tertangkap adalah `GET /api/status` dengan `Accept: application/json` dan body `null`.
- **Harness**: `runnerConfig` dengan `test.globalSetup` dan `project.provide` bekerja bersama reporter JUnit di `angular.json`. Tanpa penanganan khusus, setup dipanggil dua kali dan dua backend dimulai; dengan state bersama di `globalThis` melalui `Symbol.for`, satu backend dimulai, dipakai test, dan dihentikan sesudah run. Augmentasi `ProvidedContext` milik `vitest` harus terlihat oleh kompilasi spec; deklarasi di file spec itu sendiri bekerja untuk `ng test`, tetapi tidak untuk program `tsconfig.contract.json` yang ikut memeriksa file setup (keputusan 25).
- **Deklarasi bersama (probe agent saat menutup pemeriksaan silang)**: di salinan scratchpad dengan opsi compiler `tsconfig.contract.json`, file setup bertipe `TestProject` yang memanggil `project.provide('sdkContractBackendUrl', ...)` gagal dengan TS2345 (parameter bertipe `never`) tanpa file deklarasi, dan lulus `tsc` ketika `vitest-provided-context.d.ts` dengan `import type {} from 'vitest'` dicantumkan. Program bergaya `tsconfig.spec.json` yang memakai `inject('sdkContractBackendUrl')` juga lulus dengan file yang sama.
- **Process group (probe agent saat menutup pemeriksaan silang)**: di Bun 1.4.2, `spawn` dari `node:child_process` dengan `detached: true` untuk `bun --no-env-file run outer`, yang memanggil `bun run inner` lalu `sh` dengan cucu `sleep`, dihentikan dengan SIGTERM ke group; `groupAlive` menjadi `false` dan pid cucu tidak lagi ada. Tidak ada proses probe yang tersisa.
- **Symlink verbatim (probe agent saat menutup pemeriksaan silang)**: `cp` dari `node:fs/promises` di Bun dengan `recursive: true` dan `verbatimSymlinks: true` menyalin `rel-link` sebagai `target.txt` dan `env-link` sebagai `../../.env`, tanpa menulis ulang menjadi path absolut.
- **Lingkungan `.env`**: `bun run` yang memanggil script bersarang `bun --no-env-file` tidak meneruskan nilai `.env` ke proses terdalam.
- **CI**: `.github/workflows/application.yml` memicu job pada setiap `push` dan `pull_request` tanpa filter path, dan `test:ci` menjalankan `api:check` sebelum build dan test frontend. Laporan fitur 8 mencatat `test:ci` lokal sekitar 42 detik, sedangkan job CI dibatasi 15 menit.

## References

**Project sources**:
- `AGENTS.md` (build approach Tracer Bullet, koordinasi subagent, pemilik artefak OpenAPI/SDK).
- `docs/rules/openapi-sdk.md` (generator, mode standalone, manifest, `api:sync`, `api:check`, kepemilikan artefak, konsumsi lewat `<fitur>-api.ts`).
- `docs/rules/angular.md` (konfigurasi `provideHttpClient()` dan `provideApiConfiguration(...)`, adapter fitur, larangan DTO manual).
- `docs/rules/testing.md` (Vitest melalui Angular CLI, pengujian kontrak terhadap backend nyata, `api:check` di CI).
- `docs/rules/security.md` (SDK bukan validasi keamanan server, tanpa credential di bundle atau log).
- Spec 0001 (route `GET /api/status`, SDK standalone awal), spec 0006 (konsumen pertama, fitur 10), spec 0007 (AC-5 halaman root tanpa SDK), spec 0008 (checker, `REQUIRED_OPERATIONS`, helper `workspace()`, Follow-up drift untuk fitur 9).
- `docs/scope/scope.md` fitur 9 (Selesai ketika dan Data).
- Package terpasang: `@ojiepermana/angular` 22.1.14 (`sdk/schematics/sdk/index.js`, `sdk/src/parser/ir.js`, `sdk/src/emit/models.js`), `@angular/common` 22.2.0 (`fesm2022/_module-chunk.mjs`), `@angular/build` 22.2.0 (`src/builders/unit-test/runners/vitest/plugins.js`), Vitest 4.1.11, Bun 1.4.2, Node 24.21.0.
- Skill `angular-developer` (`references/creating-services.md`, `references/http-client.md`).

**Practices & standards**:
- Build yang dapat direproduksi: artefak hasil generate dibandingkan byte demi byte dari input yang sama dan lingkungan yang dipin.
- Pemeriksaan hanya baca dengan output terisolasi untuk gerbang CI.
- Anti corruption layer (lapisan adapter) antara kode generate dan kode fitur.
- Pengujian kontrak terhadap komponen nyata, bukan mock, untuk perilaku HTTP.
