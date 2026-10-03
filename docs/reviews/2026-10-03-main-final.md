# Review, main, 2026-10-03

**Reviewed by**: GPT-6 (author on gpt-6-sol)
**Scope**: 16 files, uncommitted (`git diff HEAD` plus untracked files; base `df102ca89430fae556376a086d6d44d3728fbc6c`)
**Verdict**: Changes requested

## Summary

Kandidat memperbaiki urutan kepercayaan RPM, mewajibkan signature melalui `_pkgverify_level all`, memeriksa ID key PGDG, dan membatalkan cache saat refresh paket development. Bukti unsigned RPM, build kedua arsitektur, dan perbandingan cache mendukung perbaikan temuan sebelumnya; Decision spec juga sudah konsisten. Jalur penolakan signer yang baru masih belum memiliki pengujian perilaku, dan satu kalimat laporan tetap menyebut jumlah test lama sebagai hasil sekarang. Review ini tidak menemukan bukti bahwa implementasi terbaru masih menerima RPM unsigned.

## Major

### 🟠 Penolakan signer yang tidak diizinkan belum diuji, `tests/integration/infrastructure/postgres.test.ts:300`

**Problem**: Probe negatif hanya menghapus signature lalu menjalankan perintah RPM yang ditulis ulang dalam test. Probe tidak menjalankan pemeriksaan `expected_key_id` dan `grep` milik Dockerfile, tidak menyediakan RPM dengan signature rusak, dan tidak menyediakan RPM yang signature-nya valid dari key lain yang sudah dipercaya RPM. Test pada baris 281 hanya memeriksa keberadaan serta urutan teks `grep`; ia tidak membuktikan bahwa mismatch menggagalkan build sebelum instalasi. Bukti build arm64/amd64 hanya melewati cabang signer yang benar.

**Why it matters**: `_pkgverify_level all` dan pembatasan signer mempunyai tanggung jawab berbeda: signature valid dari key lain yang dipercaya RPM masih perlu ditolak oleh pembatasan PGDG. Cabang keamanan baru pada `infrastructure/postgres/Dockerfile:41` belum memiliki bukti negatif, meskipun AC-1, Security model, dan laporan menyatakan signature harus berasal dari PGDG. Misalnya, hilangnya efek gagal pada cabang mismatch dapat lolos dari seluruh test yang ada. Ini celah coverage keamanan, bukan klaim eksploitasi yang sudah terbukti. Review sebelumnya juga secara eksplisit meminta kasus signature tidak valid serta signer yang tidak diizinkan.

**Suggested fix**: Tambahkan pengujian negatif terisolasi yang menjalankan jalur verifikasi aktual kandidat terhadap signature rusak dan terhadap signature valid dari key uji lain yang telah diimpor ke trust store RPM. Kasus kedua harus lolos pemeriksaan kriptografis RPM tetapi ditolak oleh pemeriksaan identitas PGDG. Buktikan paket/payload serta penanda scriptlet belum dipasang/dijalankan, dan jalur PGDG sah tetap diterima. Gunakan potongan verifikasi produksi yang sama atau build kandidat dengan penggantian input fixture, agar test tidak hanya membuktikan salinan perintah. Catat hasil INFRA-002 aktual setelah perbaikan.

## Minor

### 🟡 Laporan masih menyebut 16 sebagai hasil sekarang, `docs/testing/0002-postgresql-development-infrastructure.md:40`

**Problem**: Kalimat “Scope dan checklist sekarang mencatat 16 hasil lulus berdasarkan run baru” bertentangan dengan hasil kandidat pada bagian Hasil pemeriksaan, scope, checklist, dan JUnit: 18 test, 156 assertion.

**Why it matters**: Pembaca laporan memperoleh dua jumlah yang diklaim berlaku sekarang, padahal pembetulan konsistensi bukti merupakan salah satu tujuan perubahan ini.

**Suggested fix**: Nyatakan 16 sebagai hasil historis pada tanggal/kandidat sebelumnya, kemudian sebutkan hasil kandidat sekarang 18 test dengan 156 assertion, atau hapus klaim waktu “sekarang” dari paragraf sejarah tersebut.

## Strengths

- Fingerprint diperiksa sebelum import dan instalasi; checksig maupun instalasi memakai mode signature wajib. Probe dengan signature resmi yang dihapus memberi bukti nyata terhadap kasus yang lolos pada implementasi sebelumnya.
- Perintah refresh sinkron pada README, rules, spec, dan checklist. Bukti membedakan langkah paket `CACHED` dengan `DONE` pada base yang sama, tanpa mengklaim adanya perubahan versi ketika keduanya masih 18.6.
- Salinan image evidence cocok dengan `.local/feature-3/image.json`; JUnit lokal dan salinannya sama-sama mencatat 18 test, 156 assertion, 0 failure, 0 skipped. Riwayat 16/17 test pada review terdahulu jelas merupakan kandidat terdahulu.
- Scope tetap in-progress sambil menunggu review. Bukti membedakan arm64 native, amd64 melalui emulasi, dan kesiapan production yang incomplete.

## Test coverage

Sinyal test **configured**. Reviewer membaca seluruh 16 file kandidat, diff, rules yang relevan, spec, serta kedua review sebelumnya. `git diff --check` lulus; pemeriksaan baca-saja terhadap JSON dan XML membuktikan kesesuaian salinan dengan artefak lokal. Suite penuh, build, dan probe Docker tidak dijalankan ulang pada review ini; hasil runtime yang disebut berasal dari artefak yang dibaca, bukan eksekusi reviewer.

INFRA-002 sekarang mencakup keberadaan/urutan perintah, penolakan unsigned oleh mode RPM wajib, build positif dan identitas image. Penolakan signer yang salah serta signature rusak belum dibuktikan oleh test kandidat. Artefak cache dan reproduksibilitas mencatat hasil yang mendukung perbaikan, namun reviewer tidak mengulang build tersebut. Bukti daemonless 4 pass/12 skip ditandai historis; suite terbaru memeriksa mode tanpa daemon melalui run bersarang sehingga angka historis itu tidak ditafsirkan sebagai jumlah kandidat sekarang. Tidak ada perubahan schema, role, API, atau frontend dalam kandidat ini.
