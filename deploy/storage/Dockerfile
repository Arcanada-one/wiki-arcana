FROM pgvector/pgvector:pg18@sha256:42e7f6b4e1eceb02ff14e3e6bc6108bbe259abbe83879dc1845d0da1ddeb555d AS age-builder

USER root

RUN snapshot='20260505T000000Z' \
    && printf '%s\n' \
        'Types: deb' \
        "URIs: http://snapshot.debian.org/archive/debian/${snapshot}" \
        'Suites: bookworm bookworm-updates' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        '' \
        'Types: deb' \
        "URIs: http://snapshot.debian.org/archive/debian-security/${snapshot}" \
        'Suites: bookworm-security' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/debian.sources \
    && apt-get \
        -o Dir::Etc::sourcelist='sources.list.d/debian.sources' \
        -o Dir::Etc::sourceparts='-' \
        update \
    && apt-get \
        -o Dir::Etc::sourcelist='sources.list.d/debian.sources' \
        -o Dir::Etc::sourceparts='-' \
        install --yes --no-install-recommends \
        bison \
        build-essential \
        ca-certificates \
        curl \
        flex \
        git \
        libreadline-dev \
        zlib1g-dev \
    && pg_dev_version='18.4-1.pgdg12+1' \
    && pg_dev_sha256='bb45f27f6072e8109b9a67e390ff0139ab493f681ec05d1cfed139b101187c00' \
    && libpq_dev_sha256='f9172951259bc897a10ecefc046074ba3beb3acfda7131d34b29627574c45c40' \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        "https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-server-dev-18_${pg_dev_version}_amd64.deb" \
        --output /tmp/postgresql-server-dev-18.deb \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        "https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/libpq-dev_${pg_dev_version}_amd64.deb" \
        --output /tmp/libpq-dev.deb \
    && printf '%s  %s\n' \
        "$pg_dev_sha256" /tmp/postgresql-server-dev-18.deb \
        "$libpq_dev_sha256" /tmp/libpq-dev.deb \
        | sha256sum --check --strict \
    && apt-get \
        -o Dir::Etc::sourcelist='sources.list.d/debian.sources' \
        -o Dir::Etc::sourceparts='-' \
        install --yes --no-install-recommends \
        /tmp/libpq-dev.deb \
        /tmp/postgresql-server-dev-18.deb \
    && rm -f /tmp/libpq-dev.deb /tmp/postgresql-server-dev-18.deb \
    && rm -rf /var/lib/apt/lists/*

RUN age_commit='806fa2ebdb300b3e76ef30cdba61803babbf2683' \
    && git init /tmp/age \
    && git -C /tmp/age remote add origin https://github.com/apache/age.git \
    && git -C /tmp/age fetch --depth 1 origin "$age_commit" \
    && git -C /tmp/age checkout --detach FETCH_HEAD \
    && cd /tmp/age \
    && test "$(git rev-parse HEAD)" = "$age_commit" \
    && make PG_CONFIG=/usr/bin/pg_config -j"$(nproc)" \
    && make PG_CONFIG=/usr/bin/pg_config DESTDIR=/age-install install

FROM pgvector/pgvector:pg18@sha256:42e7f6b4e1eceb02ff14e3e6bc6108bbe259abbe83879dc1845d0da1ddeb555d AS runtime

LABEL org.opencontainers.image.base.name="pgvector/pgvector:pg18" \
      org.opencontainers.image.base.digest="sha256:42e7f6b4e1eceb02ff14e3e6bc6108bbe259abbe83879dc1845d0da1ddeb555d" \
      org.opencontainers.image.build.snapshot.debian="http://snapshot.debian.org/archive/debian/20260505T000000Z" \
      org.opencontainers.image.build.snapshot.debian-security="http://snapshot.debian.org/archive/debian-security/20260505T000000Z" \
      org.opencontainers.image.build.postgresql-server-dev.version="18.4-1.pgdg12+1" \
      org.opencontainers.image.build.postgresql-server-dev.sha256="bb45f27f6072e8109b9a67e390ff0139ab493f681ec05d1cfed139b101187c00" \
      org.opencontainers.image.build.libpq-dev.sha256="f9172951259bc897a10ecefc046074ba3beb3acfda7131d34b29627574c45c40" \
      org.opencontainers.image.source="https://github.com/Arcanada-one/wiki-arcana" \
      org.postgresql.version.major="18" \
      org.apache.age.revision="806fa2ebdb300b3e76ef30cdba61803babbf2683"

COPY --from=age-builder /age-install/usr/lib/postgresql/18/lib/age.so /usr/lib/postgresql/18/lib/age.so
COPY --from=age-builder /age-install/usr/share/postgresql/18/extension/age.control /usr/share/postgresql/18/extension/age.control
COPY --from=age-builder /age-install/usr/share/postgresql/18/extension/age--*.sql /usr/share/postgresql/18/extension/
