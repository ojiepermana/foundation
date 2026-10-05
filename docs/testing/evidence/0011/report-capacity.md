# Laporan kapasitas

Laporan ini dihitung ulang oleh `bun run test:report:capacity` dari bundle bukti tier kapasitas. Hanya status `passed` dihitung lulus. Tier kapasitas dijalankan manual dan tidak mengubah status gate per push.

## Kandidat

| Aspek | Nilai |
| --- | --- |
| Status laporan kapasitas | passed |
| Commit | 34e905dff01b66fc2b9cd51f6e6686b5008c247c |
| Pohon sumber | 7185cf7b7a9f5a3cedff10c6a8ac0a452ceb284e1bbba380f2d9c33f33ca1514 |
| Run CI job laporan | run lokal tanpa identitas CI |
| Dibuat | 2026-10-05T06:32:43.655Z |

Kandidat release: bukan (`not_clean`, `not_ci`)

## Pengikatan

Pengikatan sah.

## Tier kapasitas

| Tier | Status | Langkah passed | Run attempt | Environment |
| --- | --- | --- | --- | --- |
| capacity | passed | 5 dari 5 | - | darwin arm64, Bun 1.4.2, Node 24.21.0 |

### Langkah tier capacity

| Langkah | Status | Durasi | Alasan |
| --- | --- | --- | --- |
| test:performance:load | passed | 686.4 detik | - |
| test:performance:stress | passed | 757.3 detik | - |
| test:performance:spike | passed | 464.8 detik | - |
| test:performance:outage | passed | 249.7 detik | - |
| test:performance:soak | passed | 3725.8 detik | - |

### Checksum input

| Path | capacity |
| --- | --- |
| .github/workflows/application.yml | edda79e565b79b9a5d204e9aaf57df86d3eae11adb723f0bb31796e3eb0fe164 |
| apps/frontend/sdk/ | b7fde5e16f8c7b653b6b76cdb9d6e508017b02b44e237839bfdab38615b0a96e |
| bun.lock | e74e16b34cde3c1a76d17328f5da63da16614409318218231e320d0a2e1fcc3f |
| infrastructure/postgres/pins.json | 63fe647f7df56c5e94a0e5cb6483d845eeea548dcfdbe991c50e95c234f438c4 |
| openapi.json | e583aa33ea689908d8188f5b1338a441475c9a434e97589e0b47366da95f0c00 |
| package.json | 1d085a593c0410aa6897be8cab7914b3fd141b22ebfa7ed4c5e9d52a655f8475 |
| tests/scenarios/ | 89bd88f9fff53b5cf010ee9b541ef769c4baf6624730775728192315903332e4 |
| tests/security/actionlint.yaml | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| tests/security/exceptions.json | 0c1de1a21eb6b25b59576015d5fa5c9fbb2fd081a192ac0c221c37f5e562271f |
| tests/security/gitleaks.toml | b2218eefd2c12a1a2f23d36735ac4aaae6965d917965a8ed5881d0a4e8669376 |
| tests/security/scanners.json | 311f56a9f4cfc6e801069ac407fec4c37b55c2988f5ed7dc92248c17db243581 |

### Checksum output

| Path | capacity |
| --- | --- |
| apps/frontend/dist/frontend/ | 747ea3fc972f80b102cefab6fd0184c279add2edd2764e4c5f8b301c395b0683 |
| dist/backend/index.js | 7f0d92c719ae41ec6ba4b8f928626d84ed65731384c022fba224cfbdf1b7ec40 |

## Hasil per skenario

5 skenario tier kapasitas: 0 failed, 0 missing_test, 0 not_run, 0 skipped, 5 passed.

| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |
| --- | --- | --- | --- | --- | --- |
| PERF-003 | AC-4, AC-5, AC-6; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | command test:performance:load tests/performance/profiles/load.ts; profil k6 load | ya | passed | exit code 0, passed |
| PERF-004 | AC-4, AC-5, AC-6, AC-8; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | command test:performance:stress tests/performance/profiles/stress.ts; profil k6 stress | ya | passed | exit code 0, passed |
| PERF-005 | AC-4, AC-5, AC-6, AC-8; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | command test:performance:spike tests/performance/profiles/spike.ts; profil k6 spike | ya | passed | exit code 0, passed |
| PERF-006 | AC-4, AC-5, AC-6, AC-7; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | command test:performance:outage tests/performance/profiles/outage.ts; profil k6 outage | ya | passed | exit code 0, passed |
| PERF-007 | AC-4, AC-5, AC-6; docs/specs/0011-kapasitas-pemulihan-beban-meningkat/index.md | command test:performance:soak tests/performance/profiles/soak.ts; profil k6 soak | ya | passed | exit code 0, passed |

## Performance k6

Disalin dari `result.json` setiap profil k6 di bundle tier kapasitas yang SHA 256 nya cocok dengan manifest. Angka ini berlaku untuk environment dan batas bukti yang tercatat, bukan perkiraan kapasitas produk. Latency dalam milidetik.

### Profil load

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Tier dan langkah | capacity, test:performance:load |
| Bukti | .local/feature-11/evidence/capacity/.local/feature-12/load/result.json |
| Model beban | warmup ramp 60 detik N, steady constant 600 detik N; satu iterasi satu request |

#### Beban target dan aktual

| Scenario | Endpoint | Fase | Laju rencana per detik | Detik | Iterasi rencana | Iterasi aktual | Laju aktual per detik | Ambang iterasi | Status ambang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status\_warmup | status | warmup | 0 ke 1000 | 60 | 30000 | 29996 | 499.93 | tanpa target | - |
| readiness\_warmup | readiness | warmup | 0 ke 50 | 60 | 1500 | 1499 | 24.98 | tanpa target | - |
| status\_steady | status | steady | 1000 | 600 | 600000 | 600001 | 1000.00 | count\>=599400 | lulus |
| readiness\_steady | readiness | steady | 50 | 600 | 30000 | 30001 | 50.00 | count\>=29970 | lulus |

