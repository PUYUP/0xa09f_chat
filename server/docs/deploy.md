# Persiapan Deploy ke Produksi

Panduan untuk memindahkan stack ini dari mesin lokal ke internet di bawah
domain **snailog.com**. Dokumen ini melengkapi `README.md` (arsitektur),
`configuration.md` (isi tiap file konfigurasi) dan `operations.md`
(operasi harian); yang ditulis di sini hanya yang **berbeda atau baru**
untuk produksi.

| Domain | Isi | Dilayani oleh |
|---|---|---|
| `snailog.com` | domain utama; redirect ke webapp | reverse proxy |
| `im.snailog.com` | **webapp**: file statis `desktop/ui/` | Cloudflare Workers (`webapp/`, §7), atau Caddy di VPS |
| `irc.snailog.com` | **backend**: WebSocket soju (`/socket`) + service akun `api` (semua path lain) | reverse proxy → container |

## 1. Topologi

```
                    Browser / HP
                 │                    │
   snailog.com   │ im.snailog.com     │ irc.snailog.com (DNS only)
   → redirect ───┤                    │
                 ▼                    ▼
   ┌───────────────────────┐   ┌──────────────────────────────────────┐
   │ Cloudflare Workers    │   │ VPS: Caddy (80/443, Let's Encrypt)   │
   │ static assets:        │   │   /socket   → 127.0.0.1:16668 (soju) │
   │ desktop/ui + config.js│   │   path lain → 127.0.0.1:16680 (api)  │
   └───────────────────────┘   └──────────────────┬───────────────────┘
                                                  ▼
                    docker network ircnet: soju ── solanum ── atheme, postgres, api
```

Webapp hanya berisi file statis dan dilayani Cloudflare. Halaman itu lalu
bicara langsung ke `irc.snailog.com`. Di VPS ada **satu pintu masuk**
(Caddy di 80/443). Semua port container tetap
ter-bind ke `127.0.0.1` seperti default `.env.example`; tidak ada port IRC
yang dibuka ke internet kecuali kamu sengaja ingin mendukung klien IRC umum
(lihat §9).

Path `api` (`/register`, `/session`, `/events`, `/join/…`, `/preview`, …) dan
WebSocket soju (`/socket`) tidak bertabrakan, jadi keduanya bisa berbagi
`irc.snailog.com`.

## 2. Wajib dikerjakan di kode sebelum go-live

Alamat server dibaca dari `config.js`, yang di-load sebelum `web-shim.js`
dan `app.js`. `desktop/ui/config.js` berisi alamat lokal untuk dev.
`webapp/config.js` berisi alamat produksi dan dipasang otomatis oleh
`webapp/deploy.sh`. Jadi **webapp sudah siap**. Yang tersisa:

| # | Apa | Di mana | Kenapa |
|---|---|---|---|
| 1 | App desktop konek ke soju lewat **TCP plaintext** | `desktop/src-tauri/src/lib.rs` (`connect`), `config.js` (`server`) | **blocker untuk rilis app desktop** (bukan webapp): password SASL akan lewat internet tanpa enkripsi. Pilih: (a) desktop juga pakai `wss://irc.snailog.com/socket` (**disarankan**: satu endpoint, satu sertifikat, tidak perlu buka port tambahan), atau (b) tambah TLS di Rust dan buka port `ircs` (§9). Build desktop juga butuh `config.js` produksi |
| 2 | "Remember my ID & password" di web menyimpan password **plaintext** di `localStorage` | `web-shim.js` (`cred_save`) | di browser bersama/terkena XSS, password bocor. Pertimbangkan menyembunyikan opsi ini saat `IS_WEB`, atau menyimpan token sesi saja |
| 3 | CORS `api` masih `Access-Control-Allow-Origin: *` | `server/api/httpx.go` | aman secara fungsi (auth lewat header, bukan cookie), tapi lebih rapi dibatasi ke `https://im.snailog.com` (+ origin app Tauri) |
| 4 | Invite link di web belum jalan | `web-shim.js` ("deep-link never fires") | `https://irc.snailog.com/join/<room>` sekarang menawarkan `snailog://` (app desktop). Untuk webapp perlu jalur ke `https://im.snailog.com/#join=<room>` atau sejenisnya |
| 5 | Pratinjau gambar link memakai `onerror="…"` inline | `app.js` (link preview) | diblokir CSP `script-src 'self'`; gambar yang gagal dimuat tidak hilang dari kartu pratinjau. Kosmetik |

