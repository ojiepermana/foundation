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
| Commit checkout | 4c0b44f8df8b947ad313542bde11c8297fcc7135 |
| Pohon sumber checkout | fe7865ae48c6dd3e12c4b4a9f9dda413b4f3964a504980e7abd9f896430f5bcd |
| Memberi izin deploy (grantsDeployment) | false |
| Dibuat | 2026-10-05T20:29:05.382Z |

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
| frontend | foundation-frontend:deploy-0dbea2d8761b | sha256:36e4250653e74f6099be23562b273fdd3b10a960c8936abf2216a7d04cea09dc | 4c0b44f8df8b947ad313542bde11c8297fcc7135 | fe7865ae48c6dd3e12c4b4a9f9dda413b4f3964a504980e7abd9f896430f5bcd | ya |
| backend | foundation-backend:deploy-0dbea2d8761b | sha256:536e32567062be140702aadd4c1bedd833db661435c655da33cd0c7cd9790809 | 4c0b44f8df8b947ad313542bde11c8297fcc7135 | fe7865ae48c6dd3e12c4b4a9f9dda413b4f3964a504980e7abd9f896430f5bcd | ya |
| migrate | foundation-migrate:deploy-0dbea2d8761b | sha256:6bc9cd27491672904b440206eb6e1b46797fb2a2f9064b78acbe09c155b04178 | 4c0b44f8df8b947ad313542bde11c8297fcc7135 | fe7865ae48c6dd3e12c4b4a9f9dda413b4f3964a504980e7abd9f896430f5bcd | ya |

Image dibangun lokal dari root monorepo oleh `test:deployment:real`, tidak didorong ke registry, dan bukti ini bukan izin deploy.
