# Operasi & Troubleshooting

## Perintah sehari-hari

```bash
docker compose up -d --build     # start / rebuild setelah ubah Dockerfile/config
docker compose ps                # status + health semua container
docker compose logs -f <svc>     # tail log (solanum|atheme|soju)
docker compose restart <svc>     # restart satu service
docker compose down              # stop semua (volume tetap ada)
docker compose down -v           # stop + hapus SEMUA volume (data hilang!)
```

Healthcheck jalan per service (`docker inspect <c> --format '{{.State.Health.Status}}'`):
solanum probe TCP 6667, atheme `pgrep`+`nc` ke solanum, soju `sojuctl server status`.
`depends_on: service_healthy` membuat atheme/soju menunggu solanum benar-benar ready.

Setelah ubah `.env` atau `*.tmpl`: `docker compose up -d` (recreate) —
config di-render ulang oleh entrypoint saat start.

## Cek kesehatan link

```bash
# solanum ↔ atheme: harus terlihat "Server Ready" dan tidak ada error TS6
docker logs solanum --tail 50
docker logs atheme --tail 50
# atheme sukses link: "connection to uplink established" + "finished synching"

# soju ↔ solanum
docker exec soju /sojuctl -config /soju-config user run pointilis network status
```

`network status` harus `[connected]`; kalau `[disconnected]` lihat error-nya
(conn refused = solanum lagi down; TLS handshake = scheme salah, harus
`irc+insecure://` untuk port 6667).

## Capacity & scaling

Batas yang sudah dinaikkan (semuanya ceiling, bukan reservasi — tidak
memakai resource lebih kalau tidak dipakai):

| Komponen | Setting | Nilai |
|----------|---------|-------|
| solanum | `default_max_clients`, class users `max_number` | 50000 |
| solanum | `number_per_ip_global` / `number_per_cidr` | 500 / 5000 (client lokal semua lewat IP gateway docker — jangan terlalu rendah) |
| solanum | IP soju (`SOJU_HOST`, default `172.30.99.30`) | `auth { flags = exceed_limit; }` + `exempt {}`: bebas dari `number_per_ip = 10` dan throttle reconnect (4/60 dtk) — semua user bouncer berbagi satu IP |
| solanum/soju/postgres | `ulimits nofile` | 65536 |
| soju | `message-expiry` | 365d — history setahun, tabel `Message` tidak tumbuh tak terbatas |
| postgres | `shared_buffers` / `work_mem` / `max_connections` | 256MB / 16MB / 200 (`synchronous_commit` tetap on — durability tidak dikorbankan) |

Catatan: solanum single-threaded per instance — scale horizontal-nya
adalah clone service + TS6 link (shard), bukan threading. Soju menahan
koneksi *client* (banyak perangkat per user → 1 koneksi upstream), tapi
tiap **akun** soju tetap punya 1 koneksi upstream sendiri ke solanum, semua
dari IP soju — itu sebabnya IP soju di-exempt dari batas per-IP & throttle.

### Kalau user mulai banyak (puluhan ribu)

1. **Sharding soju**: jalankan N instance soju (beda port/config/nick
   upstream), user di-shard per instance. Postgres bisa tetap shared
   (skema sudah per-user) atau per-shard.
2. **`message-store fs`**: kalau write postgres jadi bottleneck, soju
   bisa simpan history ke filesystem (format ZNC) — trade-off: hilang
   full-text search. Coba ini sebelum menambah sistem queue.
3. **Partitioning `Message`**: partition per bulan supaya delete data
   lama instan (message-expiry tetap jalan, tapi vacuum lebih cepat).
4. **Load balancer**: `BIND_ADDR` publik + nginx/haproxy di depan soju
   kalau user remote — port langsung jangan di-expose.

## Persistence

| Data                        | Lokasi                              | Persist? |
|-----------------------------|-------------------------------------|----------|
| solanum ban.db              | `/var/local/ban.db` (volume `solanum-state`) | ya |
| solanum logs                | volume `solanum-logs`               | ya       |
| atheme services.db          | `./atheme/etc/services.db` (repo)   | ya       |
| soju users/networks/history | volume `postgres-data` (DB `soju`)  | ya       |
| soju admin socket           | volume `soju-db` → `/db`            | ya       |
| soju uploads                 | volume `soju-uploads`               | ya       |
| data service akun (teman, sesi, email pemulihan, reaksi, …) | volume `postgres-data` (DB `a09f`) | ya |
| data service Python lama (hanya dibaca sekali saat impor) | volume `register-data` → `/data/register.db` | ya (tidak berubah) |