| Total | Nilai |
| --- | --- |
| Iterasi | 661497 |
| Request HTTP | 661497 |
| Dropped iterations | 0 |
| VU maksimum | 220 |
| Scenario mulai sesudah T0 (ms) | 1 |

#### Latency terhadap target

| Endpoint | Fase | Hasil | Jumlah | p50 | p95 | p99 | max | Target | Status target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status | warmup | all | 29996 | 0.18 | 0.68 | 1.52 | 34.45 | tanpa target | - |
| readiness | warmup | available | 1499 | 1.10 | 3.49 | 5.55 | 8.67 | tanpa target | - |
| readiness | warmup | busy | 0 | - | - | - | - | tanpa target | - |
| readiness | warmup | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | steady | all | 600001 | 0.19 | 0.61 | 1.73 | 49.69 | p(95)\<10, p(99)\<25 | lulus |
| readiness | steady | available | 29985 | 1.14 | 3.10 | 4.62 | 16.79 | p(95)\<25, p(99)\<50 | lulus |
| readiness | steady | busy | 16 | 1.61 | 14.42 | 43.38 | 50.62 | tanpa target | - |
| readiness | steady | unavailable | 0 | - | - | - | - | tanpa target | - |

#### Rasio readiness

| Fase | 200 tersedia | 429 sibuk | 503 tidak tersedia | Rasio tersedia | Target rasio | Status target |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 1499 | 0 | 0 | 1 | tanpa target | - |
| steady | 29985 | 16 | 0 | 0.999 | rate\>=0.98 | lulus |

#### Thresholds

18 dari 18 threshold lulus.

#### Resource, pool, dan check pengamatan

| Container | CPU rata rata (persen satu CPU) | CPU maksimum | Memory rata rata (MiB) | Memory maksimum (MiB) | Pertumbuhan memory (MiB) | Restart | OOM | Byte stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| postgres | 2.03 | 3.92 | 44.91 | 46.07 | - | - | - | - |
| backend | 10.73 | 15.15 | 26.10 | 29.61 | - | 0 | tidak | 0 |
| k6 | 42.77 | 56.58 | 209.94 | 282.30 | - | - | - | - |

| Pool | Nilai |
| --- | --- |
| Sesi foundation\_backend maksimum | 5 |
| Sesi foundation\_backend aktif maksimum | 1 |
| Sesi client maksimum | 6 |
| Sampel berhasil | 675 |
| Sampel gagal | 0 |

| Check | Aturan | Aktual | Lulus |
| --- | --- | --- | --- |
| backend\_running | sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled | {"running":true,"restarts":0,"oomKilled":false} | ya |
| backend\_output | stderr 0 byte; stdout tepat baris listening lalu Backend stopped | {"stderrBytes":0,"stdoutExpected":true} | ya |
| backend\_memory\_peak | memory backend maksimum \<= 128 MiB | 29.61 | ya |
| backend\_cpu\_mean | rata rata CPU backend pada steady \<= 50 persen satu CPU | 11.10 | ya |
| pool\_sessions | setiap sampel mencatat paling banyak 5 sesi foundation\_backend | 5 | ya |
| pool\_non\_idle | setiap sampel mencatat paling banyak 1 sesi foundation\_backend yang tidak idle | 1 | ya |
| generator\_cpu | rata rata CPU k6 pada setiap fase terukur \<= 240 persen satu CPU | 44.32 | ya |
| generator\_memory | memory k6 maksimum \<= 1638 MiB | 282.30 | ya |
| observation\_coverage | sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg\_stat\_activity | \[\] | ya |
| clock\_offset | selisih jam container dengan host \<= 1000 ms sebelum T0 dan sesudah k6 keluar | {"before":7,"after":7} | ya |

#### Environment

| Aspek | Nilai |
| --- | --- |
| Host | Darwin 27.0.0 arm64 |
| CPU host | Apple M1 Max, 10 CPU |
| Memory host (byte) | 34359738368 |
| Mesin container | versi server 29.8.0, Docker Desktop, 10 CPU, memory 8319504384 byte |
| Container lain yang berjalan | 7 |
| CI | tidak |
| Image k6 | grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 |
| Image Bun | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 |
| PostgreSQL | foundation-postgres:18-pinned, image id sha256:0470b120c2ebef56573f3f66861a6a50bea3e6daf9c819c37c598fecf6ff5557, base oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6, versi 18.6 |
| Batas resource postgres | cpus 2, memory 1g, shmSize 128m, pids 256 |
| Batas resource backend | cpus 1, memory 512m, pids 256 |
| Batas resource k6 | cpus 3, memory 2g, pids 512 |
| Batas resource inspect | cpus 1, memory 512m, pids 512 |
| Pool | max 5, connectionTimeout 3 detik |
| Data | 1 migration |
| Selisih jam (ms) | sebelum T0 7, sesudah k6 7 |

#### Batas bukti

