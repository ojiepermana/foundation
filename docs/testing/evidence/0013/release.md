# Status kesiapan release

Status ini dihitung ulang oleh `bun run test:report:release` dari bundle `fast`, `real`, `security`, dan `capacity` di `.local/feature-11/evidence/` pada checkout commit kandidat. Laporan per push dan laporan kapasitas tidak ditulis ulang.

## Status

Status release: `incomplete`.

Status `ready` berarti bukti wajib lengkap dan lulus untuk kandidat ini, dan tidak memberi izin deploy; keputusan deploy dicatat terpisah oleh pemilik release.

Identitas run dibaca dari manifest bundle yang ditulis run itu sendiri dan tidak diverifikasi ke GitHub, dan paket OS image tidak dipindai pemindai kerentanan.

## Alasan

- `capacity_incomplete` (incomplete): laporan kapasitas berstatus incomplete.
- `gate_not_candidate` (incomplete): laporan per push bukan kandidat release.
- `capacity_not_candidate` (incomplete): laporan kapasitas bukan kandidat release.
- `candidate_differs` (incomplete): commit atau pohon sumber checkout tidak ada, atau salah satu manifest bundle berasal dari commit atau pohon sumber lain.

## Kandidat

| Aspek | Nilai |
| --- | --- |
| Commit checkout | ad1dbf24b6605ac2802712c0723fd500475e0159 |
| Pohon sumber checkout | 5512cee2da4d6e6dc0a8e9c0085cba50dd7187c2ccf1d2a846ce644c9d43af58 |
| Memberi izin deploy (grantsDeployment) | false |
| Dibuat | 2026-10-06T03:42:08.310Z |

## Run per push

| Aspek | Nilai |
| --- | --- |
| Status gate | passed |
| Kandidat release | Kandidat release: bukan (not\_clean fast, not\_clean real, not\_clean security, not\_ci fast, not\_ci real, not\_ci security, not\_ci) |
| Identitas run dari manifest | run lokal tanpa identitas CI |

## Run kapasitas

| Aspek | Nilai |
| --- | --- |
| Status laporan kapasitas | incomplete |
| Kandidat release | Kandidat release: bukan (gate\_not\_passed, not\_clean, not\_ci) |
| Identitas run dari manifest | run lokal tanpa identitas CI |

## Image

| Image | Tag | Image ID | Revision | Pohon sumber | Sama dengan checkout |
| --- | --- | --- | --- | --- | --- |
| frontend | foundation-frontend:deploy-ffc747069e44 | sha256:9ba569a4e879497815200357eb52061ebfc55b1156673e3c70c511e8b7cc4be2 | ad1dbf24b6605ac2802712c0723fd500475e0159 | 5512cee2da4d6e6dc0a8e9c0085cba50dd7187c2ccf1d2a846ce644c9d43af58 | ya |
| backend | foundation-backend:deploy-ffc747069e44 | sha256:09cc3fffc7b9818c8c5a09f41d99fe5ec9d510d6f9c4f2190d0cf36dca5bdc23 | ad1dbf24b6605ac2802712c0723fd500475e0159 | 5512cee2da4d6e6dc0a8e9c0085cba50dd7187c2ccf1d2a846ce644c9d43af58 | ya |
| migrate | foundation-migrate:deploy-ffc747069e44 | sha256:ee9d9c48444318ec84aaed1f7b002ded3d26f4b87cf5fe8589421c8290dfd92c | ad1dbf24b6605ac2802712c0723fd500475e0159 | 5512cee2da4d6e6dc0a8e9c0085cba50dd7187c2ccf1d2a846ce644c9d43af58 | ya |

Image dibangun lokal dari root monorepo oleh `test:deployment:real`, tidak didorong ke registry, dan bukti ini bukan izin deploy.
