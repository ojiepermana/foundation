#!/bin/bash
# Backup database Foundation (spec 0013, Nama dan isi backup, Perintah pg_dump, Retensi, Check, dan Pesan script).
# Dijalankan service backup di deploy/backup.yaml sebagai container sekali jalan dengan role foundation_backup:
#   foundation-backup.sh create <scheduled|pre-migration|manual>   backup baru, lalu retensi
#   foundation-backup.sh check                                      backup lengkap terbaru (command default service)
# Script hanya mencetak pesan kategori tetap. Keluaran psql, pg_dump, dan pg_restore ditangkap ke file di /tmp lalu hanya
# dipetakan ke kategori, karena libpq mencetak ulang potongan password pada connection string yang rusak. Stderr lain
# milik script juga dialihkan ke file di /tmp, sehingga hanya baris kategori yang keluar dari container. Password DSN tidak
# pernah masuk argumen proses (split_dsn). Script tidak pernah mencetak nilai environment dan tidak memanggil alat jaringan
# selain psql, pg_dump, dan pg_restore. File yang tidak dibuat run ini hanya dihapus retensi, sesudah backup baru lengkap.
set -Eeuo pipefail
umask 077
export LC_ALL=C
export PGCONNECT_TIMEOUT=10
# Glob hanya dipakai untuk membaca isi root /backup; tanpa entri yang cocok, glob tidak menghasilkan apa pun.
shopt -s nullglob

# Satu satunya bacaan environment; sesudah baris ini variable selalu ada, sehingga set -u tidak menghentikan script.
FOUNDATION_BACKUP_DATABASE_URL="${FOUNDATION_BACKUP_DATABASE_URL:-}"

readonly BACKUP_DIR=/backup
readonly WORK_DIR=/tmp
readonly NAME_PATTERN='^foundation-[0-9]{8}T[0-9]{6}Z-(scheduled|pre-migration|manual)$'
# Nama .partial yang ditulis create; retensi hanya menyentuh dan mencetak nama yang cocok pola ini (tabel Retensi).
readonly PARTIAL_PATTERN='^\.foundation-[0-9]{8}T[0-9]{6}Z-(scheduled|pre-migration|manual)\.(dump|dump\.sha256|json)\.partial$'
readonly VERSION_PATTERN='^[0-9]+(\.[0-9]+)?$'
readonly TOC_MIGRATIONS='^[0-9]+; [0-9]+ [0-9]+ TABLE DATA common schema_migrations( |$)'
readonly USAGE='Usage: foundation-backup.sh create <scheduled|pre-migration|manual> | check'
# Batas waktu dalam detik, sama dengan argumen timeout di bawah: pg_dump 3.600 detik, psql 60 detik.
readonly DUMP_LIMIT_SECONDS=3600
readonly QUERY_LIMIT_SECONDS=60
# Retensi (tabel Retensi): 7 backup lengkap terbaru selalu disimpan, backup lengkap lain yang lebih tua dari 35 hari
# dihapus, dan file sisa yang lebih tua dari 24 jam (86.400 detik) dihapus.
readonly RETENTION_KEEP=7
readonly RETENTION_DAYS=35
readonly LEFTOVER_SECONDS=86400
# Check (tabel Check): backup terbaru lulus bila umurnya paling lama 93.600 detik (26 jam, inklusif).
readonly CHECK_LIMIT_SECONDS=93600

# fd 3 adalah stderr container dan hanya dipakai untuk baris kategori. Stderr lain (galat bash atau alat yang gagal di
# luar pemetaan kategori) masuk ke file di /tmp, sehingga kegagalan tetap tepat satu baris.
exec 3>&2 2>"$WORK_DIR/foundation-backup.err"

# File milik run ini: .partial yang dibuat dan file akhir yang sudah dipindah. Sebelum run done, trap menghapusnya;
# file yang sudah ada sebelum run tidak pernah masuk daftar ini.
run_files=()
done=0
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

