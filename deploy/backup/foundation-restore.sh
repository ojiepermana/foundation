#!/bin/bash
# Restore database Foundation ke target baru yang terisolasi (spec 0013, Urutan restore, Perintah restore, dan Pesan
# script). Dijalankan service restore di deploy/backup.yaml dengan folder backup hanya baca dan DSN admin target yang
# diteruskan `run -e FOUNDATION_ADMIN_DATABASE_URL` dari shell operator:
#   foundation-restore.sh <nama>.dump
# Script berhenti pada pemeriksaan pertama yang gagal, sebelum target disentuh. Restore berjalan dalam satu transaksi,
# sehingga pg_restore yang gagal tidak meninggalkan perubahan. Manifest tidak dibaca, karena tidak dilindungi checksum.
# Keluaran pg_restore dan psql ditangkap ke file di /tmp lalu hanya dipetakan ke kategori, tidak pernah dicetak. Stderr
# lain milik script juga dialihkan ke file di /tmp, sehingga hanya baris kategori yang keluar dari container. Password
# DSN admin tidak pernah masuk argumen proses (split_dsn). Script tidak membuat file di luar /tmp, karena folder backup
# dipasang hanya baca.
set -Eeuo pipefail
umask 077
export LC_ALL=C
export PGCONNECT_TIMEOUT=10

# Satu satunya bacaan environment; variable yang tidak ada di container sama dengan kosong.
FOUNDATION_ADMIN_DATABASE_URL="${FOUNDATION_ADMIN_DATABASE_URL:-}"

readonly BACKUP_DIR=/backup
readonly WORK_DIR=/tmp
readonly DUMP_PATTERN='^foundation-[0-9]{8}T[0-9]{6}Z-(scheduled|pre-migration|manual)\.dump$'
readonly VERSION_PATTERN='^[0-9]+(\.[0-9]+)?$'
readonly USAGE='Usage: foundation-restore.sh <name>.dump'
# Batas waktu dalam detik, sama dengan argumen timeout di bawah: pg_restore 10.800 detik, psql 60 detik.
readonly RESTORE_LIMIT_SECONDS=10800
readonly QUERY_LIMIT_SECONDS=60

# fd 3 adalah stderr container dan hanya dipakai untuk baris kategori. Stderr lain (galat bash atau alat yang gagal di
# luar pemetaan kategori) masuk ke file di /tmp, sehingga kegagalan tetap tepat satu baris.
exec 3>&2 2>"$WORK_DIR/foundation-restore.err"

reported=0
child=''
child_status=0

report() {
  reported=1
  printf '%s\n' "$1" >&3
}

fail() {
  report "$1"
  exit 1
}

# trap EXIT: kegagalan tanpa pesan kategori mencetak `Restore failed: internal`. Restore tidak membuat file milik run di
# luar /tmp, jadi tidak ada file yang perlu dihapus.
on_exit() {
  local status=$?
  trap '' TERM INT
  if (( status != 0 && reported == 0 )); then
    report 'Restore failed: internal'
    status=1
  fi
  exit "$status"
}

# trap TERM dan INT (misalnya docker stop): hentikan proses anak, lalu keluar 143 atau 130. pg_restore yang dihentikan
# menutup koneksinya, sehingga transaksi tunggal nya dibatalkan server.
on_signal() {
  local status=$1
  trap '' TERM INT
  if [[ -n $child ]]; then
    kill -TERM "$child" || true
    wait "$child" || true
    child=''
  fi
  report 'Restore failed: interrupted'
  exit "$status"
}

trap on_exit EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT

# Script berjalan sebagai PID 1 container, jadi alat PostgreSQL dijalankan di background dan ditunggu dengan wait: trap
# TERM dan INT berjalan segera, tidak menunggu alat selesai. Status keluar alat disimpan di child_status.
background() {
  "$@" &
  child=$!
  child_status=0
  wait "$child" || child_status=$?
  child=''
}

