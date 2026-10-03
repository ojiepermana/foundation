# Review, main, 2026-10-03

**Reviewed by**: GPT-6 (author on gpt-6-sol)
**Scope**: 14 files, uncommitted
**Verdict**: Changes requested

## Summary

Follow-up memperbaiki urutan download key, pemeriksaan fingerprint, import, dan instalasi repo RPM; prosedur update development sekarang membatalkan cache paket dengan `--no-cache`. Perbaikan cache sesuai tujuan dan didukung perbandingan build yang dicatat. Namun, pemeriksaan RPM masih menerima paket tanpa signature, sehingga temuan keamanan sebelumnya belum tertutup meskipun test urutan perintah lulus.

## Major

### 🟠 RPM tanpa signature tetap lolos sebelum instalasi, `infrastructure/postgres/Dockerfile:37`

**Problem**: `rpmkeys --checksig /tmp/pgdg-repo.rpm` memeriksa digest dan signature yang tersedia, tetapi exit 0 tidak mewajibkan keberadaan signature. Baris 38 kemudian menjalankan `rpm -i`, yang juga menerima RPM tanpa signature pada base ini. Memindahkan kedua perintah tersebut setelah import key belum memastikan repo RPM ditandatangani key PGDG yang diizinkan. [Manual rpmkeys](https://rpm.org/docs/4.20.x/man/rpmkeys.8) menjelaskan bahwa checksig memeriksa digest dan signature yang terkandung dalam paket.

**Why it matters**: Pengganti artefak distribusi dapat menyediakan RPM unsigned dengan digest internal yang valid, sementara public key PGDG asli tetap disediakan agar fingerprint lolos. Payload dan scriptlet RPM pengganti masih dapat dipasang/dijalankan sebagai root. Ini pelanggaran tujuan AC-1 dan security model spec 0002. Ini bukan dugaan perilaku RPM: reviewer membuktikan penerimaan paket unsigned dalam container sementara tanpa mount atau volume development.

Reproduksi yang dijalankan reviewer:

```sh
docker run --rm --user 0 --entrypoint /bin/bash oraclelinux:10-slim -c '
set -eu
microdnf -y --nodocs install rpm-sign >/dev/null
curl -fsSL --proto =https -o /tmp/repo.rpm https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-aarch64/pgdg-redhat-repo-latest.noarch.rpm
curl -fsSL --proto =https -o /tmp/key https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-AARCH64-RHEL
rpmkeys --import /tmp/key
rpmkeys --checksig /tmp/repo.rpm
rpmsign --delsign /tmp/repo.rpm
rpmkeys --checksig /tmp/repo.rpm
printf "unsigned_checksig_exit=%s\n" "$?"
rpm -i /tmp/repo.rpm
printf "unsigned_install_exit=%s\n" "$?"
rpm -q pgdg-redhat-repo
'
```

Hasil aktual: signed package menghasilkan `digests signatures OK`; setelah `--delsign`, hasilnya `digests OK`, `unsigned_checksig_exit=0`, `unsigned_install_exit=0`, dan `pgdg-redhat-repo-42.0-69.rhel10PGDG.noarch` terpasang. Container otomatis dihapus. Reproduksi memakai RPM resmi yang signature-nya dihapus; reviewer tidak membuat payload berbahaya. Image kandidat memakai RPM 4.19.1.1.

**Suggested fix**: Sebelum instalasi, wajibkan signature benar-benar ada, valid, dan berasal dari key PGDG yang diizinkan; jangan memakai exit status checksig saja sebagai bukti signature. Tambahkan pengujian negatif INFRA-002 yang menjalankan jalur verifikasi nyata terhadap RPM tanpa signature, signature tidak valid, dan penandatangan yang tidak diizinkan, lalu membuktikan instalasi/payload/scriptlet belum dijalankan. Test teks pada `tests/integration/infrastructure/postgres.test.ts:281` hanya mengunci urutan dan larangan flag; semua assertion tersebut tetap lulus pada implementasi yang menerima RPM unsigned ini.

## Minor

### 🟡 Decision spec masih memerintahkan pemeriksaan setelah instalasi, `docs/specs/0002-infrastruktur-postgresql-development/index.md:43`

**Problem**: Bagian Decision masih menyatakan fingerprint dicocokkan setelah repo RPM terpasang, sedangkan tabel Value sourcing dan Security model sudah diubah menjadi pemeriksaan sebelum instalasi.

**Why it matters**: Spec yang mengikat implementasi memberikan dua urutan keamanan yang bertentangan dan dapat mengarahkan perubahan berikutnya kembali ke urutan lama.

**Suggested fix**: Selaraskan paragraf Decision dengan alur key terpisah, fingerprint, import, kewajiban signature valid dari key yang diizinkan, lalu instalasi.

## Strengths

- Pengambilan key terpisah memindahkan pemeriksaan fingerprint ke sebelum payload repo RPM dipasang, sehingga alur kepercayaan lebih tepat.
- README, rules, spec, dan verify memakai `build --pull --no-cache`; bukti refresh mencatat base yang sama, status cache langkah paket, serta versi paket aktual. Perintah `up -d --wait` tetap menyertai pembaruan pada rules.
- JUnit kandidat mencatat 17 pass, 0 fail, 0 skip, 150 assertions; bukti arm64/amd64 menjelaskan bahwa amd64 memakai emulasi dan tidak mengklaim eksekusi native atau kesiapan production.

## Test coverage

Sinyal test **configured**. Reviewer membaca diff, suite, spec, dokumentasi, dan artefak kandidat; suite penuh tidak dijalankan ulang pada review ini. Test baru berguna sebagai pengaman urutan teks, tetapi tidak membuktikan penolakan input RPM yang tidak tepercaya. Probe Docker nyata di atas membuktikan celah unsigned; cakupannya adalah penerimaan checksig dan instalasi, bukan eksekusi scriptlet berbahaya. `git diff --check` lulus. Perbaikan cache didukung artefak perbandingan yang tersedia; reviewer tidak mengulang build dev atau menyentuh data development.