remove_run_files() {
  local file
  for file in "${run_files[@]}"; do
    rm -f -- "$file" || true
  done
}

# trap EXIT: hapus file milik run bila run belum done, lalu cetak `Backup failed: internal` bila kegagalan terjadi tanpa
# pesan kategori (misalnya mv atau sync gagal).
on_exit() {
  local status=$?
  trap '' TERM INT
  if (( done == 0 )); then
    remove_run_files
  fi
  if (( status != 0 && reported == 0 )); then
    report 'Backup failed: internal'
    status=1
  fi
  exit "$status"
}

# trap TERM dan INT (misalnya docker stop): hentikan proses anak, hapus file milik run, lalu keluar 143 atau 130.
on_signal() {
  local status=$1
  trap '' TERM INT
  if [[ -n $child ]]; then
    kill -TERM "$child" || true
    wait "$child" || true
    child=''
  fi
  if (( done == 0 )); then
    remove_run_files
  fi
  report 'Backup failed: interrupted'
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

# Kategori kegagalan: pola dicocokkan atas keluaran yang ditangkap dalam urutan tabel Pesan script dan kategori pertama
# yang cocok dipakai; lalu dari keadaan: exit 124 dari timeout, atau 137 sesudah batas waktu habis, menjadi `time limit`;
# 137 sebelum batas waktu habis (misalnya batas memori) menjadi `killed`; selain itu kategori cadangan.
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

# /backup wajib direktori yang dapat dibaca user container dengan mode 0700. `create` juga mensyaratkan dapat ditulis;
# `check` memakai pemeriksaan yang sama tanpa syarat itu (tabel Check, langkah 1).
#   check_directory [writable]
check_directory() {
  if [[ ! -d $BACKUP_DIR || ! -r $BACKUP_DIR || ! -x $BACKUP_DIR ]]; then
    fail 'Backup directory unavailable'
  fi
  if [[ ${1:-} == writable && ! -w $BACKUP_DIR ]]; then
    fail 'Backup directory unavailable'
  fi
  local mode
  mode=$(stat -c %a -- "$BACKUP_DIR") || fail 'Backup directory unavailable'
  [[ $mode == 700 ]] || fail 'Backup directory must be mode 0700'
}

# Stempel YYYYMMDDTHHMMSSZ dari nama backup dalam bentuk ISO YYYY-MM-DDTHH:MM:SSZ, karena GNU date di image menolak
# bentuk stempel.
#   stamp_iso <nama backup>
stamp_iso() {
  local stamp=${1:11:16}
  printf '%s\n' "${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
}

# Umur dari nama: `date -u` container sekarang dikurangi waktu stempel nama, dalam detik; umur negatif (jam container
# mundur) dihitung 0. Mengembalikan 1 bila stempel bukan tanggal yang sah.
#   stamp_age <nama backup> <sekarang, detik epoch>
stamp_age() {
  local now=$2 iso epoch age
  iso=$(stamp_iso "$1") || return 1
  epoch=$(date -u -d "$iso" +%s) || return 1
  age=$(( now - epoch ))
  if (( age < 0 )); then
    age=0
  fi
  printf '%s\n' "$age"
}

# Backup lengkap: ketiga file nya ada sebagai file biasa, bukan symlink.
#   is_complete <nama backup>
is_complete() {
  local file
  for file in "$1.dump" "$1.dump.sha256" "$1.json"; do
    if [[ -L $BACKUP_DIR/$file || ! -f $BACKUP_DIR/$file ]]; then
      return 1
    fi
  done
}

# Nama backup lengkap di root /backup, naik menurut nama (urutan glob dengan LC_ALL=C, jadi menurut stempel waktu).
complete_names=()
list_complete() {
  local path name
  complete_names=()
  for path in "$BACKUP_DIR"/foundation-*.dump; do
    name=${path##*/}
    name=${name%.dump}
    if [[ $name =~ $NAME_PATTERN ]] && is_complete "$name"; then
      complete_names+=("$name")
    fi
  done
}

# Retensi (tabel Retensi), dijalankan `create` hanya sesudah backup baru lengkap. Fungsi ini dipanggil di dalam `if`,
# sehingga set -e tidak berlaku di sini: setiap langkah yang gagal mengembalikan 1 secara eksplisit dan menghentikan
# retensi, lalu pemanggil mencetak `Retention failed`. Hanya entri langsung di /backup yang berupa file biasa yang dapat
# dihapus; subfolder, symlink, dan file lain tidak pernah disentuh.
retention() {
  local now index name age path file mtime kept=0
  now=$(date -u +%s) || return 1
  list_complete || return 1
  # Backup lengkap menurun menurut nama: tujuh pertama selalu disimpan, sisanya yang lebih tua dari 35 hari dihapus
  # berurutan manifest, checksum, dump, dengan satu baris per backup.
  for (( index = ${#complete_names[@]} - 1; index >= 0; index-- )); do
    name=${complete_names[index]}
    kept=$(( kept + 1 ))
    if (( kept <= RETENTION_KEEP )); then
      continue
    fi
    age=$(stamp_age "$name" "$now") || return 1
    if (( age > RETENTION_DAYS * 86400 )); then
      rm -- "$BACKUP_DIR/$name.json" || return 1
      rm -- "$BACKUP_DIR/$name.dump.sha256" || return 1
      rm -- "$BACKUP_DIR/$name.dump" || return 1
      printf 'Backup removed: %s\n' "$name" || return 1
    fi
  done
  # File sisa dalam urutan nama, sesudah semua baris `Backup removed`: `.partial` yang cocok PARTIAL_PATTERN menurut umur
  # mtime, dan file berpola backup dari set yang tidak lengkap menurut umur stempel nama; dihapus bila lebih tua dari 24
  # jam. Kedua glob terurut LC_ALL=C, dan setiap `.foundation-*` berada sebelum `foundation-*`. Nama `.foundation-*.partial`
  # lain tidak pernah disentuh atau dicetak, sehingga nama berisi baris baru tidak dapat menyisipkan baris palsu, misalnya
  # `Backup created:`, ke log penjadwal yang menjadi catatan sha256 independen.
  for path in "$BACKUP_DIR"/.foundation-*.partial "$BACKUP_DIR"/foundation-*; do
    file=${path##*/}
    if [[ -L $path || ! -f $path ]]; then
      continue
    fi
    if [[ $file == .foundation-*.partial ]]; then
      [[ $file =~ $PARTIAL_PATTERN ]] || continue
      mtime=$(stat -c %Y -- "$path") || return 1
      age=$(( now - mtime ))
      if (( age < 0 )); then
        age=0
      fi
    else
      case $file in
        *.dump) name=${file%.dump} ;;
        *.dump.sha256) name=${file%.dump.sha256} ;;
        *.json) name=${file%.json} ;;
        *) continue ;;
      esac
      if [[ ! $name =~ $NAME_PATTERN ]] || is_complete "$name"; then
        continue
      fi
      age=$(stamp_age "$name" "$now") || return 1
    fi
    if (( age > LEFTOVER_SECONDS )); then
      rm -- "$path" || return 1
      printf 'Leftover removed: %s\n' "$file" || return 1
    fi
  done
}

# Check (tabel Check), berhenti pada langkah pertama yang gagal: folder, backup lengkap terbaru, checksum lebih dulu dari
# umur (format baris lalu sha256sum seperti langkah 4 Urutan restore), lalu umur paling lama 26 jam. `<jam>` adalah umur
# detik dibagi 3.600 dibulatkan ke bawah. Stempel yang bukan tanggal sah berakhir di trap EXIT (`internal`).
check() {
  check_directory
  list_complete
  if (( ${#complete_names[@]} == 0 )); then
    fail 'No backup found'
  fi
  local name=${complete_names[-1]}
  local checksum_lines=()
  mapfile -t checksum_lines <"$BACKUP_DIR/$name.dump.sha256" || fail "Backup checksum mismatch: $name"
  if [[ ${#checksum_lines[@]} -ne 1 || ! ${checksum_lines[0]} =~ ^[0-9a-f]{64}\ \ ${name}\.dump$ ]]; then
    fail "Backup checksum mismatch: $name"
  fi
  if ! (cd "$BACKUP_DIR" && sha256sum --check --strict --status "$name.dump.sha256"); then
    fail "Backup checksum mismatch: $name"
  fi
  local now age
  now=$(date -u +%s)
  age=$(stamp_age "$name" "$now")
  if (( age > CHECK_LIMIT_SECONDS )); then
    fail "Latest backup too old: $name ($(( age / 3600 )) h old)"
  fi
  printf 'Latest backup: %s (%s h old)\n' "$name" "$(( age / 3600 ))"
}

create() {
  local reason=$1
  [[ -n $FOUNDATION_BACKUP_DATABASE_URL ]] || fail 'Missing FOUNDATION_BACKUP_DATABASE_URL'
  check_directory writable
  local stamp name
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  name="foundation-$stamp-$reason"
  [[ $name =~ $NAME_PATTERN ]] || fail 'Backup failed: internal'
  local dump="$name.dump" checksum="$name.dump.sha256" manifest="$name.json"
  local file
  for file in "$dump" "$checksum" "$manifest" ".$dump.partial" ".$checksum.partial" ".$manifest.partial"; do
    if [[ -e $BACKUP_DIR/$file || -L $BACKUP_DIR/$file ]]; then
      fail "Backup already exists: $name"
    fi
  done

  # Password ke PGPASSWORD, sisa DSN ke dsn_address (split_dsn), sebelum alat PostgreSQL pertama.
  split_dsn "$FOUNDATION_BACKUP_DATABASE_URL" || fail 'Backup failed: invalid connection string'
  # Role login wajib foundation_backup (invariant 3): role lain yang dapat SET ROLE pg_read_all_data, misalnya superuser
  # foundation_admin, ditolak sebelum pg_dump dengan kategori permission denied.
  local role_output="$WORK_DIR/psql.out" role_errors="$WORK_DIR/psql.err" started ended
  started=$(date +%s%3N)
  background timeout --signal=TERM --kill-after=10s 60 psql -X -w -At -v ON_ERROR_STOP=1 --dbname="$dsn_address" -c 'SELECT session_user' >"$role_output" 2>"$role_errors"
  ended=$(date +%s%3N)
  if (( child_status != 0 )); then
    fail "Backup failed: $(category "$role_errors" "$child_status" "$(( ended - started ))" "$QUERY_LIMIT_SECONDS" pg_dump)"
  fi
  [[ $(<"$role_output") == foundation_backup ]] || fail 'Backup failed: permission denied'

  local partial_dump="$BACKUP_DIR/.$dump.partial"
  local partial_checksum="$BACKUP_DIR/.$checksum.partial"
  local partial_manifest="$BACKUP_DIR/.$manifest.partial"
  local dump_output="$WORK_DIR/pg_dump.out"
  run_files+=("$partial_dump")
  started=$(date +%s%3N)
  background timeout --signal=TERM --kill-after=30s 3600 pg_dump --dbname="$dsn_address" --role=pg_read_all_data --format=custom --compress=zstd --no-password --lock-wait-timeout=30s --file=/backup/.$name.dump.partial >"$dump_output" 2>&1
  ended=$(date +%s%3N)
  if (( child_status != 0 )); then
    fail "Backup failed: $(category "$dump_output" "$child_status" "$(( ended - started ))" "$DUMP_LIMIT_SECONDS" pg_dump)"
  fi

  # Header archive sebelum mv (baris Header archive): pg_restore --list keluar 0 dan memuat versi server dan pg_dump
  # (selain itu archive invalid), lalu database foundation dan data common.schema_migrations (selain itu wrong
  # database, misalnya DSN ke database postgres yang tetap dapat dimasuki role backup).
  local list="$WORK_DIR/pg_restore.list"
  background pg_restore --list "$partial_dump" >"$list" 2>"$WORK_DIR/pg_restore.err"
  (( child_status == 0 )) || fail 'Backup failed: archive invalid'
  local server_version dump_version toc_entries
  server_version=$(sed -n 's/^;[[:space:]]*Dumped from database version: \([^ ]*\).*$/\1/p' "$list" | head -n 1)
  dump_version=$(sed -n 's/^;[[:space:]]*Dumped by pg_dump version: \([^ ]*\).*$/\1/p' "$list" | head -n 1)
  if [[ ! $server_version =~ $VERSION_PATTERN || ! $dump_version =~ $VERSION_PATTERN ]]; then
    fail 'Backup failed: archive invalid'
  fi
  if ! grep -qx -- ';     dbname: foundation' "$list" || ! grep -qE -- "$TOC_MIGRATIONS" "$list"; then
    fail 'Backup failed: wrong database'
  fi
  toc_entries=$(grep -cv -e '^;' -e '^[[:space:]]*$' -- "$list" || true)

  local hash size
  hash=$(sha256sum -- "$partial_dump" | cut -d ' ' -f 1)
  size=$(stat -c %s -- "$partial_dump")
  [[ $hash =~ ^[0-9a-f]{64}$ && $size =~ ^[0-9]+$ ]] || fail 'Backup failed: internal'
  local created_at
  created_at=$(stamp_iso "$name")

  run_files+=("$partial_checksum")
  printf '%s  %s\n' "$hash" "$dump" >"$partial_checksum"
  run_files+=("$partial_manifest")
  printf '{"schema":1,"name":"%s","dump":"%s","createdAt":"%s","reason":"%s","database":"foundation","format":"custom","compression":"zstd","globals":false,"serverVersion":"%s","pgDumpVersion":"%s","sizeBytes":%s,"sha256":"%s","tocEntries":%s,"durationMs":%s}\n' \
    "$name" "$dump" "$created_at" "$reason" "$server_version" "$dump_version" "$size" "$hash" "$toc_entries" "$(( ended - started ))" >"$partial_manifest"

  # Urutan tetap: dump, checksum, lalu manifest sebagai penanda backup lengkap, diikuti sync. Kegagalan mv atau sync
  # menghentikan script lewat set -e, dan trap EXIT mencetak `Backup failed: internal`.
  run_files+=("$BACKUP_DIR/$dump")
  mv -- "$partial_dump" "$BACKUP_DIR/$dump"
  run_files+=("$BACKUP_DIR/$checksum")
  mv -- "$partial_checksum" "$BACKUP_DIR/$checksum"
  run_files+=("$BACKUP_DIR/$manifest")
  mv -- "$partial_manifest" "$BACKUP_DIR/$manifest"
  sync
  done=1
  printf 'Backup created: %s (%s bytes, sha256 %s)\n' "$dump" "$size" "$hash"

  # Retensi hanya sesudah backup baru lengkap. Kegagalannya keluar 1 dengan `Retention failed` sesudah baris di atas;
  # backup baru tetap lengkap, karena run sudah done dan trap tidak menghapus file nya.
  if ! retention; then
    fail 'Retention failed'
  fi
}

if [[ $# -eq 2 && $1 == create ]]; then
  case $2 in
    scheduled | pre-migration | manual) create "$2" ;;
    *) fail "$USAGE" ;;
  esac
elif [[ $# -eq 1 && $1 == check ]]; then
  check
else
  fail "$USAGE"
fi