# Kategori kegagalan dalam urutan pola yang sama dengan script backup, lalu `time limit` dan `killed` dari exit timeout
# terhadap batas waktu, dengan kategori cadangan untuk sisanya.
#   category <file keluaran> <exit> <durasi ms> <batas detik> <cadangan>
category() {
  local output=$1 code=$2 elapsed=$3 limit=$4 fallback=$5
  if grep -qF -e 'invalid URI' -e 'invalid connection option' -e 'invalid integer value' -e 'unexpected spaces' \
    -e 'invalid percent-encoded' -e 'missing "="' -- "$output"; then
    printf '%s\n' 'invalid connection string'
  elif grep -qF -e 'password authentication failed' -e 'connection to server' -e 'could not translate host name' \
    -e 'timeout expired' -- "$output"; then
    printf '%s\n' 'connection'
  elif grep -qF -e 'row-level security' -- "$output"; then
    printf '%s\n' 'row level security'
  elif grep -qF -e 'canceling statement due to statement timeout' -e 'lock timeout' -e 'could not obtain lock' -- "$output"; then
    printf '%s\n' 'lock timeout'
  elif grep -qF -e 'permission denied' -- "$output"; then
    printf '%s\n' 'permission denied'
  elif (( code == 124 || (code == 137 && elapsed >= limit * 1000) )); then
    printf '%s\n' 'time limit'
  elif (( code == 137 )); then
    printf '%s\n' 'killed'
  else
    printf '%s\n' "$fallback"
  fi
}