`allowWsOverride` di `config.js` harus `false` di produksi (sudah begitu di
`webapp/config.js`). Kalau `true`, link seperti
`https://im.snailog.com/?irc=wss://server-orang-lain/socket` akan
mengirim password pengguna ke server lain. `tests/webapp/test_build.py`
mengecek ini.

## 3. DNS

Buat di DNS provider (ganti `203.0.113.10` / `2001:db8::10` dengan IP server):

| Nama | Tipe | Nilai |
|---|---|---|
| `snailog.com` | A / AAAA | IP server |
| `www.snailog.com` | CNAME | `snailog.com` |
| `im.snailog.com` | A / AAAA | IP server |
| `irc.snailog.com` | A / AAAA | IP server |

Untuk email reset password (`MAIL_FROM=…@snailog.com`), tambahkan juga record
dari penyedia SMTP (contoh Brevo, lihat komentar di `.env.example`):

| Nama | Tipe | Nilai |
|---|---|---|
| `snailog.com` | TXT | SPF, mis. `v=spf1 include:spf.brevo.com ~all` |
| `<selector>._domainkey.snailog.com` | TXT / CNAME | DKIM dari dashboard penyedia |
| `_dmarc.snailog.com` | TXT | `v=DMARC1; p=quarantine; rua=mailto:postmaster@snailog.com` |

Tanpa SPF/DKIM, email reset password hampir pasti masuk spam.

Kalau memakai Cloudflare: untuk `irc.snailog.com`, proxy (awan oranye)
boleh menyala karena Cloudflare meneruskan WebSocket dan SSE. Tapi
`TRUSTED_PROXIES` (§5) lalu harus berisi rentang IP Cloudflare, dan timeout
idle Cloudflare (100 detik) harus lebih panjang dari interval ping soju dan
heartbeat `/events`. Paling sederhana: DNS only (awan abu-abu) dan biarkan
Caddy yang mengurus TLS.

## 4. Server

- VPS Linux (Debian 12 / Ubuntu 24.04), minimal 2 vCPU / 4 GB RAM untuk
  awal. Postgres disetel untuk ±1 GB cache (`docker-compose.yml`). Angka
  kapasitas ada di `operations.md` § *Capacity & scaling*.
- Docker Engine + plugin compose (`docker compose version`).
- Caddy dari paket resminya (`apt install caddy`), berjalan di host.
- Firewall: hanya buka **22, 80, 443** (dan `6697` kalau memilih §9).

```bash
ufw default deny incoming
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

> Catatan: port yang di-publish Docker melewati `ufw`. Itulah sebabnya semua
> `*_BIND` / `BIND_ADDR` di `.env` **harus** tetap `127.0.0.1`. Jangan pakai
> `0.0.0.0`.

## 5. Konfigurasi stack untuk produksi

### `.env`

Template produksi ada di `server/.env.production.example`. Jangan mengisi
password dengan tangan; pakai script ini:

```bash
cd server
./scripts/gen-prod-env.sh      # .env baru, semua password acak (hex), mode 600
$EDITOR .env                   # isi bagian "WAJIB DIISI": SMTP, ADMIN_USERS, SOJU_USER
./scripts/sync-secrets.sh
```

Script ini tidak akan menimpa `.env` yang sudah ada. Password dibuat
heksadesimal karena nilainya disisipkan ke config lewat `sed` (pemisah `|`)
dan ke file pgpass (pemisah `:`).

| Variabel | Isi | Sumber |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | `smtp-relay.brevo.com`, `587`, `starttls` (ganti kalau bukan Brevo) | template |
| `SMTP_USER`, `SMTP_PASSWORD` | login + SMTP key dari dashboard penyedia email | **isi sendiri** |
| `MAIL_FROM` | `Snailog IM <no-reply@snailog.com>`; domain harus terverifikasi + SPF/DKIM (§3) | template |
| `ADMIN_USERS` | ID yang boleh kirim pengumuman 📢, pisahkan koma | **isi sendiri** (opsional) |
| `SOJU_USER` | ID yang sudah ada; dipakai `monitor.sh` untuk cek soju ↔ solanum | **isi sendiri** |
| `LINK_SOLANUM_SEND`, `LINK_SOLANUM_ACCEPT` | password link solanum ↔ atheme | acak |
| `OPER_ADMIN_PASSWORD` | password `/OPER admin`; simpan di password manager | acak |
| `POSTGRES_PASSWORD`, `SNAILOG_DB_PASSWORD` | database soju dan database service akun | acak |
| `LOBBY_OWNER_PASSWORD` | akun NickServ pemilik `#lobby` | acak |
| `BIND_ADDR`, `SOLANUM_BIND`, `SOJU_BIND` | `127.0.0.1`: **jangan** `0.0.0.0` | template |
| port (`SOJU_WS_PORT`, `REGISTER_PORT`, …) | sama dengan dev; Caddy menunjuk ke sini | template |
| `TRUSTED_PROXIES` | `172.30.99.1`, **cek** (lihat di bawah) | template |
| `IRC_SUBNET`, `ATHEME_HOST`, `SOJU_HOST`, `SOJU_NETWORK` | internal docker, biarkan | template |

