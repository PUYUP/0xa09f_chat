# Konfigurasi

## docker-compose.yml

Tiga service dalam satu bridge network `ircnet` (`172.30.99.0/24`, subnet statis supaya
hostname internal konsisten):

| Service  | IP            | Ports diekspos ke host                          |
|----------|---------------|--------------------------------------------------|
| solanum  | 172.30.99.10  | `6667` plain, `6697` TLS                        |
| atheme   | 172.30.99.20  | tidak ada (hanya internal)                       |
| soju     | 172.30.99.30  | `16667` plain, `16697` TLS                       |

Named volumes:

- `solanum-logs` → `/var/log/solanum`
- `atheme-data` → `/atheme/var`
- `soju-db` → `/db` (SQLite soju + admin socket)
- `soju-uploads` → `/uploads`

Bind mounts:

- `./solanum/etc` → `/etc/solanum` (ro) — config, TLS, motd sumber
- `./solanum/etc/motd` → `/usr/local/etc/ircd.motd` (ro) — lihat catatan MOTD di bawah
- `./atheme/etc` → `/atheme/etc` — config + `services.db` (persisten di repo)
- `./soju/config` → `/soju-config` (ro)
- `./soju` → `/soju-tls` (ro) — cert/key/motd

## solanum/etc/ircd.conf

Bagian penting:

- `serverinfo`: `name = "irc.solanum.test"`, `sid = "10A"`, `network_name = "SolNet"`
- `listen`: satu blok `port = 6667; sslport = 6697;` — TLS diport yang sama via upgrade
- `auth`/`class`: semua user masuk class `users`
- `operator "admin"`: password **sudah di-hash** (`$6$` = SHA-512 crypt). Ubah dengan
  `mkpasswd`/`openssl passwd -6` sebelum dipakai serius.
- `connect "services.int"`: blok uplink untuk Atheme.
  - `host = "172.30.99.20"` — IP statis container atheme
  - `send_password`/`accept_password` — harus cocok dengan `uplink{}` di atheme.conf
    (arah dibalik: `send` di solanum = `receive` di atheme)
  - `port = 6667`, `class = "server"`, `flags = topicburst`
- `service { name = "services.int"; }` — menandai services.int sebagai service server
- `identify_service = "NickServ@services.int"` — dipakai SASL/ACCOUNTNOTIFY
- `path`: `/usr/local/modules` + `/usr/local/modules/autoload`

### Catatan MOTD (penting)

Flag `-motdfile` di solanum **tidak berfungsi** di versi ini — `cache_user_motd()` selalu
membaca path compile-time `/usr/local/etc/ircd.motd` (`ETCPATH/ircd.motd`). Karena itu
`docker-compose.yml` me-mount `./solanum/etc/motd` langsung ke path tersebut. Jangan hapus
mount itu, kalau tidak client dapat `422 MOTD File is missing`.

### TLS

`ssl-cert.pem`, `ssl-key.pem`, `dh.pem` self-signed untuk `irc.solanum.test`. Regenerate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout solanum/etc/ssl-key.pem -out solanum/etc/ssl-cert.pem \
  -days 3650 -subj "/CN=irc.solanum.test"
openssl dhparam -out solanum/etc/dh.pem 2048   # lambat, opsional untuk dev
```

## solanum/Dockerfile + entrypoint.sh

- Base `debian:bookworm-slim`; dependency build: `meson`, `ninja`, `flex`, `bison`,
  `libsqlite3-dev`, `libltdl-dev`, `libssl-dev`, **`netbase`**.
- `netbase` wajib: menyediakan `/etc/services` dan `/etc/protocols`. Tanpa itu `getaddrinfo`
  gagal → `authd` melaporkan `DNS: no name servers!` dan helper restart terus.
- Build: `git clone --depth 1` solanum → `meson setup build --prefix=/usr/local` →
  `meson compile` → `meson install`.
- User `ircd` (uid 1001) — solanum menolak jalan sebagai root (`Don't run ircd as root!!!`).
  `/var/lib/solanum` dan `/var/log/solanum` di-chown ke `ircd` — wajib, karena helper `bandb`
  membuka SQLite ban.db di situ dan `exit(1)` kalau gagal (menjatuhkan seluruh ircd).
