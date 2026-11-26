# Operasi & Troubleshooting

## Perintah sehari-hari

```bash
cd server
docker compose up -d --build        # start / update
docker compose ps                   # semua (healthy)
docker compose logs -f ergo api     # log
docker compose restart api          # sesi app tersimpan di postgres: tidak ada yang ter-sign-out
docker compose down                 # stop (volume tetap)
./scripts/seed-demo.sh              # room bawaan + akun demo (idempotent)
```

## Data & persistence

| Volume | Isi |
|---|---|
| `postgres-data` | `ergo_history` (pesan, dikelola Ergo) dan `a09f` (teman, sesi, email pemulihan, reaksi, edit, pin, polling, event, …) |
| `ergo-data` | `ircd.db` Ergo: akun (hash bcrypt), room terdaftar (founder, mode, ban, AMODE, topik), klien always-on dan room yang diikuti |
| `ergo-tls` | sertifikat self-signed |

Backup: `pg_dump` kedua database + salin `ircd.db` (Ergo membuat backup
otomatis saat upgrade skema). Hapus semua data: `docker compose down -v`.

Sesi app (token) disimpan di tabel `sessions` (hanya hash SHA-256), jadi
restart service tidak mengeluarkan siapa pun. Sesi idle 2 hari / maksimum 7
hari berakhir sendiri.

## Akun

- Dibuat oleh service akun (`POST /register` dari app, atau
  `scripts/seed-demo.sh`) lewat HTTP API Ergo. Pendaftaran lewat IRC mati.
- Setelah dibuat, service langsung "sign in" sekali atas nama akun (token
  JWT) supaya klien always-on-nya ada di jaringan: pesan ke akun baru
  langsung diterima.
- Ganti/reset password: `POST /password` (app) atau `/reset/*` (email) →
  `/v1/ns/passwd` Ergo; perangkat lain dikeluarkan.
- Akun `a09f` memiliki room bawaan (`#lobby`, `#a09f-presence`) dan selalu
  ada di dalamnya; app menyembunyikannya dari daftar orang. Tidak ada yang
  login dengan password akun ini.

## Room

- Membuat room baru di app = JOIN + `ChanServ REGISTER` (jadi milik pembuat).
- Ergo menyimpan sendiri mode room terdaftar (private, hidden, password,
  batas orang), topik, ban/mute (`+b <id>!*@*`, mute `+b m:<id>!*@*`), dan
  moderator (`AMODE +o`).
- Pesan sambutan, kategori, bahasa, event, pin, polling disimpan service akun.
- "Ask to join" (`POST /knock`) dan "Seen by" lewat service akun.

## Kapasitas

- Akun yang tidak aktif tidak memakan koneksi TCP (always-on = state di
  memori Ergo). History disimpan sekali per room.
- Ergo satu proses (tanpa server linking): skala vertikal. Batas file
  descriptor 65536 di semua container.
- Service akun: satu goroutine per app yang terbuka untuk SSE (beberapa KB
  masing-masing), pool postgres 32 koneksi. Event ke banyak orang
  (`pushAll`) dikirim tanpa menunggu app yang lambat (buffer 256 per app,
  kelebihan dibuang).
- Batas laju Ergo (`fakelag`) dan batas per IP (`ip-limits`) ada di
  `ergo/ircd.yaml`. **Produksi**: hapus jaringan privat dari
  `ip-limits.exempted`, pasang TLS asli.

## Troubleshooting

| Gejala | Cek |
|---|---|
| `api` tidak healthy | `docker compose logs api` — biasanya postgres belum siap atau `.env` belum diisi (`init-env.sh`) |
| Sign in "Wrong ID or password" padahal benar | `docker compose logs ergo` (SASL), cek akun: `curl` ke `/v1/ns/info` dari dalam jaringan |
| App: "Can't reach a09f" | port `16667`/`16680` (`BIND_ADDR`), `docker compose ps` |
| Pencarian pesan "isn't available" | `HISTORY_DATABASE_URL` / hak baca role `a09f` di `ergo_history` (`postgres/initdb/01-roles.sh`) |
| Kirim nanti tidak terkirim | log `api` ("scheduled messages of …"): `JWT_KEY` harus sama di api dan ergo |
| Email reset tidak sampai | Mailpit di `http://127.0.0.1:16825`; produksi: `SMTP_*` |

## Security notes

- TLS self-signed (dev). Produksi: sertifikat asli di `ergo/ircd.yaml`.
- HTTP API Ergo dan postgres tidak dipublish ke host.
- `JWT_KEY` = kemampuan login sebagai siapa pun: perlakukan seperti password
  admin. Token yang dibuat service berlaku satu menit.
- Service akun berjalan sebagai user non-root di image Alpine minimal.
- Pratinjau link punya pengaman SSRF (lihat `api.md`).
