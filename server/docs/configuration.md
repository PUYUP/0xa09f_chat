# Konfigurasi

## Prerequisite: `.env` + sertifikat

```bash
cd server
cp .env.example .env          # isi password/port sesuai kebutuhan
./scripts/generate-certs.sh   # generate TLS cert self-signed (sekali saja)
docker compose up -d --build
```

- `.env` — gitignored; berisi link password, `OPER_ADMIN_PASSWORD` (password
  oper `admin`, di-hash saat container start — lihat bawah), password user
  soju, kredensial postgres (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`),
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
| solanum   | 172.30.99.10  | `6667` plain, `6697` TLS, `16668` (soju→solanum, plaintext) |
| atheme    | 172.30.99.20  | tidak ada (internal)                       |
| soju      | 172.30.99.30  | `16667` plain, `16697` TLS                 |
| postgres  | 172.30.99.40  | tidak ada (internal)                       |

Kenapa IP statis: `connect` block solanum mencocokkan `host` terhadap IP
peer — nama docker DNS (`atheme`) **tidak** cocok (error `Invalid host`).
`ATHEME_HOST` di `.env` harus sama dengan `ipv4_address` atheme.
IP soju juga dipakai solanum sebagai satu-satunya alamat yang boleh login
sebagai user bouncer (lihat `docs/operations.md`, "Kenapa port 16668"); alamat
itu dibaca dari docker secret `secrets/soju-host.ip`, bukan dari `.env`.

Semua port di atas bind ke `${BIND_ADDR}` (default `127.0.0.1`), dengan
override per service: `SOLANUM_BIND`, `SOJU_BIND`, `SOLANUM_SOJU_BIND`.
Untuk host publik, biarkan plaintext di `127.0.0.1` dan hanya buka TLS.

Pengecualian: **mailpit selalu `127.0.0.1`** — inbox web-nya menampilkan
email reset password, jadi tidak boleh ikut `BIND_ADDR` ke interface publik.

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
2. Wajibkan env `LINK_SOLANUM_SEND`, `LINK_SOLANUM_ACCEPT`, dan
   `OPER_ADMIN_PASSWORD`; hash password oper via `openssl passwd -6`
   (charset dibatasi `[A-Za-z0-9._~+-]` supaya aman untuk substitusi sed).
3. Render `/etc/solanum/ircd.conf.tmpl` → `/tmp/ircd.conf` via `sed`,
   substitusi `__LINK_SOLANUM_SEND__`, `__LINK_SOLANUM_ACCEPT__`,
   `__ATHEME_HOST__`, `__SOJU_HOST__` (dari docker secret `soju-ip`), dan
   `__OPER_ADMIN_PASSWORD__` (hash di atas). Placeholder yang tersisa
   menggagalkan startup.
4. `exec solanum -foreground -configfile /tmp/ircd.conf ...`

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

Blok `auth` di bagian atas file **first-match-wins** — solanum mengabaikan
blok yang muncul setelah match (`Ignoring redundant auth block` di log),
jadi blok `*@__SOJU_HOST__` harus tetap di atas `*@*`. Flag `exceed_limit`
diberikan ke keduanya karena semua client sampai lewat IP gateway docker
(yang sama untuk soju maupun user biasa), jadi limit per-IP tidak bisa
ditegakkan di deployment ini; connect-throttle solanum (`throttle_*` di
`general {}`) tetap aktif dan itulah proteksi anti-flood yang bekerja.

`need_ident` **sengaja tidak dipakai**: butuh jawaban identd yang tidak
disediakan soju — semua upstream langsung ditutup ("You need to install
identd"). Terverifikasi empiris.

Operator `admin` juga di-render: `password = "__OPER_ADMIN_PASSWORD__"`
berisi hash sha512-crypt dari env `OPER_ADMIN_PASSWORD` — hash tidak pernah
ditulis di repo (hash lama yang ter-commit dianggap compromised dan sudah
diganti).

## atheme/etc/atheme.conf.tmpl + entrypoint.sh

`atheme.conf.tmpl` = config Atheme 7.2 dengan dua placeholder di blok
`uplink "irc.solanum.test"`:

```conf
send_password = "__LINK_SOLANUM_ACCEPT__";     # = solanum accept_password
receive_password = "__LINK_SOLANUM_SEND__";    # = solanum send_password
```

`atheme/entrypoint.sh` me-render `atheme.conf.tmpl` → `/atheme/etc/atheme.conf`
lalu `exec /entrypoint.sh` (entrypoint asli image: cek writable + start
`atheme-services -n`).

Entrypoint yang sama juga me-render **`/atheme/.msmtprc`** — msmtp adalah
MTA sendmail-compatible yang dipanggil atheme (`mta = "/usr/bin/msmtp"` di
`serverinfo`). Konfig SMTP diambil dari env `SMTP_*` yang **sama dengan
service api** (satu akun relay bisa dipakai dua service):

- `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURITY` (`none|starttls|ssl`) — default
  `mailpit`/`1025`/`none`
- `SMTP_USER` + `SMTP_PASSWORD` — password **tidak ditulis** ke file;
  msmtprc memakai `passwordeval "printenv SMTP_PASSWORD"`
- `MAIL_FROM` — diekstrak ke alamat bare bila berbentuk `Name <addr>`

File dirender `chmod 600` milik user `atheme`. Untuk Brevo:
`SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`,
`SMTP_SECURITY=starttls`, `SMTP_USER=<email login>`,
`SMTP_PASSWORD=<SMTP key>`, `MAIL_FROM=<sender verified>`.

Catatan: `auth = email` di `serverinfo` **sengaja `none`** — akun NickServ
yang dibuat service `api` memakai email palsu (`<id>@users.a09f.invalid`),
jadi verifikasi email NickServ akan menahan registrasi mereka. Aktifkan
hanya kalau flow pembuatan akun di api ikut diubah.

Module aktif: `modules/protocol/charybdis` (kompatibel solanum),
`modules/backend/opensex`, `modules/crypto/pbkdf2v2`, services standar.
`#mta` dikomentari — email mati. `modules/misc/httpd` dan
`modules/transport/xmlrpc` **dimatikan** — tidak dipakai dan httpd akan
listen `0.0.0.0:8080` yang bisa dijangkau semua container di `ircnet`.
Modul recovery NickServ (`resetpass`, `setpass`, `sendpass_user`) ikut
dimatikan — reset password lewat service `api`. Operator `jilles` dihapus.

Semua service (kecuali postgres) pakai `cap_drop: ALL` +
`no-new-privileges` — postgres dikecualikan karena entrypoint image-nya
butuh setuid (`gosu`) untuk drop ke user `postgres`.

## soju/config

Tidak ada secret di dalamnya — password user/network dibuat via `sojuctl`
(**otomatis oleh test** `tests/server/test_soju.py`, idempotent).

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
