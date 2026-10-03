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

COPY --chmod=0755 verify-pgdg-repo-rpm.sh /tmp/verify-pgdg-repo-rpm.sh

# Repo PGDG dipilih per arsitektur. Fingerprint key PGDG adalah konstanta; build gagal bila berbeda.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) key=PGDG-RPM-GPG-KEY-RHEL; expected=D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20 ;; \
      aarch64) key=PGDG-RPM-GPG-KEY-AARCH64-RHEL; expected=B031F89FC983E98262906B6E177B343BB9738825 ;; \
      *) echo "Arsitektur $arch tidak didukung." >&2; exit 1 ;; \
    esac; \
    gpg_packages_before="$(rpm -qa --qf '%{NAME}\n' | grep -Ev '^(gpg-pubkey|pgdg-redhat-repo)$' | sort -u)"; \
    microdnf -y --nodocs install gnupg2; \
    keyfile="/tmp/$key"; \
    curl -fsSL --proto '=https' --tlsv1.2 -o "$keyfile" \
      "https://download.postgresql.org/pub/repos/yum/keys/$key"; \
    curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/pgdg-repo.rpm \
      "https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-$arch/pgdg-redhat-repo-latest.noarch.rpm"; \
    /tmp/verify-pgdg-repo-rpm.sh "$keyfile" /tmp/pgdg-repo.rpm "$expected"; \
    mapfile -t gpg_packages_added < <(comm -13 <(printf '%s\n' "$gpg_packages_before") <(rpm -qa --qf '%{NAME}\n' | grep -Ev '^(gpg-pubkey|pgdg-redhat-repo)$' | sort -u)); \
    if ((${#gpg_packages_added[@]})); then microdnf -y remove "${gpg_packages_added[@]}"; fi; \
    rm -f /tmp/verify-pgdg-repo-rpm.sh; \
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
    rm -rf /tmp/pgdg-repo.rpm "$keyfile" /var/cache/dnf /var/log/dnf*; \
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
