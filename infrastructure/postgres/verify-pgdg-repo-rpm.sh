#!/usr/bin/bash
set -Eeuo pipefail

if [ "$#" -ne 3 ]; then
  echo "Pemakaian: verify-pgdg-repo-rpm.sh KEY_FILE RPM_FILE EXPECTED_FINGERPRINT" >&2
  exit 2
fi

keyfile="$1"
rpmfile="$2"
expected="$3"
if [[ ! "$expected" =~ ^[A-F0-9]{40}$ ]]; then
  echo "Fingerprint key PGDG tidak valid." >&2
  exit 2
fi

gpg_home="$(mktemp -d /tmp/pgdg-gpg.XXXXXXXX)"
keydb=""
chmod 700 "$gpg_home"
cleanup() {
  if [[ -n "$keydb" ]]; then rm -rf -- "$keydb"; fi
  rm -rf -- "$gpg_home"
}
trap cleanup EXIT
if ! key_listing="$(gpg --homedir "$gpg_home" --batch --with-colons --import-options show-only --dry-run --import "$keyfile" 2>/dev/null)"; then
  echo "File key PGDG tidak dapat dibaca sebagai public key OpenPGP." >&2
  exit 1
fi
if ! primary_fingerprints="$(printf '%s\n' "$key_listing" | awk -F: '
  $1 == "pub" { count++; waiting = 1; next }
  $1 == "fpr" && waiting { print toupper($10); fingerprints++; waiting = 0; next }
  waiting { invalid = 1; waiting = 0 }
  END { if (count != 1 || fingerprints != 1 || waiting || invalid) exit 1 }
')" || [ "$primary_fingerprints" != "$expected" ]; then
  echo "File key PGDG harus berisi tepat satu public key dengan fingerprint yang diharapkan." >&2
  exit 1
fi

expected_key_id="$(printf '%s' "${expected: -8}" | tr A-F a-f)"
keydb="$(mktemp -d /tmp/pgdg-keydb.XXXXXXXX)"
rpm --dbpath "$keydb" --initdb
rpmkeys --dbpath "$keydb" --import "$keyfile"
imported_key_ids="$(rpm --dbpath "$keydb" -q gpg-pubkey --qf '%{VERSION}\n' | tr A-F a-f)"
[ "$imported_key_ids" = "$expected_key_id" ] || {
  echo "File key PGDG memuat public key RPM lain yang tidak disetujui." >&2
  exit 1
}

rpmkeys --import "$keyfile"
trusted_keys="$(rpmkeys --list | tr A-F a-f)"
grep -Fq "$expected_key_id" <<< "$trusted_keys" || { echo "Key PGDG yang diimpor tidak sesuai." >&2; exit 1; }

signature="$(rpmkeys --define '_pkgverify_level all' --checksig --verbose "$rpmfile")"
printf '%s\n' "$signature"
grep -Eiq "key ID $expected_key_id: OK" <<< "$signature" || {
  echo "Signature repo RPM bukan dari key PGDG yang diharapkan." >&2
  exit 1
}

rpm --define '_pkgverify_level all' -i "$rpmfile"