- `entrypoint.sh`: hapus stale pidfile (`/tmp/solanum.pid`, `/var/lib/solanum/solanum.pid`)
  lalu `exec solanum -foreground` dengan path eksplisit. Tanpa cleanup pidfile, restart
  kena false-positive "daemon is already running".

## atheme/etc/atheme.conf

Config Atheme 7.2.x (image `s0fx2/atheme-irc-services`, format module path lama dengan
prefix `modules/`).

Module yang diaktifkan:

- `modules/protocol/charybdis` — protokol server-link yang kompatibel dengan Solanum
  (image tidak punya `solanum.so`; charybdis adalah pengganti yang benar)
- `modules/backend/opensex` — database backend (satu-satunya yang dipakai)
- `modules/crypto/pbkdf2v2` — hashing password
- `modules/nickserv/*`, `modules/chanserv/*`, `modules/hostserv/*`, `modules/helpserv/*`,
  `modules/transport/xmlrpc`, dll — services standar

Blok penting:

```conf
serverinfo {
    name = "services.int";      # nama server services di jaringan
    numeric = "00A";            # SID services
    netname = "SolNet";
}

uplink "irc.solanum.test" {
    host = "solanum";                       # docker DNS → 172.30.99.20? tidak:
                                            # resolve ke container solanum
    port = 6667;
    send_password = "change-me-atheme-to-solanum";    # = accept_password di solanum
    receive_password = "change-me-solanum-to-atheme";# = send_password di solanum
}
```

Catatan:

- `services.db` ada di `atheme/etc/` — ikut ter-mount, jadi data registrasi persisten
  di repo (bukan di volume).
- `#mta` dikomentari — pengiriman email dimatikan, jadi services tidak memanggil
  `/usr/sbin/sendmail` (registrasi pakai `registeremail = "noreply@solanum.test"`).
- Atheme butuh waktu reconnect kalau solanum restart — normal, dia retry tiap ~10 detik.

## soju/config

```conf
listen ircs://:6697                          # TLS untuk client
listen irc+insecure://:6667                  # plain untuk client
listen unix+admin:///db/soju-admin.sock      # socket admin untuk sojuctl

tls /soju-tls/tls-cert.pem /soju-tls/tls-key.pem
hostname irc.solanum.test                    # nama network yang dilihat client
title "SolNet Bouncer"
auth internal                                # user internal (bukan PAM)

db sqlite3 /db/.soju.db → /db/soju.db        # via named volume soju-db
message-store db                             # simpan history di DB yang sama
motd /soju-tls/motd
```

Catatan format:

- `title` harus di-quote kalau lebih dari satu kata.
- `motd` butuh **path file**, bukan teks inline.
- `listen unix+admin://` butuh prefix `://`; container image tidak punya `/tmp`, jadi
  socket ditaruh di `/db` (volume writable).
- Scheme upstream yang didukung `sojuctl`: `ircs`, `irc+insecure`, `irc+unix`.
  Bare `host:port` default ke TLS — untuk plain wajib `irc+insecure://`.

## soju user & upstream (dibuat via sojuctl)

Disimpan di SQLite `/db/soju.db` (volume `soju-db`), jadi persist antar restart:

```bash
docker exec soju /sojuctl -config /soju-config user create \
    -username pointilis -password <password> -admin

docker exec soju /sojuctl -config /soju-config user run pointilis \
    network create -addr irc+insecure://solanum:6667 \
    -name solanum -nick soluser -realname "Soju Test" -enabled true
```

Update addr network yang sudah ada:

```bash
docker exec soju /sojuctl -config /soju-config user run pointilis \
    network update solanum -addr irc+insecure://solanum:6667
```

Lihat status:

```bash
docker exec soju /sojuctl -config /soju-config user run pointilis network status
docker exec soju /sojuctl -config /soju-config user status pointilis
```
