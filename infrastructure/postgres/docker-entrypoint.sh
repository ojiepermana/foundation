#!/usr/bin/env bash
# Entrypoint minimal Foundation (spec 0002). Cluster baru dibuat sekali di folder staging lalu
# dipindahkan dengan satu mv atomik. Cluster yang sudah ada tidak pernah diinisialisasi ulang atau diubah.
set -Eeuo pipefail
umask 077

log() { printf 'foundation-postgres: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

: "${PGDATA:?PGDATA wajib diisi.}"
staging="${PGDATA}.init"
identifier='^[a-z_][a-z0-9_]{0,62}$'

initialize() {
  local user="${POSTGRES_USER:-}" database="${POSTGRES_DB:-}" password="${POSTGRES_PASSWORD:-}" pwfile
  [[ "$user" =~ $identifier ]] || fail "POSTGRES_USER harus identifier huruf kecil, angka, atau garis bawah."
  [[ "$database" =~ $identifier ]] || fail "POSTGRES_DB harus identifier huruf kecil, angka, atau garis bawah."
  [ "${#password}" -ge 16 ] || fail "POSTGRES_PASSWORD wajib diisi minimal 16 karakter untuk membuat cluster baru."
  [[ "$password" != *$'\n'* ]] || fail "POSTGRES_PASSWORD tidak boleh memuat baris baru."

  if [ -e "$staging" ]; then
    log "Menghapus staging sisa inisialisasi yang terputus: $staging"
    rm -rf -- "$staging"
  fi
  mkdir -p -- "$(dirname -- "$PGDATA")"

  pwfile="$(mktemp)"
  trap 'rm -f -- "$pwfile"' EXIT
  printf '%s\n' "$password" > "$pwfile"
  initdb --pgdata="$staging" --username="$user" --pwfile="$pwfile" --auth=scram-sha-256 \
    --encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C.UTF-8 --data-checksums
  rm -f -- "$pwfile"
  trap - EXIT

  cat > "$staging/pg_hba.conf" <<'EOF'
# Dibuat oleh entrypoint Foundation (spec 0002). Semua koneksi memakai scram-sha-256.
local all all scram-sha-256
host all all 0.0.0.0/0 scram-sha-256
host all all ::/0 scram-sha-256
EOF
  cat >> "$staging/postgresql.conf" <<'EOF'

# Foundation (spec 0002): port host hanya dipublikasikan ke 127.0.0.1 oleh Compose.
listen_addresses = '*'
# Paket PGDG menyalakan logging_collector; log Foundation tetap ke stderr agar terbaca docker logs.
logging_collector = off
EOF

  if [ "$database" != postgres ]; then
    printf 'CREATE DATABASE "%s" OWNER "%s";\n' "$database" "$user" \
      | postgres --single -D "$staging" -c exit_on_error=on postgres > /dev/null
  fi

  mv -T -- "$staging" "$PGDATA"
  sync -- "$(dirname -- "$PGDATA")"
  log "Cluster baru siap di $PGDATA."
}

if [ -e "$PGDATA" ]; then
  [ -f "$PGDATA/PG_VERSION" ] \
    || fail "$PGDATA ada tetapi tanpa PG_VERSION. Isinya tidak diubah; periksa atau reset volume secara manual."
else
  initialize
fi

unset POSTGRES_PASSWORD
exec postgres -D "$PGDATA" "$@"
