#!/bin/sh
# Entrypoint edge Foundation (spec 0012, baris foundation-edge pada tabel Konfigurasi edge).
# Membaca FOUNDATION_BACKEND_UPSTREAM dan nameserver pertama /etc/resolv.conf, menulis /tmp/nginx/upstream.conf, lalu
# menjalankan nginx di latar depan. Nilai yang tidak sah mencetak satu pesan tetap ke stderr dan keluar 1 tanpa
# menjalankan nginx.
set -eu

invalid() {
  echo 'Edge configuration invalid' >&2
  exit 1
}

newline='
'

upstream=${FOUNDATION_BACKEND_UPSTREAM-}
case $upstream in
  *"$newline"*) invalid ;;
esac
printf '%s\n' "$upstream" | grep -Eqx '[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[0-9]{1,5}' || invalid

nameserver=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf 2>/dev/null) || invalid
case $nameserver in
  *"$newline"*) invalid ;;
esac
if printf '%s\n' "$nameserver" | grep -Eqx '([0-9]{1,3}\.){3}[0-9]{1,3}'; then
  resolver=$nameserver
elif printf '%s\n' "$nameserver" | grep -Eqx '[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*'; then
  resolver="[$nameserver]"
else
  invalid
fi

mkdir -p -m 0700 /tmp/nginx || invalid
chmod 0700 /tmp/nginx || invalid
printf 'resolver %s valid=10s ipv6=off;\nserver %s resolve;\n' "$resolver" "$upstream" > /tmp/nginx/upstream.conf || invalid

exec nginx -e stderr -g 'daemon off;'
