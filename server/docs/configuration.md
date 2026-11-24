# Konfigurasi

## Prerequisite: `.env` + sertifikat

```bash
cd server
cp .env.example .env          # isi password/port sesuai kebutuhan
./scripts/generate-certs.sh   # generate TLS cert self-signed (sekali saja)
docker compose up -d --build
```

- `.env` — gitignored; berisi link password, password user soju,
  kredensial postgres (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`),
  port host, subnet, `ATHEME_HOST`.
- `scripts/generate-certs.sh` — generate cert solanum (`ssl-*.pem`, `dh.pem`)
  dan soju (`tls-*.pem`) dengan SAN `irc.solanum.test,localhost,127.0.0.1`.
  Semua file cert **di-gitignore** — regenerate dengan script ini.
- Password link disuntik via **templating**: `*.conf.tmpl` di-render oleh
  entrypoint container memakai env dari `.env` (via `env_file`).

## docker-compose.yml

Empat service dalam bridge network `ircnet` (subnet dari `IRC_SUBNET`,
default `172.30.99.0/24`). IP statis dipakai untuk semua container:

| Service   | IP            | Ports ke host (default)                    |
|-----------|---------------|--------------------------------------------|
| solanum   | 172.30.99.10  | `6667` plain, `6697` TLS                  |
| atheme    | 172.30.99.20  | tidak ada (internal)                       |
| soju      | 172.30.99.30  | `16667` plain, `16697` TLS                 |
| postgres  | 172.30.99.40  | tidak ada (internal)                       |

Kenapa IP statis: `connect` block solanum mencocokkan `host` terhadap IP
peer — nama docker DNS (`atheme`) **tidak** cocok (error `Invalid host`).
`ATHEME_HOST` di `.env` harus sama dengan `ipv4_address` atheme.

Image di-pin:

- solanum: build dari commit persis (`SOLANUM_COMMIT`, default HEAD yang
  teruji `92afd03…`) — Solanum tidak punya tag rilis.
- atheme/soju: pinned by `@sha256:` digest — reproducible, tidak ikut
  `latest` yang berubah.

Healthcheck + `depends_on: service_healthy`:

- solanum: bash `/dev/tcp` ke `127.0.0.1:6667`
- atheme: `pgrep atheme-services` + `nc -z solanum 6667`
- soju: `sojuctl server status`
- postgres: `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB`

Logging: semua service pakai json-file driver `max-size: 10m, max-file: 3`
(anchor `x-logging`) supaya log docker tidak memenuhi disk.

Volumes:

- `solanum-logs` → `/var/log/solanum`
- `solanum-state` → `/var/local` — **ban.db solanum ada di `/var/local/ban.db`**
  (path compile-time `DBPATH`; flag `-banfile` adalah dead code seperti
  `-motdfile`)
- `atheme-data` → `/atheme/var`
- `postgres-data` → `/var/lib/postgresql/data` — DB `soju` (users,
  networks, channels, message history)
- `soju-db` → `/db` — admin socket `soju-admin.sock` (+ sisa `soju.db`
  sqlite dari sebelum migrasi)
- `soju-uploads` → `/uploads`

Bind mounts:

- `./solanum/etc` → `/etc/solanum` (ro) — `ircd.conf.tmpl`, motd, cert
- `./solanum/etc/motd` → `/usr/local/etc/ircd.motd` (ro)
- `./atheme/etc` → `/atheme/etc` — `atheme.conf.tmpl`; `atheme.conf` hasil
  render di-generate di sini (gitignored); `services.db` persisten
- `./atheme/entrypoint.sh` → `/render-entrypoint.sh` (ro) — render lalu
  delegasi ke `/entrypoint.sh` bawaan image
- `./soju/config` → `/soju-config` (ro), `./soju` → `/soju-tls` (ro)

## solanum/Dockerfile

Multi-stage: `builder` (debian slim + toolchain + git) compile meson →
`stage-1` runtime slim hanya berisi `/usr/local` hasil install + library
runtime (`libssl3`, `libsqlite3-0`, `libltdl7`, `netbase`, `ca-certificates`).
Image runtime ~ratusan MB, tanpa gcc/git/meson.

Build arg `SOLANUM_COMMIT` (default SHA yang teruji) di-fetch dengan
`git fetch --depth 1 origin <sha>` — reproducible.

Catatan dependency yang pernah jadi masalah:

- `netbase` wajib ( `/etc/services`, `/etc/protocols` ) untuk `getaddrinfo`
  → authd.
- `/var/local` harus writable `ircd` — ban.db SQLite bandb.
- User `ircd` uid 1001 — solanum menolak root.
- `/etc/ld.so.conf.d/solanum.conf` didaftarkan manual untuk
  `/usr/local/lib/x86_64-linux-gnu`.

## solanum/entrypoint.sh

1. Hapus stale pidfile.
2. Render `/etc/solanum/ircd.conf.tmpl` → `/tmp/ircd.conf` via `sed`,
   substitusi `__LINK_SOLANUM_SEND__`, `__LINK_SOLANUM_ACCEPT__`,
   `__ATHEME_HOST__` dari env.
3. `exec solanum -foreground -configfile /tmp/ircd.conf ...`

## solanum/etc/ircd.conf.tmpl

Sama seperti konfig sebelumnya, bedanya blok `connect "services.int"`:

```conf
connect "services.int" {
	host = "__ATHEME_HOST__";              # → 172.30.99.20 dari .env
	send_password = "__LINK_SOLANUM_SEND__";
	accept_password = "__LINK_SOLANUM_ACCEPT__";
	port = 6667;
	class = "server";
	flags = topicburst;
};
```

Arah password (mudah tertukar):

- solanum `send_password` = password yang solanum kirim = Atheme
  `receive_password` → env `LINK_SOLANUM_SEND`
- solanum `accept_password` = password yang diharapkan solanum = Atheme
  `send_password` → env `LINK_SOLANUM_ACCEPT`

## atheme/etc/atheme.conf.tmpl + entrypoint.sh

`atheme.conf.tmpl` = config Atheme 7.2 dengan dua placeholder di blok
`uplink "irc.solanum.test"`:

```conf
send_password = "__LINK_SOLANUM_ACCEPT__";     # = solanum accept_password
receive_password = "__LINK_SOLANUM_SEND__";    # = solanum send_password
```

`atheme/entrypoint.sh` me-render ke `/atheme/etc/atheme.conf` lalu
`exec /entrypoint.sh` (entrypoint asli image: cek writable + start
`atheme-services -n`).

Module aktif: `modules/protocol/charybdis` (kompatibel solanum),
`modules/backend/opensex`, `modules/crypto/pbkdf2v2`, services standar.
`#mta` dikomentari — email mati.

## soju/config

Tidak ada secret di dalamnya — password user/network dibuat via `sojuctl`
(**otomatis oleh test** `tests/test_soju.py`, idempotent).

Directive penting:

- `auth internal` — user disimpan di **PostgreSQL** (`db postgres`, schema
  dibuat otomatis oleh soju saat startup)
- `disable-inactive-user 30d` — user yang disconnect >30 hari di-disable:
  upstream diputus (tidak ada ghost session di solanum), data tetap utuh
- `enable-user-on-auth true` — login SASL sukses me-re-enable user
  otomatis, jadi user yang absen lama bisa langsung balik tanpa intervensi admin
- `message-store db` + `message-expiry 365d` — history pesan di PostgreSQL
  (tabel `Message` + `MessageTarget`, full-text search index); pesan lebih
  tua dari 365 hari dihapus harian supaya tabel tidak tumbuh tak terbatas
- `listen unix+admin:///db/soju-admin.sock` — socket admin untuk `sojuctl`
  (tetap di volume `soju-db`, bukan postgres)

Password postgres **tidak ditulis di config** — `db postgres` connection
string tidak berisi password; soju membaca env `PGPASSWORD` (di-set di
`docker-compose.yml` dari `POSTGRES_PASSWORD` di `.env`). Image soju
distroless (tanpa shell) jadi tidak bisa templating — env var adalah
satu-satunya jalur secret.

## scripts/generate-certs.sh

Generate ulang semua cert dengan SAN. Jalankan saat:

- pertama kali setup (file cert di-gitignore)
- cert mau di-rotate

```bash
cd server && ./scripts/generate-certs.sh
```