`SOJU_PASSWORD` dari `.env.example` hanya untuk tes lokal dan sengaja tidak
ada di produksi. **Jangan menulis komentar di ujung baris**
(`KEY=nilai  # …`): `setup-rooms.py` dan `monitor.sh` membaca nilai mentah,
jadi komentarnya ikut terbaca sebagai nilai.
`tests/server/test_prod_env.py` mengecek hasil script ini tanpa docker.

**`TRUSTED_PROXIES`.** Caddy menghubungi `127.0.0.1:16680` di host, jadi
container `api` melihat koneksi itu datang dari gateway network docker
(biasanya `172.30.99.1` untuk `IRC_SUBNET` default), bukan dari IP
pengguna. Tanpa setting ini, **semua pengguna berbagi satu jatah rate limit**
(mis. register 5 akun/jam untuk seluruh dunia). Pastikan IP-nya sebelum
go-live: kirim satu request lewat Caddy, lalu cek alamat asal di log
`docker compose logs api`.

### `soju/config`

```diff
-http-origin http://localhost:* http://127.0.0.1:*
+http-origin https://im.snailog.com
+# Caddy meneruskan WebSocket dari host; percayai X-Forwarded-For darinya
+# supaya soju melihat IP pengguna asli (bukan semuanya 172.30.99.1).
+# Harus format CIDR (/32 untuk satu alamat), kalau tidak soju menolak start.
+accept-proxy-ip 172.30.99.1/32
+
-hostname irc.solanum.test
+hostname irc.snailog.com
```

- `http-origin` adalah pengaman utama WebSocket: tanpa ini, halaman web mana
  pun bisa membuka koneksi atas nama pengguna yang sedang login. Jangan
  memakai `*`.
- `accept-proxy-ip` hanya menerima CIDR: tulis `172.30.99.1/32`, bukan
  `172.30.99.1` (soju berhenti dengan `failed to parse CIDR`). Nilainya harus
  sama dengan IP di `TRUSTED_PROXIES` (§5).
- Kalau masih butuh webapp lokal untuk dev di server yang sama, tambahkan
  origin localhost di config **staging**, bukan di produksi.
- `hostname` soju hanya kosmetik (nama yang terlihat klien). Nama server
  **solanum** (`irc.solanum.test`) jangan diubah tanpa memperbarui link
  atheme dan SAN sertifikat internal; nama itu tidak pernah terlihat dari luar.

### Sertifikat internal

`scripts/generate-certs.sh` tetap dipakai apa adanya. CA lokal itu hanya
mengamankan lalu lintas **di dalam** docker (soju → solanum). Sertifikat
publik untuk ketiga domain diurus Caddy (§6), jadi `pki/` tidak perlu
diganti dengan Let's Encrypt.

### Mailpit

Mailpit tetap ikut jalan (selalu `127.0.0.1`), tapi tidak dipakai lagi setelah
`SMTP_HOST` diisi. Boleh dibiarkan, atau dimatikan dengan
`docker compose stop mailpit`.