Backup yang relevan: `docker exec postgres pg_dump -U soju soju > backup.sql`
atau volume `postgres-data`. File `soju.db` lama (sqlite) masih ada di volume
`soju-db` sebagai sisa migrasi — tidak dipakai lagi.

Catatan: path ban.db adalah compile-time `/var/local/ban.db` — flag
`-banfile` di solanum adalah dead code (sama seperti `-motdfile`).

## Reload config tanpa restart

- **solanum**: `kill -HUP <pid>` di container atau `/REHASH` sebagai oper.
  MOTD di-reload via `SIGUSR1`.
- **atheme**: `kill -HUP 1` di container.
- **soju**: `kill -HUP 1` — reload config/tls/motd (tapi bukan `listen`/`db`/`log`).

## Service akun (`api`)

`server/api/` — service Go (satu binary + `sojuctl` di image Alpine) yang
dipakai app desktop: Create account, reset password, teman, event live,
metadata pesan, room. Datanya di Postgres (database `a09f`, role `a09f`).

Setup sekali (stack lama yang sudah jalan):

```bash
docker compose up -d postgres
./scripts/init-api-db.sh                 # A09F_DB_PASSWORD di .env + role/database a09f
docker compose up -d --build --no-deps api
docker compose rm -sf register 2>/dev/null   # container Python lama, kalau masih ada
```

Saat start pertama, data service Python (`register-data/register.db`)
diimpor ke Postgres satu kali (tabel `migrations` mencatatnya); file SQLite
hanya dibaca. Sesi app (dulu di memori) sekarang di tabel `sessions` (hash
SHA-256 token), jadi restart service tidak mengeluarkan siapa pun.

Untuk tiap akun baru service menjalankan
`sojuctl` lewat admin socket soju (volume `soju-db`): Untuk tiap akun baru ia menjalankan
`sojuctl` lewat admin socket soju (volume `soju-db`):

1. `user create -username <id> -password <pw> -nick <id> -realname <id>` (non-admin)
2. `user run <id> network create -addr irc+insecure://solanum:16668 -name solanum -nick <id> -auto-away true`
   (auto-away = away saat tidak ada perangkat tersambung → app menampilkan *Offline*)

Jadi tiap akun punya nick IRC sendiri (bukan `soluser` bersama). Kalau langkah
2 gagal, user dari langkah 1 dihapus lagi (rollback).

Tanya "user ini ada?" juga lewat `sojuctl user status <id>` (admin socket,
`BOUNCER_LOOKUP=ctl`), bukan login IRC ke soju — service ini tidak perlu
menjangkau port tempat upstream bouncer datang (lihat *Keamanan* di bawah).

Tabel port di `docs/configuration.md` sudah menyebut 6667/6697; sekarang
tambahan **16668** (soju→solanum, plaintext, tidak pernah publik: bind
`SOLANUM_SOJU_BIND`, default `127.0.0.1`).

### Kenapa port 16668

Semua koneksi upstream soju datang dari **satu IP** (`172.30.99.30`), jadi
solanum memperlakukannya berbeda dari user biasa — dan perbedaan itu tidak
boleh bisa ditiru proses lain:

- `auth { user = "*@172.30.99.30"; flags = exceed_limit, need_ident; }` —
  hanya alamat itu yang dianggap bouncer (`exceed_limit` = bebas
  `number_per_ip`). `need_ident` membuatnya hanya lolos kalau benar-benar
  menjawab ident sebagai soju.
- Auth block solanum **tidak** ditentukan urutan di file: `*@*` selalu menang,
  jadi blok catch-all wajib memikul flag yang sama (`exceed_limit`), kalau
  tidak bouncer "turun kelas".
- Alamat itu berasal dari docker secret `secrets/soju-host.ip` (di-generate
  `scripts/soju-host-ip.sh` dari `docker-compose.yml`), **bukan** env: kalau
  filenya hilang solanum menolak start, jadi tidak mungkin diam-diam jadi `*`.