| No | Batas bukti |
| --- | --- |
| 1 | Alur yang diukur adalah diagnostik komposisi development, \`GET /api/status\` dan \`GET /api/readiness\`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis. |
| 2 | Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13. |
| 3 | k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata. |
| 4 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |
| 5 | Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama. |
| 6 | Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh. |

### Profil stress

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Tier dan langkah | capacity, test:performance:stress |
| Bukti | .local/feature-11/evidence/capacity/.local/feature-12/stress/result.json |
| Model beban | warmup ramp 60 detik N, ramp ramp 120 detik O, hold constant 300 detik O, rampdown ramp 60 detik N, settle constant 10 detik N, recover constant 180 detik N; satu iterasi satu request |

#### Beban target dan aktual

| Scenario | Endpoint | Fase | Laju rencana per detik | Detik | Iterasi rencana | Iterasi aktual | Laju aktual per detik | Ambang iterasi | Status ambang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status\_warmup | status | warmup | 0 ke 1000 | 60 | 30000 | 29995 | 499.92 | tanpa target | - |
| readiness\_warmup | readiness | warmup | 0 ke 50 | 60 | 1500 | 1500 | 25 | tanpa target | - |
| status\_ramp | status | ramp | 1000 ke 4000 | 120 | 300000 | 299977 | 2499.81 | tanpa target | - |
| readiness\_ramp | readiness | ramp | 50 ke 1000 | 120 | 63000 | 62998 | 524.98 | tanpa target | - |
| status\_hold | status | hold | 4000 | 300 | 1200000 | 1200001 | 4000.00 | count\>=1198800 | lulus |
| readiness\_hold | readiness | hold | 1000 | 300 | 300000 | 300001 | 1000.00 | count\>=299700 | lulus |
| status\_rampdown | status | rampdown | 4000 ke 1000 | 60 | 150000 | 149997 | 2499.95 | tanpa target | - |
| readiness\_rampdown | readiness | rampdown | 1000 ke 50 | 60 | 31500 | 31499 | 524.98 | tanpa target | - |
| status\_settle | status | settle | 1000 | 10 | 10000 | 10001 | 1000.10 | count\>=9900 | lulus |
| readiness\_settle | readiness | settle | 50 | 10 | 500 | 501 | 50.10 | count\>=490 | lulus |
| status\_recover | status | recover | 1000 | 180 | 180000 | 180002 | 1000.01 | count\>=179820 | lulus |
| readiness\_recover | readiness | recover | 50 | 180 | 9000 | 9000 | 50 | count\>=8990 | lulus |

| Total | Nilai |
| --- | --- |
| Iterasi | 2275472 |
| Request HTTP | 2275472 |
| Dropped iterations | 0 |
| VU maksimum | 1000 |
| Scenario mulai sesudah T0 (ms) | 3 |

#### Latency terhadap target

| Endpoint | Fase | Hasil | Jumlah | p50 | p95 | p99 | max | Target | Status target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status | warmup | all | 29995 | 0.19 | 0.74 | 1.72 | 11.08 | tanpa target | - |
| readiness | warmup | available | 1499 | 1.19 | 3.59 | 5.54 | 10.00 | tanpa target | - |
| readiness | warmup | busy | 1 | 1.09 | 1.09 | 1.09 | 1.09 | tanpa target | - |
| readiness | warmup | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | ramp | all | 299977 | 0.12 | 0.24 | 1.04 | 16.21 | tanpa target | - |
| readiness | ramp | available | 52465 | 0.55 | 0.91 | 1.30 | 10.63 | tanpa target | - |
| readiness | ramp | busy | 10533 | 0.13 | 1.17 | 3.18 | 10.56 | tanpa target | - |
| readiness | ramp | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | hold | all | 1200001 | 0.10 | 0.26 | 2.59 | 19.64 | p(99)\<25, p(95)\<10 | lulus |
| readiness | hold | available | 191865 | 0.51 | 0.64 | 1.32 | 16.05 | p(95)\<25, p(99)\<50 | lulus |
| readiness | hold | busy | 108136 | 0.12 | 0.65 | 3.73 | 15.89 | p(95)\<10 | lulus |
| readiness | hold | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | rampdown | all | 149997 | 0.12 | 0.23 | 0.69 | 11.41 | tanpa target | - |
| readiness | rampdown | available | 26404 | 0.56 | 0.89 | 1.27 | 5.94 | tanpa target | - |
| readiness | rampdown | busy | 5095 | 0.12 | 0.95 | 2.43 | 4.96 | tanpa target | - |
| readiness | rampdown | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | settle | all | 10001 | 0.21 | 0.70 | 2.01 | 12.10 | tanpa target | - |
| readiness | settle | available | 501 | 1.24 | 3.59 | 4.53 | 8.25 | tanpa target | - |
| readiness | settle | busy | 0 | - | - | - | - | tanpa target | - |
| readiness | settle | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | recover | all | 180002 | 0.19 | 0.48 | 1.61 | 11.71 | p(95)\<10, p(99)\<25 | lulus |
| readiness | recover | available | 8987 | 1.14 | 2.80 | 4.48 | 34.39 | p(95)\<25, p(99)\<50 | lulus |
| readiness | recover | busy | 13 | 1.00 | 2.87 | 3.72 | 3.93 | tanpa target | - |
| readiness | recover | unavailable | 0 | - | - | - | - | tanpa target | - |

#### Rasio readiness

| Fase | 200 tersedia | 429 sibuk | 503 tidak tersedia | Rasio tersedia | Target rasio | Status target |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 1499 | 1 | 0 | 0.999 | tanpa target | - |
| ramp | 52465 | 10533 | 0 | 0.833 | tanpa target | - |
| hold | 191865 | 108136 | 0 | 0.640 | rate\>=0.20 | lulus |
| rampdown | 26404 | 5095 | 0 | 0.838 | tanpa target | - |
| settle | 501 | 0 | 0 | 1 | tanpa target | - |
| recover | 8987 | 13 | 0 | 0.999 | rate\>=0.98 | lulus |

#### Thresholds

45 dari 45 threshold lulus.

#### Resource, pool, dan check pengamatan

| Container | CPU rata rata (persen satu CPU) | CPU maksimum | Memory rata rata (MiB) | Memory maksimum (MiB) | Pertumbuhan memory (MiB) | Restart | OOM | Byte stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| postgres | 6.39 | 11.11 | 45.41 | 46.80 | - | - | - | - |
| backend | 19.69 | 30.81 | 30.26 | 36.28 | - | 0 | tidak | 0 |
| k6 | 60.87 | 96.22 | 846.21 | 1120.26 | - | - | - | - |

| Pool | Nilai |
| --- | --- |
| Sesi foundation\_backend maksimum | 5 |
| Sesi foundation\_backend aktif maksimum | 1 |
| Sesi client maksimum | 6 |
| Sampel berhasil | 745 |
| Sampel gagal | 0 |

| Check | Aturan | Aktual | Lulus |
| --- | --- | --- | --- |
| backend\_running | sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled | {"running":true,"restarts":0,"oomKilled":false} | ya |
| backend\_output | stderr 0 byte; stdout tepat baris listening lalu Backend stopped | {"stderrBytes":0,"stdoutExpected":true} | ya |
| backend\_memory\_peak | memory backend maksimum \<= 128 MiB | 36.28 | ya |
| pool\_sessions | setiap sampel mencatat paling banyak 5 sesi foundation\_backend | 5 | ya |
| pool\_non\_idle | setiap sampel mencatat paling banyak 1 sesi foundation\_backend yang tidak idle | 1 | ya |
| generator\_cpu | rata rata CPU k6 pada setiap fase terukur \<= 240 persen satu CPU | 76.94 | ya |
| generator\_memory | memory k6 maksimum \<= 1638 MiB | 1120.26 | ya |
| observation\_coverage | sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg\_stat\_activity | \[\] | ya |
| clock\_offset | selisih jam container dengan host \<= 1000 ms sebelum T0 dan sesudah k6 keluar | {"before":7,"after":6} | ya |

#### Environment

| Aspek | Nilai |
| --- | --- |
| Host | Darwin 27.0.0 arm64 |
| CPU host | Apple M1 Max, 10 CPU |
| Memory host (byte) | 34359738368 |
| Mesin container | versi server 29.8.0, Docker Desktop, 10 CPU, memory 8319504384 byte |
| Container lain yang berjalan | 7 |
| CI | tidak |
| Image k6 | grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 |
| Image Bun | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 |
| PostgreSQL | foundation-postgres:18-pinned, image id sha256:0470b120c2ebef56573f3f66861a6a50bea3e6daf9c819c37c598fecf6ff5557, base oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6, versi 18.6 |
| Batas resource postgres | cpus 2, memory 1g, shmSize 128m, pids 256 |
| Batas resource backend | cpus 1, memory 512m, pids 256 |
| Batas resource k6 | cpus 3, memory 2g, pids 512 |
| Batas resource inspect | cpus 1, memory 512m, pids 512 |
| Pool | max 5, connectionTimeout 3 detik |
| Data | 1 migration |
| Selisih jam (ms) | sebelum T0 7, sesudah k6 6 |

#### Batas bukti

| No | Batas bukti |
| --- | --- |
| 1 | Alur yang diukur adalah diagnostik komposisi development, \`GET /api/status\` dan \`GET /api/readiness\`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis. |
| 2 | Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13. |
| 3 | k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata. |
| 4 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |
| 5 | Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama. |
| 6 | Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh. |

### Profil spike

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Tier dan langkah | capacity, test:performance:spike |
| Bukti | .local/feature-11/evidence/capacity/.local/feature-12/spike/result.json |
| Model beban | warmup ramp 60 detik N, before constant 120 detik N, rise ramp 5 detik O, spike constant 60 detik O, fall ramp 5 detik N, settle constant 10 detik N, after constant 180 detik N; satu iterasi satu request |

#### Beban target dan aktual

| Scenario | Endpoint | Fase | Laju rencana per detik | Detik | Iterasi rencana | Iterasi aktual | Laju aktual per detik | Ambang iterasi | Status ambang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status\_warmup | status | warmup | 0 ke 1000 | 60 | 30000 | 29997 | 499.95 | tanpa target | - |
| readiness\_warmup | readiness | warmup | 0 ke 50 | 60 | 1500 | 1500 | 25 | tanpa target | - |
| status\_before | status | before | 1000 | 120 | 120000 | 120001 | 1000.01 | count\>=119880 | lulus |
| readiness\_before | readiness | before | 50 | 120 | 6000 | 6000 | 50 | count\>=5990 | lulus |
| status\_rise | status | rise | 1000 ke 4000 | 5 | 12500 | 12474 | 2494.80 | tanpa target | - |
| readiness\_rise | readiness | rise | 50 ke 1000 | 5 | 2625 | 2623 | 524.60 | tanpa target | - |
| status\_spike | status | spike | 4000 | 60 | 240000 | 240000 | 4000 | count\>=239600 | lulus |
| readiness\_spike | readiness | spike | 1000 | 60 | 60000 | 60001 | 1000.02 | count\>=59900 | lulus |
| status\_fall | status | fall | 4000 ke 1000 | 5 | 12500 | 12497 | 2499.40 | tanpa target | - |
| readiness\_fall | readiness | fall | 1000 ke 50 | 5 | 2625 | 2624 | 524.80 | tanpa target | - |
| status\_settle | status | settle | 1000 | 10 | 10000 | 10001 | 1000.10 | count\>=9900 | lulus |
| readiness\_settle | readiness | settle | 50 | 10 | 500 | 501 | 50.10 | count\>=490 | lulus |
| status\_after | status | after | 1000 | 180 | 180000 | 180001 | 1000.01 | count\>=179820 | lulus |
| readiness\_after | readiness | after | 50 | 180 | 9000 | 9001 | 50.01 | count\>=8990 | lulus |

| Total | Nilai |
| --- | --- |
| Iterasi | 687221 |
| Request HTTP | 687221 |
| Dropped iterations | 0 |
| VU maksimum | 1110 |
| Scenario mulai sesudah T0 (ms) | 2 |

#### Latency terhadap target

| Endpoint | Fase | Hasil | Jumlah | p50 | p95 | p99 | max | Target | Status target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status | warmup | all | 29997 | 0.19 | 0.80 | 1.76 | 9.51 | tanpa target | - |
| readiness | warmup | available | 1497 | 1.21 | 3.67 | 5.52 | 15.83 | tanpa target | - |
| readiness | warmup | busy | 3 | 0.34 | 0.50 | 0.52 | 0.52 | tanpa target | - |
| readiness | warmup | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | before | all | 120001 | 0.18 | 0.60 | 1.80 | 32.34 | p(95)\<10, p(99)\<25 | lulus |
| readiness | before | available | 5985 | 1.11 | 3.03 | 4.64 | 14.80 | p(95)\<25, p(99)\<50 | lulus |
| readiness | before | busy | 15 | 1.38 | 2.77 | 3.22 | 3.33 | tanpa target | - |
| readiness | before | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | rise | all | 12474 | 0.11 | 0.30 | 1.74 | 6.69 | tanpa target | - |
| readiness | rise | available | 2190 | 0.55 | 0.99 | 1.60 | 4.45 | tanpa target | - |
| readiness | rise | busy | 433 | 0.13 | 1.62 | 2.83 | 3.62 | tanpa target | - |
| readiness | rise | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | spike | all | 240000 | 0.10 | 0.35 | 3.57 | 30.63 | p(95)\<10, p(99)\<25 | lulus |
| readiness | spike | available | 35994 | 0.52 | 0.68 | 1.88 | 13.06 | p(99)\<50, p(95)\<25 | lulus |
| readiness | spike | busy | 24007 | 0.12 | 1.11 | 5.11 | 12.97 | p(95)\<10 | lulus |
| readiness | spike | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | fall | all | 12497 | 0.12 | 0.25 | 0.69 | 4.78 | tanpa target | - |
| readiness | fall | available | 2253 | 0.57 | 0.91 | 1.23 | 4.03 | tanpa target | - |
| readiness | fall | busy | 371 | 0.12 | 0.86 | 1.68 | 4.92 | tanpa target | - |
| readiness | fall | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | settle | all | 10001 | 0.19 | 0.45 | 1.60 | 7.69 | tanpa target | - |
| readiness | settle | available | 500 | 1.10 | 2.87 | 4.23 | 7.86 | tanpa target | - |
| readiness | settle | busy | 1 | 0.21 | 0.21 | 0.21 | 0.21 | tanpa target | - |
| readiness | settle | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | after | all | 180001 | 0.21 | 0.74 | 1.95 | 28.91 | p(99)\<25, p(95)\<10 | lulus |
| readiness | after | available | 8982 | 1.25 | 3.38 | 4.81 | 11.85 | p(95)\<25, p(99)\<50 | lulus |
| readiness | after | busy | 19 | 1.13 | 1.85 | 1.88 | 1.89 | tanpa target | - |
| readiness | after | unavailable | 0 | - | - | - | - | tanpa target | - |

#### Rasio readiness

| Fase | 200 tersedia | 429 sibuk | 503 tidak tersedia | Rasio tersedia | Target rasio | Status target |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 1497 | 3 | 0 | 0.998 | tanpa target | - |
| before | 5985 | 15 | 0 | 0.998 | rate\>=0.98 | lulus |
| rise | 2190 | 433 | 0 | 0.835 | tanpa target | - |
| spike | 35994 | 24007 | 0 | 0.600 | rate\>=0.20 | lulus |
| fall | 2253 | 371 | 0 | 0.859 | tanpa target | - |
| settle | 500 | 1 | 0 | 0.998 | tanpa target | - |
| after | 8982 | 19 | 0 | 0.998 | rate\>=0.98 | lulus |

#### Thresholds

54 dari 54 threshold lulus.

#### Resource, pool, dan check pengamatan

| Container | CPU rata rata (persen satu CPU) | CPU maksimum | Memory rata rata (MiB) | Memory maksimum (MiB) | Pertumbuhan memory (MiB) | Restart | OOM | Byte stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| postgres | 3.13 | 10.05 | 44.92 | 46.12 | - | - | - | - |
| backend | 13.20 | 27.58 | 26.63 | 37.66 | - | 0 | tidak | 0 |
| k6 | 46.78 | 93.66 | 663.75 | 788.60 | - | - | - | - |

| Pool | Nilai |
| --- | --- |
| Sesi foundation\_backend maksimum | 5 |
| Sesi foundation\_backend aktif maksimum | 1 |
| Sesi client maksimum | 6 |
| Sampel berhasil | 455 |
| Sampel gagal | 0 |

| Check | Aturan | Aktual | Lulus |
| --- | --- | --- | --- |
| backend\_running | sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled | {"running":true,"restarts":0,"oomKilled":false} | ya |
| backend\_output | stderr 0 byte; stdout tepat baris listening lalu Backend stopped | {"stderrBytes":0,"stdoutExpected":true} | ya |
| backend\_memory\_peak | memory backend maksimum \<= 128 MiB | 37.66 | ya |
| pool\_sessions | setiap sampel mencatat paling banyak 5 sesi foundation\_backend | 5 | ya |
| pool\_non\_idle | setiap sampel mencatat paling banyak 1 sesi foundation\_backend yang tidak idle | 1 | ya |
| generator\_cpu | rata rata CPU k6 pada setiap fase terukur \<= 240 persen satu CPU | 78.95 | ya |
| generator\_memory | memory k6 maksimum \<= 1638 MiB | 788.60 | ya |
| observation\_coverage | sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg\_stat\_activity | \[\] | ya |
| clock\_offset | selisih jam container dengan host \<= 1000 ms sebelum T0 dan sesudah k6 keluar | {"before":7,"after":7} | ya |

#### Environment

| Aspek | Nilai |
| --- | --- |
| Host | Darwin 27.0.0 arm64 |
| CPU host | Apple M1 Max, 10 CPU |
| Memory host (byte) | 34359738368 |
| Mesin container | versi server 29.8.0, Docker Desktop, 10 CPU, memory 8319504384 byte |
| Container lain yang berjalan | 7 |
| CI | tidak |
| Image k6 | grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 |
| Image Bun | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 |
| PostgreSQL | foundation-postgres:18-pinned, image id sha256:0470b120c2ebef56573f3f66861a6a50bea3e6daf9c819c37c598fecf6ff5557, base oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6, versi 18.6 |
| Batas resource postgres | cpus 2, memory 1g, shmSize 128m, pids 256 |
| Batas resource backend | cpus 1, memory 512m, pids 256 |
| Batas resource k6 | cpus 3, memory 2g, pids 512 |
| Batas resource inspect | cpus 1, memory 512m, pids 512 |
| Pool | max 5, connectionTimeout 3 detik |
| Data | 1 migration |
| Selisih jam (ms) | sebelum T0 7, sesudah k6 7 |

#### Batas bukti

| No | Batas bukti |
| --- | --- |
| 1 | Alur yang diukur adalah diagnostik komposisi development, \`GET /api/status\` dan \`GET /api/readiness\`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis. |
| 2 | Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13. |
| 3 | k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata. |
| 4 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |
| 5 | Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama. |
| 6 | Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh. |

### Profil outage

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Tier dan langkah | capacity, test:performance:outage |
| Bukti | .local/feature-11/evidence/capacity/.local/feature-12/outage/result.json |
| Model beban | timeline constant 220 detik N; satu iterasi satu request |

#### Beban target dan aktual

| Scenario | Endpoint | Fase | Laju rencana per detik | Detik | Iterasi rencana | Iterasi aktual | Laju aktual per detik | Ambang iterasi | Status ambang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status\_timeline | status | timeline | 1000 | 220 | 220000 | 220001 | 1000.00 | count\>=219780 | lulus |
| readiness\_timeline | readiness | timeline | 50 | 220 | 11000 | 11001 | 50.00 | count\>=10989 | lulus |

| Total | Nilai |
| --- | --- |
| Iterasi | 231002 |
| Request HTTP | 231002 |
| Dropped iterations | 0 |
| VU maksimum | 110 |
| Scenario mulai sesudah T0 (ms) | 1 |

#### Latency terhadap target

| Endpoint | Fase | Hasil | Jumlah | p50 | p95 | p99 | max | Target | Status target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status | warmup | all | 29997 | 0.19 | 0.52 | 1.55 | 12.88 | tanpa target | - |
| readiness | warmup | available | 1500 | 1.14 | 2.75 | 4.33 | 8.82 | tanpa target | - |
| readiness | warmup | busy | 0 | - | - | - | - | tanpa target | - |
| readiness | warmup | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | before | all | 58000 | 0.20 | 0.63 | 1.85 | 10.66 | p(95)\<10, p(99)\<25 | lulus |
| readiness | before | available | 2899 | 1.17 | 2.96 | 4.53 | 8.98 | p(95)\<25, p(99)\<50 | lulus |
| readiness | before | busy | 1 | 0.61 | 0.61 | 0.61 | 0.61 | tanpa target | - |
| readiness | before | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | stopping | all | 13000 | 0.22 | 1.04 | 2.55 | 36.12 | p(95)\<10, p(99)\<25 | lulus |
| readiness | stopping | available | 103 | 1.11 | 2.66 | 3.43 | 3.58 | tanpa target | - |
| readiness | stopping | busy | 538 | 0.27 | 1.41 | 2.22 | 4.31 | tanpa target | - |
| readiness | stopping | unavailable | 9 | 3.11 | 3001.73 | 3001.88 | 3001.92 | max\<5500 | lulus |
| status | outage | all | 44000 | 0.12 | 0.58 | 1.81 | 10.50 | p(95)\<10, p(99)\<25 | lulus |
| readiness | outage | available | 0 | - | - | - | - | tanpa target | - |
| readiness | outage | busy | 962 | 0.27 | 1.43 | 2.55 | 3.84 | tanpa target | - |
| readiness | outage | unavailable | 1238 | 7.88 | 11.43 | 15.66 | 3002.63 | max\<5500 | lulus |
| status | recovering | all | 15000 | 0.15 | 0.39 | 1.65 | 10.41 | p(99)\<25, p(95)\<10 | lulus |
| readiness | recovering | available | 492 | 1.07 | 3.20 | 4.87 | 11.81 | tanpa target | - |
| readiness | recovering | busy | 1 | 0.26 | 0.26 | 0.26 | 0.26 | tanpa target | - |
| readiness | recovering | unavailable | 257 | 7.87 | 10.42 | 11.37 | 15.21 | max\<5500 | lulus |
| status | after | all | 60004 | 0.20 | 0.63 | 1.82 | 19.93 | p(95)\<10, p(99)\<25 | lulus |
| readiness | after | available | 2999 | 1.17 | 3.30 | 4.71 | 8.97 | p(95)\<25, p(99)\<50 | lulus |
| readiness | after | busy | 2 | 1.07 | 1.12 | 1.12 | 1.12 | tanpa target | - |
| readiness | after | unavailable | 0 | - | - | - | - | tanpa target | - |

#### Rasio readiness

| Fase | 200 tersedia | 429 sibuk | 503 tidak tersedia | Rasio tersedia | Target rasio | Status target |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 1500 | 0 | 0 | 1 | tanpa target | - |
| before | 2899 | 1 | 0 | 1.000 | rate\>=0.98 | lulus |
| stopping | 103 | 538 | 9 | 0.158 | tanpa target | - |
| outage | 0 | 962 | 1238 | 0 | tanpa target | - |
| recovering | 492 | 1 | 257 | 0.656 | tanpa target | - |
| after | 2999 | 2 | 0 | 0.999 | rate\>=0.98 | lulus |

Waktu pemulihan readiness: 154 ms.

#### Thresholds

40 dari 40 threshold lulus.

#### Resource, pool, dan check pengamatan

| Container | CPU rata rata (persen satu CPU) | CPU maksimum | Memory rata rata (MiB) | Memory maksimum (MiB) | Pertumbuhan memory (MiB) | Restart | OOM | Byte stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| postgres | 1.61 | 5.80 | 29.99 | 45.61 | - | - | - | - |
| backend | 10.20 | 14.76 | 25.35 | 27.88 | - | 0 | tidak | 0 |
| k6 | 43.51 | 63.17 | 112.16 | 152 | - | - | - | - |

| Pool | Nilai |
| --- | --- |
| Sesi foundation\_backend maksimum | 5 |
| Sesi foundation\_backend aktif maksimum | 1 |
| Sesi client maksimum | 6 |
| Sampel berhasil | 175 |
| Sampel gagal | 60 |

| Check | Aturan | Aktual | Lulus |
| --- | --- | --- | --- |
| backend\_running | sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled | {"running":true,"restarts":0,"oomKilled":false} | ya |
| backend\_output | stderr 0 byte; stdout tepat baris listening lalu Backend stopped | {"stderrBytes":0,"stdoutExpected":true} | ya |
| backend\_memory\_peak | memory backend maksimum \<= 128 MiB | 27.88 | ya |
| pool\_sessions | setiap sampel mencatat paling banyak 5 sesi foundation\_backend | 5 | ya |
| pool\_non\_idle | setiap sampel mencatat paling banyak 1 sesi foundation\_backend yang tidak idle | 1 | ya |
| pool\_reconnect | sedikitnya satu sampel pada fase after dengan sesi foundation\_backend | 60 | ya |
| generator\_cpu | rata rata CPU k6 pada setiap fase terukur \<= 240 persen satu CPU | 49.41 | ya |
| generator\_memory | memory k6 maksimum \<= 1638 MiB | 152 | ya |
| observation\_coverage | sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg\_stat\_activity | \[\] | ya |
| clock\_offset | selisih jam container dengan host \<= 1000 ms sebelum T0 dan sesudah k6 keluar | {"before":8,"after":6} | ya |
| outage\_control | stop dan start dikirim tidak lebih awal dari jadwal dan paling lambat 1000 ms sesudahnya; stop selesai \<= 8000 ms, start \<= 5000 ms | {"stopPlannedMs":90000,"stopIssuedMs":90006,"stopCompletedMs":90215,"startPlannedMs":150000,"startIssuedMs":150001,"startCompletedMs":150124} | ya |

#### Kontrol outage

| Waktu | ms sesudah T0 |
| --- | --- |
| stopPlannedMs | 90000 |
| stopIssuedMs | 90006 |
| stopCompletedMs | 90215 |
| startPlannedMs | 150000 |
| startIssuedMs | 150001 |
| startCompletedMs | 150124 |

#### Environment

| Aspek | Nilai |
| --- | --- |
| Host | Darwin 27.0.0 arm64 |
| CPU host | Apple M1 Max, 10 CPU |
| Memory host (byte) | 34359738368 |
| Mesin container | versi server 29.8.0, Docker Desktop, 10 CPU, memory 8319504384 byte |
| Container lain yang berjalan | 7 |
| CI | tidak |
| Image k6 | grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 |
| Image Bun | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 |
| PostgreSQL | foundation-postgres:18-pinned, image id sha256:0470b120c2ebef56573f3f66861a6a50bea3e6daf9c819c37c598fecf6ff5557, base oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6, versi 18.6 |
| Batas resource postgres | cpus 2, memory 1g, shmSize 128m, pids 256 |
| Batas resource backend | cpus 1, memory 512m, pids 256 |
| Batas resource k6 | cpus 3, memory 2g, pids 512 |
| Batas resource inspect | cpus 1, memory 512m, pids 512 |
| Pool | max 5, connectionTimeout 3 detik |
| Data | 1 migration |
| Selisih jam (ms) | sebelum T0 8, sesudah k6 6 |

#### Batas bukti

| No | Batas bukti |
| --- | --- |
| 1 | Alur yang diukur adalah diagnostik komposisi development, \`GET /api/status\` dan \`GET /api/readiness\`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis. |
| 2 | Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13. |
| 3 | k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata. |
| 4 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |
| 5 | Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama. |
| 6 | Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh. |

### Profil soak

| Aspek | Nilai |
| --- | --- |
| Status | passed |
| Tier dan langkah | capacity, test:performance:soak |
| Bukti | .local/feature-11/evidence/capacity/.local/feature-12/soak/result.json |
| Model beban | warmup ramp 60 detik N, steady constant 3600 detik N; satu iterasi satu request |

#### Beban target dan aktual

| Scenario | Endpoint | Fase | Laju rencana per detik | Detik | Iterasi rencana | Iterasi aktual | Laju aktual per detik | Ambang iterasi | Status ambang |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status\_warmup | status | warmup | 0 ke 1000 | 60 | 30000 | 29996 | 499.93 | tanpa target | - |
| readiness\_warmup | readiness | warmup | 0 ke 50 | 60 | 1500 | 1500 | 25 | tanpa target | - |
| status\_steady | status | steady | 1000 | 3600 | 3600000 | 3600001 | 1000.00 | count\>=3596400 | lulus |
| readiness\_steady | readiness | steady | 50 | 3600 | 180000 | 180000 | 50 | count\>=179820 | lulus |

| Total | Nilai |
| --- | --- |
| Iterasi | 3811497 |
| Request HTTP | 3811497 |
| Dropped iterations | 0 |
| VU maksimum | 220 |
| Scenario mulai sesudah T0 (ms) | 0 |

#### Latency terhadap target

| Endpoint | Fase | Hasil | Jumlah | p50 | p95 | p99 | max | Target | Status target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| status | warmup | all | 29996 | 0.18 | 0.71 | 1.64 | 10.25 | tanpa target | - |
| readiness | warmup | available | 1500 | 1.12 | 3.42 | 5.47 | 11.99 | tanpa target | - |
| readiness | warmup | busy | 0 | - | - | - | - | tanpa target | - |
| readiness | warmup | unavailable | 0 | - | - | - | - | tanpa target | - |
| status | steady | all | 3600001 | 0.17 | 0.41 | 1.47 | 37.75 | p(95)\<10, p(99)\<25 | lulus |
| readiness | steady | available | 179936 | 1.02 | 2.75 | 4.47 | 29.29 | p(95)\<25, p(99)\<50 | lulus |
| readiness | steady | busy | 64 | 1.14 | 4.49 | 5.59 | 6.13 | tanpa target | - |
| readiness | steady | unavailable | 0 | - | - | - | - | tanpa target | - |

#### Rasio readiness

| Fase | 200 tersedia | 429 sibuk | 503 tidak tersedia | Rasio tersedia | Target rasio | Status target |
| --- | --- | --- | --- | --- | --- | --- |
| warmup | 1500 | 0 | 0 | 1 | tanpa target | - |
| steady | 179936 | 64 | 0 | 1.000 | rate\>=0.98 | lulus |

#### Thresholds

18 dari 18 threshold lulus.

#### Resource, pool, dan check pengamatan

| Container | CPU rata rata (persen satu CPU) | CPU maksimum | Memory rata rata (MiB) | Memory maksimum (MiB) | Pertumbuhan memory (MiB) | Restart | OOM | Byte stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| postgres | 1.92 | 3.99 | 45.26 | 46.32 | - | - | - | - |
| backend | 9.74 | 15.64 | 26.83 | 30.77 | 0.65 | 0 | tidak | 0 |
| k6 | 43.01 | 95.64 | 541.11 | 1020 | - | - | - | - |

| Pool | Nilai |
| --- | --- |
| Sesi foundation\_backend maksimum | 5 |
| Sesi foundation\_backend aktif maksimum | 1 |
| Sesi client maksimum | 6 |
| Sampel berhasil | 3671 |
| Sampel gagal | 0 |

| Check | Aturan | Aktual | Lulus |
| --- | --- | --- | --- |
| backend\_running | sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled | {"running":true,"restarts":0,"oomKilled":false} | ya |
| backend\_output | stderr 0 byte; stdout tepat baris listening lalu Backend stopped | {"stderrBytes":0,"stdoutExpected":true} | ya |
| backend\_memory\_peak | memory backend maksimum \<= 128 MiB | 30.77 | ya |
| backend\_cpu\_mean | rata rata CPU backend pada steady \<= 50 persen satu CPU | 9.78 | ya |
| backend\_memory\_growth | pertumbuhan memory backend pada steady \<= 16 MiB | 0.65 | ya |
| pool\_sessions | setiap sampel mencatat paling banyak 5 sesi foundation\_backend | 5 | ya |
| pool\_non\_idle | setiap sampel mencatat paling banyak 1 sesi foundation\_backend yang tidak idle | 1 | ya |
| generator\_cpu | rata rata CPU k6 pada setiap fase terukur \<= 240 persen satu CPU | 43.26 | ya |
| generator\_memory | memory k6 maksimum \<= 1638 MiB | 1020 | ya |
| observation\_coverage | sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg\_stat\_activity | \[\] | ya |
| clock\_offset | selisih jam container dengan host \<= 1000 ms sebelum T0 dan sesudah k6 keluar | {"before":7,"after":7} | ya |

#### Environment

| Aspek | Nilai |
| --- | --- |
| Host | Darwin 27.0.0 arm64 |
| CPU host | Apple M1 Max, 10 CPU |
| Memory host (byte) | 34359738368 |
| Mesin container | versi server 29.8.0, Docker Desktop, 10 CPU, memory 8319504384 byte |
| Container lain yang berjalan | 7 |
| CI | tidak |
| Image k6 | grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 |
| Image Bun | oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 |
| PostgreSQL | foundation-postgres:18-pinned, image id sha256:0470b120c2ebef56573f3f66861a6a50bea3e6daf9c819c37c598fecf6ff5557, base oraclelinux:10-slim@sha256:0660af1f1bb56559b299d99d3b71d0ff51f9d593cecbd3154a46914704ec34d6, versi 18.6 |
| Batas resource postgres | cpus 2, memory 1g, shmSize 128m, pids 256 |
| Batas resource backend | cpus 1, memory 512m, pids 256 |
| Batas resource k6 | cpus 3, memory 2g, pids 512 |
| Batas resource inspect | cpus 1, memory 512m, pids 512 |
| Pool | max 5, connectionTimeout 3 detik |
| Data | 1 migration |
| Selisih jam (ms) | sebelum T0 7, sesudah k6 7 |

#### Batas bukti

| No | Batas bukti |
| --- | --- |
| 1 | Alur yang diukur adalah diagnostik komposisi development, \`GET /api/status\` dan \`GET /api/readiness\`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis. |
| 2 | Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13. |
| 3 | k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata. |
| 4 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |
| 5 | Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama. |
| 6 | Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh. |

## Kandidat release

Kandidat release: bukan (`not_clean`, `not_ci`)

- `not_clean`: working tree tier kapasitas tidak bersih di awal atau di akhir tier.
- `not_ci`: tidak berasal dari run CI.

Tanda ini tidak mengubah status laporan kapasitas maupun exit code `test:report:capacity`.

## Di luar cakupan

- Identitas image deployment belum diikat pada laporan (fitur 13).