## 6. Reverse proxy (Caddy)

`/etc/caddy/Caddyfile`:

```caddyfile
{
	email admin@snailog.com        # notifikasi Let's Encrypt
}

snailog.com, www.snailog.com {
	redir https://im.snailog.com{uri} permanent
}

im.snailog.com {
	root * /srv/snailog/webapp
	encode zstd gzip
	file_server

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		# Uji dulu sebagai Content-Security-Policy-Report-Only, lihat catatan.
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://irc.snailog.com; connect-src 'self' https://irc.snailog.com wss://irc.snailog.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
	}
	# index.html selalu dicek ulang supaya rilis baru langsung terpakai
	@html path / /index.html
	header @html Cache-Control "no-cache"
}

irc.snailog.com {
	encode zstd gzip

	# WebSocket soju (webapp; nanti juga app desktop, lihat §2 butir 1)
	handle /socket {
		reverse_proxy 127.0.0.1:16668
	}

	# Service akun: HTTP + Server-Sent Events (/events)
	handle {
		reverse_proxy 127.0.0.1:16680 {
			flush_interval -1          # SSE dikirim langsung, tanpa buffer
		}
	}
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Catatan:
- Caddy mengurus sertifikat Let's Encrypt dan pembaruannya sendiri; port 80
  harus terbuka untuk challenge HTTP.
- WebSocket diteruskan otomatis oleh `reverse_proxy`, termasuk header `Origin`
  yang dicek soju (`http-origin`).
- `api` sudah mengirim `X-Accel-Buffering: no` di `/events`, jadi SSE juga
  aman di belakang nginx. Kalau memakai nginx, set
  `proxy_buffering off; proxy_read_timeout 1h;` untuk `/events`, dan
  `proxy_http_version 1.1` + header `Upgrade`/`Connection` untuk `/socket`.
- **CSP**: `index.html` memakai `<style>` inline dan banyak atribut `style=`,
  jadi `'unsafe-inline'` untuk style dibutuhkan. Script inline tidak ada.
  Jalankan dulu sebagai `Content-Security-Policy-Report-Only`, buka semua
  fitur (pratinjau link, gambar, tema, notifikasi), cek console browser,
  baru aktifkan.

## 7. Deploy webapp (`im.snailog.com`)

Webapp adalah folder `desktop/ui/` tanpa build step, ditambah `config.js`
produksi. Ada dua cara meng-host-nya. **Cloudflare Workers** adalah cara yang
sudah disiapkan di repo; cara VPS tetap dicatat di bawahnya.

### Cloudflare Workers (disarankan)

Semua file ada di folder `webapp/` di root repo:

| File | Isi |
|---|---|
| `webapp/config.js` | alamat produksi: `https://irc.snailog.com`, `wss://irc.snailog.com/socket`, `allowWsOverride: false` |
| `webapp/_headers` | HSTS, `nosniff`, `X-Frame-Options`, CSP (masih **Report-Only**), `no-cache` untuk `index.html` dan `config.js` |
| `webapp/wrangler.jsonc` | Worker `snailog-webapp`, static assets dari `./public`, custom domain `im.snailog.com`; tanpa script Worker |
| `webapp/deploy.sh` | menyalin `desktop/ui/` + `config.js` + `_headers` ke `public/` (gitignored), memberi `?v=<commit>` pada `app.js`/`web-shim.js`, lalu `wrangler deploy` |

```bash
npx wrangler login                 # sekali
./webapp/deploy.sh --dry-run       # opsional: lihat webapp/public/ dulu
python3 tests/webapp/test_build.py # cek build: alamat produksi, header, override mati
./webapp/deploy.sh                 # deploy
```

Rollback: `cd webapp && npx wrangler rollback`.

Pengaturan di Cloudflare:

1. **DNS.** Zona `snailog.com` harus dikelola Cloudflare (nameserver
   dipindah ke Cloudflare). Record `im` tidak perlu dibuat manual karena
   Wrangler membuatnya saat deploy (`custom_domain`). Record
   `irc.snailog.com` dibuat **DNS only (awan abu-abu)** supaya Caddy tetap
   mengurus TLS-nya sendiri, dan `TRUSTED_PROXIES` / `accept-proxy-ip` cukup
   berisi IP gateway docker (§5, catatan Cloudflare di §3).