- Port `16668` hanya untuk soju (plaintext, bind host `127.0.0.1` by default);
  `6667`/`6697` tetap untuk client. Port bukan batas keamanan — auth yang
  batasnya — tapi memisahkan trafik bouncer dari trafik publik.

```bash
curl -s http://127.0.0.1:16680/health
curl -s -XPOST http://127.0.0.1:16680/register -H 'Content-Type: application/json' \
  -d '{"username":"budi","password":"rahasia123","email":"budi@example.com"}'
docker logs api               # log request (tanpa body/password)
```

Aturan: ID `^[a-z][a-z0-9_-]{2,15}$`, tidak boleh nama reserved / `*serv`;
password 8–128 karakter tanpa karakter kontrol. Rate limit per **jaringan**:
30 percobaan & 5 akun per jam (env `MAX_ATTEMPTS_PER_HOUR`,
`MAX_CREATES_PER_HOUR`). Yang dihitung bukan satu alamat: IPv4 per alamat,
IPv6 per **/64** — satu pelanggan memang memegang satu /64, jadi ganti-ganti
alamat di dalamnya tidak menambah kuota. Login salah dibatasi dua kali:
per jaringan+ID dan per ID (dari mana pun), karena itu satu-satunya request
yang benar-benar mencoba menebak password.

Kalau `api` ada di belakang reverse proxy, isi `TRUSTED_PROXIES` (dipisah
koma, mis. `127.0.0.1` atau IP container Caddy) supaya `X-Forwarded-For`
dibaca; tanpa itu semua klien terlihat sebagai IP proxy dan **satu** bucket
dipakai bersama — penyerang bisa menghabiskan jatah orang lain. Header hanya
dipercaya kalau request datang dari proxy itu.

Port host `REGISTER_PORT` (default `16680`),
bind ke `BIND_ADDR`. Siapa pun yang bisa menjangkau port ini bisa membuat
akun — jangan expose ke publik tanpa proteksi tambahan (captcha/invite).

Rebuild service ini **tanpa** menyentuh dependensinya:

```bash
docker compose up -d --build --no-deps api
```

Tanpa `--no-deps`, compose ikut me-rebuild/restart `solanum` (api → soju →
solanum), semua upstream soju putus, lalu reconnect bareng dari satu IP dan
kena throttle solanum ("Reconnecting too fast") sampai beberapa menit.

Akun NickServ: app desktop yang mendaftarkan akun NickServ (password sama,
email `<id>@users.a09f.invalid`) saat sign in pertama, lalu mengatur
`sasl set-plain` di soju. Cek: `sojuctl user run <id> sasl status -network solanum`.

Hapus akun: `docker exec soju /sojuctl -config /soju-config user delete <id>`
lalu ulangi dengan token konfirmasi yang dicetak. Email pemulihannya tetap di
tabel `emails` (tidak berbahaya; ditimpa kalau ID yang sama didaftarkan lagi).

### Email pemulihan & reset password

Create account wajib mengisi email; disimpan di database service ini (bukan di
soju/NickServ). Akun lama bisa menambah/mengganti email dari app (🔑 Password
→ Recovery email); endpoint `/email` memverifikasi password dengan login SASL
sungguhan ke soju. App mengingatkan (Tip) akun yang belum punya email.

Alur **Forgot password?** di layar Sign In:

1. `POST /reset/request {"username"}` → kode 6 digit dikirim ke email akun
   (berlaku 15 menit, maks 5 tebakan salah, jeda 60 dtk antar kode; yang
   disimpan hanya hash-nya).
2. `POST /reset/confirm {"username","code","password"}` →
   `sojuctl user update <id> -password`, lalu **kalau** upstream soju akun itu
   sedang identified ke NickServ: `network quote solanum "PRIVMSG NickServ :SET PASSWORD …"`
   dan `sasl set-plain -network solanum <id> <pw>`. Jadi sign in, NickServ, dan
   login SASL soju ikut berganti.

Pengiriman email lewat SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`
= `starttls|ssl|none`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` di `.env`).
Default-nya ke container **Mailpit** (`mailpit:1025`): email tidak benar-benar
terkirim, tapi bisa dibaca di http://127.0.0.1:16825 — cocok untuk dev. Untuk
produksi isi `SMTP_*` dengan server SMTP asli lalu
`docker compose up -d --no-deps api`.

