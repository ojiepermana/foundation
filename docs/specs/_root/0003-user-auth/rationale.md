# Rationale User, auth dan passkey

## Context
Foundation lokal dengan single package dan Bun native, berdasarkan keputusan pengguna tanggal16September2026.

## Options considered
Library tambahan untuk auth/queue dan ORM dibandingkan pendekatan native. Pengguna memilih Bun.SQL, Bun.password, custom Redis Streams; kriptografi passkey serta SMTP tetap memakai library.

## Rationale
Mengikuti kontrak runtime dan library upstream, mengurangi driver tambahan, sambil menerima tanggung jawab testing untuk session dan antrean.

## References
* [Dokumentasi resmi](https://simplewebauthn.dev/docs/packages/server)