2. **Redirect `snailog.com`.** *Rules → Redirect Rules*: `snailog.com/*` dan
   `www.snailog.com/*` → `https://im.snailog.com/${1}` (301). Record apex dan
   `www` dibuat *proxied* (awan oranye) ke IP mana pun, karena request tidak
   pernah sampai ke sana.
3. **Caddyfile** di VPS cukup berisi blok `irc.snailog.com` dari §6; blok
   `snailog.com` dan `im.snailog.com` tidak dipakai.
4. **CSP.** Setelah semua fitur dicoba di browser tanpa pelanggaran di
   console, ganti `Content-Security-Policy-Report-Only` menjadi
   `Content-Security-Policy` di `webapp/_headers`, lalu deploy ulang.

Origin webapp tetap `https://im.snailog.com`, jadi `http-origin` di
`soju/config`, CORS `api`, dan `connect-src` di CSP sama seperti cara VPS.

### Di VPS (tanpa Cloudflare)

Pakai blok `im.snailog.com` di Caddyfile §6, lalu isi `/srv/snailog/webapp`
dengan hasil build yang sama:

```bash
./webapp/deploy.sh --dry-run
rsync -av --delete webapp/public/ deploy@server:/srv/snailog/webapp/
```

`_headers` ikut tersalin tapi diabaikan Caddy; header di Caddyfile yang
berlaku.

Apa pun caranya, cek tampilan di HP sebelum rilis:
`python3 tests/visual/run.py mobile tablet`.

## 8. Urutan deploy (pertama kali)

```bash
# 0. di server: clone repo ke /opt/snailog (atau path lain), checkout tag rilis
cd /opt/snailog/server

# 1. konfigurasi
./scripts/gen-prod-env.sh && $EDITOR .env    # §5: isi SMTP, ADMIN_USERS, SOJU_USER
$EDITOR soju/config                           # §5: http-origin, accept-proxy-ip, hostname

# 2. sertifikat internal + database api
./scripts/generate-certs.sh
./scripts/soju-host-ip.sh
./scripts/sync-secrets.sh
docker compose up -d postgres
./scripts/init-api-db.sh                      # menulis SNAILOG_DB_PASSWORD ke .env…
./scripts/sync-secrets.sh                     # …jadi secret disalin ulang

# 3. naikkan stack
docker compose up -d --build
docker compose ps                             # semua (healthy)

# 4. room bawaan (konek langsung ke solanum di 127.0.0.1:6697)
python3 scripts/setup-rooms.py                # #lobby + #snailog-presence

# 5. reverse proxy (+ webapp: ./webapp/deploy.sh dari mesin rilis, §7)
sudo $EDITOR /etc/caddy/Caddyfile             # §6
sudo systemctl reload caddy

# 6. backup + monitoring (operations.md)
crontab -e
#   17 3 * * *   /opt/snailog/server/scripts/backup.sh  >> /var/log/irc-backup.log 2>&1
#   */5 * * * *  /opt/snailog/server/scripts/monitor.sh >> /var/log/irc-monitor.log 2>&1
```

**Izin file di Linux.** Container membaca secret dan kunci TLS sebagai user
lain (solanum uid 1001, atheme uid 1000, soju dan api sebagai root tanpa
capability), sementara bind mount mempertahankan pemilik dan izin file di
host. Karena itu `sync-secrets.sh` menulis secret dengan izin `644` di folder
`700`, kecuali `pgpass` yang harus `600` milik root (soju mengabaikan pgpass
yang lebih longgar, lalu login postgres gagal); keduanya butuh `sudo`. Lalu `generate-certs.sh` meng-`chown` kunci TLS ke uid pembacanya (butuh
`sudo`). Di Mac masalah ini tidak terlihat karena Docker Desktop mengabaikan
izin file. User deploy harus anggota grup `docker`
(`sudo usermod -aG docker $USER`, lalu login ulang).

Cek nama dan urutan script di `README.md` / `operations.md` kalau ada yang
berubah sejak dokumen ini ditulis.

## 9. (Opsional) Port IRC untuk klien IRC biasa / app desktop lama

