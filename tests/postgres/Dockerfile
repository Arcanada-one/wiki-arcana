FROM postgres:16.10-bookworm@sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74

ARG AGE_COMMIT=2db2f060c4c9265a14d40f007eb8c56febf31e4c
ARG PGVECTOR_COMMIT=cab9da72c04353f143bb06b42ab70a403daac64a

RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    bison \
    build-essential \
    ca-certificates \
    curl \
    flex \
    libreadline-dev \
    libssl-dev \
    libxml2-dev \
    libxslt1-dev \
    postgresql-server-dev-16 \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN set -euxo pipefail; \
  mkdir -p /tmp/age /tmp/pgvector; \
  curl --fail --location --silent --show-error "https://codeload.github.com/apache/age/tar.gz/${AGE_COMMIT}" \
    | tar -xz --strip-components=1 -C /tmp/age; \
  make -C /tmp/age PG_CONFIG="$(command -v pg_config)" install; \
  curl --fail --location --silent --show-error "https://codeload.github.com/pgvector/pgvector/tar.gz/${PGVECTOR_COMMIT}" \
    | tar -xz --strip-components=1 -C /tmp/pgvector; \
  make -C /tmp/pgvector PG_CONFIG="$(command -v pg_config)" install; \
  rm -rf /tmp/age /tmp/pgvector
