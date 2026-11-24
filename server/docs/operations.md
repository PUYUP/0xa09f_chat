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

## Persistence

| Data                        | Lokasi                              | Persist? |
|-----------------------------|-------------------------------------|----------|
| solanum ban.db              | `/var/local/ban.db` (volume `solanum-state`) | ya |
| solanum logs                | volume `solanum-logs`               | ya       |
| atheme services.db          | `./atheme/etc/services.db` (repo)   | ya       |
| soju users/networks/history | volume `postgres-data` (DB `soju`)  | ya       |
| soju admin socket           | volume `soju-db` → `/db`            | ya       |
| soju uploads                 | volume `soju-uploads`               | ya       |

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
python3 tests/test_solanum.py          # direct ke solanum:6667
python3 tests/test_solanum.py --tls    # direct TLS :6697
python3 tests/test_soju.py             # via bouncer:16667 + SASL (self-setup)
python3 tests/test_soju.py --tls       # via bouncer TLS :16697
python3 tests/test_tls.py              # handshake TLS kedua listener
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