Hanya perlu kalau app desktop memakai opsi (b) di §2 butir 1, atau kalau
kamu ingin pengguna bisa memakai klien IRC lain (HexChat, irssi):

- Publish TLS soju: `SOJU_BIND=0.0.0.0`, buka port `16697` (atau petakan ke
  `6697`).
- Sertifikat `soju/tls-*.pem` harus sertifikat **publik** untuk
  `irc.snailog.com`, bukan CA lokal. Salin dari penyimpanan Caddy
  (`/var/lib/caddy/.local/share/caddy/certificates/…`) lewat hook atau cron,
  lalu `docker compose restart soju`. Ingat: sertifikat diperbarui tiap
  ±60 hari.
- Jangan pernah membuka port plaintext (`16667`, `6667`).

## 10. Verifikasi setelah deploy

```bash
# TLS + redirect
curl -sI https://snailog.com            | grep -i '^location'   # → https://im.snailog.com/
curl -sI https://im.snailog.com         | head -1               # HTTP/2 200

# api hidup dan CORS terkirim
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://irc.snailog.com/session \
  -H 'Origin: https://im.snailog.com'                           # 204/200

# WebSocket soju: origin yang benar diterima, origin asing ditolak
curl -s -o /dev/null -w '%{http_code}\n' https://irc.snailog.com/socket \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://im.snailog.com'   # 101
curl -s -o /dev/null -w '%{http_code}\n' https://irc.snailog.com/socket \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://evil.example'      # 403

# port internal tidak terlihat dari luar (jalankan dari mesin LAIN)
nc -zv irc.snailog.com 16667 16668 16680 6667 6697           # semua harus gagal

# kesehatan stack
./scripts/monitor.sh
```

Lalu uji manual di HP dan desktop browser:

1. Buat akun baru → email reset password benar-benar sampai (cek folder spam).
2. Sign in, masuk `#lobby`, kirim pesan dari dua perangkat berbeda.
3. Status teman berubah live (SSE `/events`), indikator mengetik muncul.
4. Pratinjau link muncul (`/preview` butuh akses internet keluar dari server).
5. Reset password lewat email.
6. Buka `/join/lobby` dari browser.
7. Buat 6 akun dari IP yang sama → yang ke-6 ditolak. Ini membuktikan
   `TRUSTED_PROXIES` benar: rate limit dihitung per pengguna, bukan per Caddy.

## 11. Rilis berikutnya

```bash
cd /opt/snailog && git fetch && git checkout <tag>
cd server
./scripts/backup.sh                       # selalu backup dulu
docker compose up -d --build              # hanya container yang berubah di-recreate
./scripts/monitor.sh
# webapp: ./webapp/deploy.sh (§7)
```

Kalau `.env` berubah: `./scripts/sync-secrets.sh` dulu, baru `up -d`.

## 12. Checklist go-live

- [ ] `python3 tests/webapp/test_build.py` lulus; (untuk app desktop: §2 butir 1 selesai)
- [ ] DNS A/AAAA untuk `snailog.com`, `www`, `im`, `irc` mengarah ke server
- [ ] SPF, DKIM, DMARC untuk `snailog.com`; email uji tidak masuk spam
- [ ] `.env` dibuat dengan `gen-prod-env.sh`; tidak ada `__ISI_`, SMTP sungguhan, `SOJU_USER`, `ADMIN_USERS`, `TRUSTED_PROXIES` sudah diverifikasi
- [ ] Semua `*_BIND` = `127.0.0.1`; firewall hanya 22/80/443
- [ ] `soju/config`: `http-origin https://im.snailog.com`, `accept-proxy-ip 172.30.99.1/32`
- [ ] User/password tes (`SOJU_USER`, akun demo) dihapus atau diganti
- [ ] Caddy aktif, sertifikat terbit untuk ketiga domain (atau, dengan Cloudflare Workers: `irc.snailog.com` di Caddy, `im.` lewat Workers, redirect apex di Cloudflare)
- [ ] CSP diuji dalam mode report-only, lalu diaktifkan
- [ ] `docker compose ps` semua healthy; `monitor.sh` tanpa FAIL
- [ ] Cron backup + monitor terpasang; satu kali **restore** diuji ke mesin lain
- [ ] Verifikasi §10 lulus di HP dan desktop