Reset manual oleh admin (akun tanpa email):

```bash
docker exec soju /sojuctl -config /soju-config user update <id> -password <baru>
# NickServ tetap password lama sampai user ganti password dari app
```

### Teman, friend request, typing (API sosial)

Service yang sama menyimpan daftar teman per akun (tabel `friends`,
`friend_requests`) dan meneruskan event live:

- `POST /session {"username","password"}` → token bearer (password dicek
  dengan login SASL ke soju; sesi disimpan di Postgres).
- `GET /friends`, `POST /friends/request|respond|remove|move|rename-group`.
- `POST /typing {"to","active"}` dan `GET /events?token=…` (Server-Sent
  Events: `friend-request`, `friend-accepted`, `friend-declined`, `typing`).
  Token di query string disensor dari log; request typing/events yang sukses
  tidak dicatat.

Endpoint bertoken tidak dihitung ke rate limit per IP (typing sering).
`/session` dan `/email` (cek password) juga tidak: yang dibatasi hanya
**password salah**, per IP+ID (`MAX_LOGIN_FAILS_PER_HOUR`, default 10), jadi
sign in normal tidak pernah menghabiskan jatah bersama satu IP/NAT.
Satu koneksi SSE = satu goroutine (beberapa KB); app yang lambat kehilangan
event (buffer 256) alih-alih memperlambat yang lain.

### Extban akun (`extb_account`)

`ircd.conf.tmpl` memuat `extensions/extb_account` (ISUPPORT `EXTBAN=$,a`).
Semua user a09f datang dari IP soju yang sama, jadi ban/mute di app memakai
`$a:<akun>` (+ `<id>!*@*` untuk yang belum login NickServ) — **jangan pernah**
ban berdasarkan host. Modul baru bisa dimuat tanpa restart: render ulang
config di container lalu `kill -HUP $(cat /tmp/solanum.pid)`.

Catatan Atheme: flood protection services dinaikkan ke `flood_msgs = 16` per
`flood_time = 10` dtk (default 7) di `atheme.conf.tmpl`. Membuat room dari app
mengirim REGISTER (dihitung beberapa) + GUARD + KEEPTOPIC + MLOCK + ENTRYMSG,
lalu membuka Settings menambah INFO + FLAGS; dengan 7, perintah terakhir
diabaikan diam-diam. Terapkan tanpa restart: render ulang config di container
atheme lalu `kill -HUP 1`.

Catatan Atheme: room terdaftar memakai MLOCK default `+nt-lk`, jadi password
(+k) dan batas (+l) hanya bisa dipasang pemilik lewat `ChanServ SET #room
MLOCK …` (app melakukannya dari ⚙️ Settings).

## Room bawaan `#lobby` & `#a09f-presence`

App desktop otomatis join `#lobby` kalau akun belum ada di room mana pun.
Room ini (dan room tersembunyi `#a09f-presence`, MLOCK `+nts`, dipakai app
untuk pesan status teman) didaftarkan ke ChanServ oleh
`scripts/setup-rooms.py` (idempotent, ada jeda antar perintah supaya tidak
kena flood protection Atheme):

- founder: akun NickServ `a09f` (`LOBBY_OWNER`), password di `.env`
  (`LOBBY_OWNER_PASSWORD`, dibuat otomatis kalau belum ada)
- `GUARD ON` — ChanServ selalu di dalam room, jadi room tidak hilang saat kosong
- `KEEPTOPIC` + `TOPICLOCK ON`, `MLOCK +nt`, topik sambutan

```bash
python3 scripts/setup-rooms.py                      # setup / cek ulang
python3 scripts/setup-rooms.py --op-via-soju cebong # kalau room sudah berisi
                                                    # dan owner belum op
```

`--op-via-soju <user>` meminta koneksi bouncer user tsb (yang op di room)
mengirim `MODE #lobby +o a09f` via `sojuctl ... network quote`, jadi tidak
perlu ada yang keluar room. Solanum men-throttle reconnect cepat dari IP
yang sama ("Reconnecting too fast") — tunggu ±1 menit antar run.

