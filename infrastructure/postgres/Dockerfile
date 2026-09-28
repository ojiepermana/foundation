# Server PostgreSQL 18 Foundation (spec 0002): Oracle Linux 10 slim dengan paket resmi PGDG.
# Tanpa pin: tag oraclelinux:10-slim dan paket 18 terbaru. Test dan CI mengisi pin dari pins.json.
# Tidak ada password atau secret pada ARG, ENV, maupun layer; password hanya diberikan saat runtime.
ARG BASE_IMAGE=oraclelinux:10-slim
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG POSTGRES_PACKAGE_VERSION=

LABEL org.opencontainers.image.title="foundation-postgres" \
      org.opencontainers.image.description="PostgreSQL 18 dari PGDG di atas Oracle Linux 10 slim" \
      org.opencontainers.image.base.name="${BASE_IMAGE}"

SHELL ["/bin/bash", "-Eeuo", "pipefail", "-c"]

# Repo PGDG dipilih per arsitektur. Fingerprint key PGDG adalah konstanta; build gagal bila berbeda.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) key=PGDG-RPM-GPG-KEY-RHEL; expected=D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20 ;; \
      aarch64) key=PGDG-RPM-GPG-KEY-AARCH64-RHEL; expected=B031F89FC983E98262906B6E177B343BB9738825 ;; \
      *) echo "Arsitektur $arch tidak didukung." >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/pgdg-repo.rpm \
      "https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-$arch/pgdg-redhat-repo-latest.noarch.rpm"; \
    rpm -i --nosignature /tmp/pgdg-repo.rpm; \
    keyfile="/etc/pki/rpm-gpg/$key"; \
    # Fingerprint V4 adalah SHA1 dari paket public key pertama (tag lama 0x99 dengan panjang 2 byte).
    sed -e '1,/^$/d' -e '/^[=-]/,$d' "$keyfile" | base64 -d > /tmp/pgdg-key.bin; \
    header="$(od -An -tx1 -N3 /tmp/pgdg-key.bin | tr -d ' \n')"; \
    [[ "$header" == 99* ]] || { echo "Format key PGDG tidak dikenali." >&2; exit 1; }; \
    actual="$(head -c "$(( 16#${header#99} + 3 ))" /tmp/pgdg-key.bin | sha1sum | cut -d' ' -f1 | tr a-f A-F)"; \
    [ "$actual" = "$expected" ] || { echo "Fingerprint key PGDG $actual tidak sama dengan $expected." >&2; exit 1; }; \
    known="$(rpmkeys --list | cut -d- -f1 | sort)"; \
    rpmkeys --import "$keyfile"; \
    added="$(comm -13 <(printf '%s\n' "$known") <(rpmkeys --list | cut -d- -f1 | sort))"; \
    [ "$added" = "$(printf '%s' "${expected: -8}" | tr A-F a-f)" ] || { echo "Key PGDG yang diimpor tidak sesuai." >&2; exit 1; }; \
    rpmkeys --checksig /tmp/pgdg-repo.rpm; \
    # microdnf tidak mengisi variabel rilis minor yang dipakai URL repo PGDG untuk EL 10.
    . /etc/os-release; \
    mkdir -p /etc/dnf/vars; \
    printf '%s\n' "${VERSION_ID%%.*}" > /etc/dnf/vars/releasever_major; \
    printf '%s\n' "${VERSION_ID#*.}" > /etc/dnf/vars/releasever_minor; \
    package=postgresql18-server; \
    if [ -n "$POSTGRES_PACKAGE_VERSION" ]; then package="postgresql18-server-$POSTGRES_PACKAGE_VERSION"; fi; \
    # tzdata dipasang karena server PGDG dibangun dengan --with-system-tzdata tetapi tidak mendeklarasikannya;
    # tanpa itu timezone menjadi UTC0 dan zona bernama seperti Asia/Jakarta ditolak.
    microdnf -y --nodocs --setopt=install_weak_deps=0 --disablerepo='pgdg*' --enablerepo=pgdg18 install "$package" tzdata; \
    installed="$(rpm -q --qf '%{VERSION}-%{RELEASE}' postgresql18-server)"; \
    if [ -n "$POSTGRES_PACKAGE_VERSION" ] && [ "$installed" != "$POSTGRES_PACKAGE_VERSION" ]; then \
      echo "Versi terpasang $installed tidak sama dengan pin $POSTGRES_PACKAGE_VERSION." >&2; exit 1; \
    fi; \
    if rpm -q postgresql18-contrib >/dev/null; then echo "postgresql18-contrib tidak boleh terpasang." >&2; exit 1; fi; \
    microdnf clean all; \
    rm -rf /tmp/pgdg-repo.rpm /tmp/pgdg-key.bin /var/cache/dnf /var/log/dnf*; \
    # Direktori data kosong dari paket dihapus agar volume baru selalu melewati inisialisasi staging.
    rmdir /var/lib/pgsql/18/data

ENV PATH=/usr/pgsql-18/bin:$PATH \
    PGDATA=/var/lib/pgsql/18/data \
    TZ=UTC

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/foundation-postgres-entrypoint

USER postgres
WORKDIR /var/lib/pgsql
EXPOSE 5432
# SIGINT memicu fast shutdown; SIGTERM bawaan Docker menunggu semua klien lalu terkena SIGKILL.
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/foundation-postgres-entrypoint"]
