# syntax=docker/dockerfile:1
# Multi-stage build: compile Solanum in a builder stage, ship only the
# runtime artifacts in the final image (no toolchain inside the container).

FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    meson \
    ninja-build \
    flex \
    bison \
    pkg-config \
    libsqlite3-dev \
    libltdl-dev \
    libssl-dev \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin to an exact upstream commit (Solanum has no release tags).
ARG SOLANUM_COMMIT=92afd03482ae6b0df1c5ba1d6b8886d2d626dbf3

WORKDIR /usr/src/solanum
RUN git init \
    && git remote add origin https://github.com/solanum-ircd/solanum.git \
    && git fetch --depth 1 origin "${SOLANUM_COMMIT}" \
    && git checkout FETCH_HEAD

RUN meson setup build --prefix=/usr/local --buildtype=release \
    && meson compile -C build \
    && meson install -C build

# ---------------------------------------------------------------------------

FROM debian:bookworm-slim

# Runtime deps only: TLS (libssl3), ban.db (libsqlite3-0), module loader
# (libltdl7), /etc/services + /etc/protocols (netbase — required by authd's
# getaddrinfo DNS lookup), CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 \
    libsqlite3-0 \
    libltdl7 \
    netbase \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # meson install registers /usr/local/lib/<triplet> for the dynamic linker
    && echo "/usr/local/lib/x86_64-linux-gnu" > /etc/ld.so.conf.d/solanum.conf \
    && ldconfig

COPY --from=builder /usr/local /usr/local

# bandb's SQLite ban.db lives at the compile-time DBPATH /var/local/ban.db
# (the -banfile CLI flag is dead code in this Solanum version), so /var/local
# must be writable by ircd.
RUN useradd -r -u 1001 -d /var/lib/solanum ircd \
    && mkdir -p /var/log/solanum /var/lib/solanum /var/local \
    && chown -R ircd:ircd /var/log/solanum /var/lib/solanum /var/local /usr/local

USER ircd

VOLUME ["/etc/solanum"]

COPY --chmod=755 entrypoint.sh /entrypoint.sh

EXPOSE 6667 6697

ENTRYPOINT ["/entrypoint.sh"]
