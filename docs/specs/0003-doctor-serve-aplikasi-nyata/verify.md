# Verifikasi doctor dan serve pada aplikasi nyata

Checklist ini menandai bukti aktual untuk kandidat yang sama. Kotak tetap kosong sampai perintah dan hasilnya dicatat. Bila prasyarat fitur 5, 6, atau 10 belum ada, catat `not_run` beserta alasannya.

| Skenario | Bukti yang perlu dicatat | Status |
| --- | --- | --- |
| `TOOL-001` | Exit doctor, target database, privilege negatif dan role membership, migration kosong atau berbeda, listener tidak berubah, redaksi secret | Belum diuji |
| `TOOL-002` | Listener Foundation lama terganti, checkout dan proses asing tetap hidup, PID atau grup berubah ditolak | Belum diuji |
| `TOOL-003` | Worker dipilih, path HTTP, worker tanpa port, isolasi environment | Belum diuji |
| `TOOL-004` | Exit layanan, Ctrl+C, termination, seluruh turunan berhenti, lock dilepas | Belum diuji |
| `TOOL-005` | Dua invocation serentak, satu startup, invocation kedua gagal tanpa dampak, satu pemulih lock lama | Belum diuji |
| `TOOL-006` | Respons HTTP dari grup baru, listener asing merebut port, respons salah, timeout 60 detik, cleanup grup baru | Belum diuji |
| `TOOL-007` | PostgreSQL 18 dan role runtime nyata, `serve`, frontend, backend, proxy, browser fitur 10 | Belum diuji |
| `TOOL-008` | Production, konfigurasi rusak, worker tidak dikenal gagal sebelum cleanup | Belum diuji |

Catat commit kandidat, versi Bun, Node, PostgreSQL, sistem operasi, perintah, exit code, hasil runner, dan lokasi JUnit pada laporan test. Jangan memakai port 8888 atau 8889 untuk test cleanup. Pakai fixture proses pada port sementara. Bukti aplikasi nyata boleh memakai port development setelah memastikan tidak ada layanan lain yang perlu dipertahankan.