## Troubleshooting

### solanum restart loop

Cek `docker logs solanum`. Penyebab yang sudah pernah terjadi:

| Gejala log                                  | Penyebab & fix |
|---------------------------------------------|----------------|
| `Don't run ircd as root!!!`                 | image jalan sbg root — Dockerfile harus `USER ircd` |
| `authd: DNS: no name servers!`              | image kurang `netbase` → `/etc/services`+`/etc/protocols` hilang; `getaddrinfo` gagal. Tambah `netbase` di apt install |
| `bandb failure: Unable to open sqlite database` | `/var/local` tidak writable oleh `ircd` (ban.db path = `/var/local/ban.db`) → ircd exit. `chown ircd:ircd /var/local` di Dockerfile |
| `daemon is already running`                 | stale pidfile → `entrypoint.sh` hapus `/tmp/solanum.pid` |
| `422 MOTD File is missing` ke client        | mount `./solanum/etc/motd` → `/usr/local/etc/ircd.motd` hilang |
| `Access denied, invalid host for server services.int` | `host` di `connect` block tidak cocok dengan IP peer — pakai IP statis (`ATHEME_HOST` = `ipv4_address` atheme), bukan nama docker DNS |
| TLS `access_denied` setelah burst koneksi  | throttle solanum (`throttle_duration=60`) — tunggu ±1 menit |

### atheme tidak link

- Log `unable to resolve solanum` → container solanum sedang down/crash;
  docker DNS hanya resolve service yang running.
- Log `connection to uplink established` tapi lalu drop → cek kesamaan
  `send_password`/`receive_password` di kedua config (arah terbalik).
- Cek `loadmodule "modules/protocol/charybdis";` aktif dan hanya SATU
  backend (`opensex`) yang di-load.

### soju exit / restart

`docker logs soju` — error config selalu `failed to load config file: line N`.

| Gejala                              | Fix |
|-------------------------------------|-----|
| `directive "title": requires exactly one parameter` | quote nilai: `title "..."` |
| `failed to load MOTD: open <teks>`  | `motd` butuh path file, bukan string |
| `listen unix+admin ... no such file`| format URI `unix+admin:///path`; `/tmp` tidak ada di image → pakai `/db` |
| `address already in use` saat start | race saat restart berturut-turut — tunggu, normal hilang sendiri |
| client dapat `464 Authentication required` | soju `auth internal` → client wajib SASL |
| client dapat `400 ... bouncer connection` | pakai `NICK/USER <user>/<network>` atau ekstensi bouncer-networks |
| upstream `tls: first record does not look like TLS` | addr upstream pakai `irc+insecure://` untuk port plain |
| upstream `no such host` untuk `irc.solanum.test` | nama itu hanya iklan client; di upstream pakai `solanum:6667` (docker DNS) |

### Client tidak bisa connect

- `nc -vz 127.0.0.1 6667` / `16667` untuk cek port terbuka.
- TLS self-signed → matikan verify di client atau import CA.
- Perhatikan port: jangan campur `6667` (solanum) dengan `16667` (soju).

## Testing

Lihat [testing.md](testing.md). Ringkas:

```bash
python3 tests/server/test_solanum.py          # direct ke solanum:6667
python3 tests/server/test_solanum.py --tls    # direct TLS :6697
python3 tests/server/test_soju.py             # via bouncer:16667 + SASL (self-setup)
python3 tests/server/test_soju.py --tls       # via bouncer TLS :16697
python3 tests/server/test_tls.py              # handshake TLS kedua listener
```

## Security notes (dev only!)

- Semua sertifikat TLS **self-signed** — jangan expose ke internet tanpa CA asli.
- Password link solanum↔atheme dan password user soju `pointilis` adalah
  credential dev — ganti sebelum dipakai serius.
- Password oper `admin` di ircd.conf sudah di-hash SHA-512 crypt tapi tetap
  credential lemah untuk dev.
- Solanum jalan sebagai user `ircd` non-root; atheme sebagai user `atheme`;
  soju image berjalan sebagai user non-root bawaan image.
- Port ter-bind ke `0.0.0.0` — akses LAN terbuka. Batasi dengan firewall atau
  ganti ke `127.0.0.1:6667:6667` kalau hanya untuk lokal.
