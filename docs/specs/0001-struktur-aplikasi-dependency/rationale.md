# Alasan struktur aplikasi dan dependency

## Context

Scope fitur 4 meminta frontend dan backend yang dapat dibuild dengan satu manifest root. Saat ini manifest root hanya menjalankan doctor, serve, dan test tooling, sedangkan workspace aplikasi belum ada. Supervisor sudah menunjuk lokasi entry aplikasi dan proxy yang belum tersedia. Tanpa keputusan batas fitur ini, hasil build dapat disalahartikan sebagai bukti alur database atau kesiapan deployment.

Aturan proyek mewajibkan setiap perubahan backend menghasilkan ulang OpenAPI dan SDK. Pada saat yang sama scope memisahkan tooling kontrak lengkap dan pemakaian SDK sebagai fitur 8 dan 9. Spec ini harus menjelaskan prasyarat kontrak yang diperlukan sekarang tanpa mengklaim alur lintas aplikasi sudah selesai.

## Options considered

### Kerangka nyata beserta kontrak minimum

Bangun frontend, backend, satu route development, serta jalur ekspor dan generate minimum. Kelebihannya adalah build dan perubahan backend pertama memenuhi aturan kontrak. Kekurangannya adalah sebagian pekerjaan fitur 8 dan 9 dimajukan. (basis: `docs/rules/development-workflow.md`, `docs/rules/openapi-sdk.md`)

### Kerangka aplikasi tanpa jalur kontrak

Bangun kedua aplikasi dan tunda status selesai sampai tooling kontrak fitur 8 dan 9 hadir. Kelebihannya adalah pembagian implementasi tetap mengikuti urutan awal scope. Kekurangannya adalah backend yang sudah berubah belum memenuhi gate `api:sync` dan fitur 4 belum bisa ditutup. (basis: `docs/scope/scope.md` fitur 4, `docs/rules/openapi-sdk.md`)

### Komposisi saja tanpa runtime

Tulis konfigurasi dan entry yang bisa diperiksa tipenya tanpa route atau halaman yang dapat dibuka. Kelebihannya adalah pekerjaan awal lebih kecil. Kekurangannya adalah syarat aplikasi dapat dijalankan dan bukti batas proses tidak terpenuhi. (basis: `docs/scope/scope.md` fitur 4, `docs/rules/development-commands.md`)

## Rationale

Pilih kerangka nyata beserta kontrak minimum karena supervisor yang ada sudah mengharapkan aplikasi, sedangkan aturan sinkronisasi tidak memberi pengecualian untuk backend pertama. Route statis lokal memberi pembuktian HTTP tanpa menciptakan tabel atau mengklaim database siap. Angular 22.2 dipilih Anda dan dipasangkan dengan rilis library 22.1.14; versi TypeScript, Node, Bun, Elysia, serta plugin harus mengikuti matriks dan peer dependency yang benar saat implementasi, bukan angka yang disimpulkan dari rilis CLI saja. (basis: `docs/rules/angular.md`, `docs/rules/elysia.md`, package Angular dan library yang diperiksa pada References)

## References

**Project sources**: `AGENTS.md`, `docs/scope/scope.md` fitur 4, `docs/rules/development-workflow.md`, `docs/rules/openapi-sdk.md`, `docs/rules/angular.md`, `docs/rules/elysia.md`, `docs/rules/development-commands.md`, `docs/rules/security.md`.

**Practices & standards**: Peer dependency yang kompatibel, lockfile yang dapat direproduksi, komposisi aplikasi tanpa efek saat import, dan pemisahan resource dari ekspor kontrak.

**Links**: [Angular CLI di npm](https://www.npmjs.com/package/@angular/cli), [library Angular pilihan di npm](https://www.npmjs.com/package/@ojiepermana/angular), [Elysia di npm](https://www.npmjs.com/package/elysia), [plugin OpenAPI Elysia di npm](https://www.npmjs.com/package/@elysia/openapi), [instalasi Bun](https://bun.sh/docs/installation).