# Password DSN di luar argumen proses (spec 0013, Perintah pg_dump): argumen proses terbaca setiap pengguna host lewat
# /proc/<pid>/cmdline, sedangkan environment proses hanya terbaca UID yang sama dan root. Fungsi ini dan split_dsn sama
# persis di kedua script (BKP-001). percent_decode menulis token URI yang di decode persen ke decoded, dengan aturan
# libpq: spasi, persen yang tidak diikuti dua digit heksadesimal, dan %00 ditolak.
#   percent_decode <token>
decoded=''
percent_decode() {
  local value=$1 hex char
  decoded=''
  [[ $value != *' '* ]] || return 1
  while [[ $value == *%* ]]; do
    decoded+=${value%%\%*}
    value=${value#*%}
    hex=${value:0:2}
    [[ $hex =~ ^[0-9A-Fa-f]{2}$ && $hex != 00 ]] || return 1
    printf -v char '%b' "\\x$hex"
    decoded+=$char
    value=${value:2}
  done
  decoded+=$value
}

# split_dsn memisahkan DSN bentuk URI postgres:// atau postgresql:// menjadi dsn_address, URI yang sama tanpa password
# untuk --dbname, dan PGPASSWORD yang diekspor ke alat PostgreSQL, berisi password yang di decode persen. Userinfo dibaca
# seperti libpq: sampai '@' pertama sebelum '/' pertama, dengan password sesudah ':' pertama. Bentuk lain, password yang
# tidak dapat di decode, dan parameter query password ditolak, sehingga tidak ada password di argumen proses.
#   split_dsn <DSN>
dsn_address=''
split_dsn() {
  local dsn=$1 scheme rest userinfo='' query item
  case $dsn in
    postgresql://*) scheme=postgresql:// ;;
    postgres://*) scheme=postgres:// ;;
    *) return 1 ;;
  esac
  rest=${dsn#"$scheme"}
  if [[ ${rest%%/*} == *@* ]]; then
    userinfo=${rest%%@*}
    rest=${rest#*@}
  fi
  if [[ $rest == *\?* ]]; then
    query=${rest#*\?}
    while :; do
      item=${query%%&*}
      percent_decode "${item%%=*}" || return 1
      [[ $decoded != password ]] || return 1
      [[ $query == *'&'* ]] || break
      query=${query#*&}
    done
  fi
  if [[ $userinfo == *:* ]]; then
    percent_decode "${userinfo#*:}" || return 1
    dsn_address="$scheme${userinfo%%:*}@$rest"
  else
    decoded=''
    dsn_address=$dsn
  fi
  export PGPASSWORD=$decoded
}

# Satu query psql pada target dengan DSN admin, dibatasi 60 detik; baris hasilnya disimpan di query_result. Kegagalan
# kategori connection mencetak `Restore target unavailable`, kategori lain `Restore failed: <kategori>`.
query_result=''
query() {
  local output="$WORK_DIR/psql.out" errors="$WORK_DIR/psql.err" started ended kind
  started=$(date +%s%3N)
  background timeout --signal=TERM --kill-after=10s 60 psql -X -w -At -v ON_ERROR_STOP=1 --dbname="$dsn_address" -c "$1" >"$output" 2>"$errors"
  ended=$(date +%s%3N)
  if (( child_status != 0 )); then
    kind=$(category "$errors" "$child_status" "$(( ended - started ))" "$QUERY_LIMIT_SECONDS" pg_restore)
    if [[ $kind == connection ]]; then
      fail 'Restore target unavailable'
    fi
    fail "Restore failed: $kind"
  fi
  query_result=$(<"$output")
}

# 1. Tepat satu argumen yang cocok pola nama ditambah .dump, tanpa path.
[[ $# -eq 1 ]] || fail "$USAGE"
readonly dump=$1
if [[ $dump == */* || ! $dump =~ $DUMP_PATTERN ]]; then
  fail 'Invalid backup name'
fi
readonly name=${dump%.dump}

# 2. DSN admin target.
[[ -n $FOUNDATION_ADMIN_DATABASE_URL ]] || fail 'Missing FOUNDATION_ADMIN_DATABASE_URL'

# 3. Ketiga file ada sebagai file biasa, bukan symlink.
for file in "$dump" "$name.dump.sha256" "$name.json"; do
  if [[ -L $BACKUP_DIR/$file || ! -f $BACKUP_DIR/$file ]]; then
    fail "Backup incomplete: $name"
  fi
done

# 4. File checksum tepat satu baris yang menamai dump ini, lalu sha256sum --check. Baris diperiksa lebih dulu, karena
# sha256sum --check memeriksa file apa pun yang dinamai file checksum.
mapfile -t checksum_lines <"$BACKUP_DIR/$name.dump.sha256" || fail "Backup checksum mismatch: $name"
if [[ ${#checksum_lines[@]} -ne 1 || ! ${checksum_lines[0]} =~ ^[0-9a-f]{64}\ \ ${name}\.dump$ ]]; then
  fail "Backup checksum mismatch: $name"
fi
if ! (cd "$BACKUP_DIR" && sha256sum --check --strict --status "$name.dump.sha256"); then
  fail "Backup checksum mismatch: $name"
fi

# 5. Header archive: pg_restore --list keluar 0, database foundation, dan versi server pembuat dump.
list="$WORK_DIR/pg_restore.list"
background pg_restore --list "$BACKUP_DIR/$dump" >"$list" 2>"$WORK_DIR/pg_restore.err"
(( child_status == 0 )) || fail "Backup archive invalid: $name"
dumped_from=$(sed -n 's/^;[[:space:]]*Dumped from database version: \([^ ]*\).*$/\1/p' "$list" | head -n 1)
if ! grep -qx -- ';     dbname: foundation' "$list" || [[ ! $dumped_from =~ $VERSION_PATTERN ]]; then
  fail "Backup archive invalid: $name"
fi
readonly backup_major=${dumped_from%%.*}

# 6. Identitas target: foundation_admin pada database foundation. Sebelumnya password DSN admin dipindah ke PGPASSWORD
# dan sisa DSN ke dsn_address (split_dsn), sehingga psql dan pg_restore tidak pernah membawa password di argumennya.
split_dsn "$FOUNDATION_ADMIN_DATABASE_URL" || fail 'Restore failed: invalid connection string'
query "SELECT current_user, session_user, current_database(), current_setting('server_version_num')"
IFS='|' read -r current_role session_role database version_num <<<"$query_result"
if [[ $current_role != foundation_admin || $session_role != foundation_admin || $database != foundation || ! $version_num =~ ^[0-9]+$ ]]; then
  fail 'Invalid restore target'
fi

# 7. Major server target sama dengan major header dump.
if (( version_num / 10000 != backup_major )); then
  fail 'Backup major version mismatch'
fi

# 8. Target sudah diprovision: ketiga role dan common.schema_migrations ada.
query "SELECT (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('foundation_owner', 'foundation_migrator', 'foundation_backend')) = 3 AND pg_catalog.to_regclass('common.schema_migrations') IS NOT NULL"
[[ $query_result == t ]] || fail 'Restore target not provisioned'

# 9. Target kosong: tanpa riwayat migration, tanpa relation selain common.schema_migrations, dan tanpa schema tambahan.
query "SELECT (SELECT count(*) FROM common.schema_migrations) = 0
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_%' AND NOT (n.nspname = 'common' AND c.relname = 'schema_migrations'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT IN ('public', 'common', 'users', 'auth', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%')"
[[ $query_result == t ]] || fail 'Restore target not empty'

# 10. Restore dalam satu transaksi.
restore_output="$WORK_DIR/pg_restore.out"
started=$(date +%s%3N)
background timeout --signal=TERM --kill-after=30s 10800 pg_restore --dbname="$dsn_address" --clean --if-exists --single-transaction --exit-on-error --no-password /backup/$name.dump >"$restore_output" 2>&1
ended=$(date +%s%3N)
if (( child_status != 0 )); then
  fail "Restore failed: $(category "$restore_output" "$child_status" "$(( ended - started ))" "$RESTORE_LIMIT_SECONDS" pg_restore)"
fi
printf 'Restore completed: %s\n' "$dump"
