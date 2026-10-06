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
| Commit checkout | 4aa511abb738b43b06276091f18937aca10eedbd |
| Pohon sumber checkout | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 |
| Memberi izin deploy (grantsDeployment) | false |
| Dibuat | 2026-10-06T12:30:30.151Z |

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
| frontend | foundation-frontend:deploy-473534d66af6 | sha256:035a9474d81a5c1498c7f413d6bce999e063b45f05bd8802d9d612a5919399e7 | 4aa511abb738b43b06276091f18937aca10eedbd | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 | ya |
| backend | foundation-backend:deploy-473534d66af6 | sha256:b90e3e3d117e27c86f113d3eb32191322060ef373177a1638ac16cc3fe4c2556 | 4aa511abb738b43b06276091f18937aca10eedbd | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 | ya |
| migrate | foundation-migrate:deploy-473534d66af6 | sha256:5cdee0ab065082a19b1698de86ef9978ce102a00cd9ed39bf81ba8c258d8bcf5 | 4aa511abb738b43b06276091f18937aca10eedbd | 4cfa7461363c455bb3a2e2f67c2a6a18be5f8347e3cb9ffb662dda392027b480 | ya |

Image dibangun lokal dari root monorepo oleh `test:deployment:real`, tidak didorong ke registry, dan bukti ini bukan izin deploy.
