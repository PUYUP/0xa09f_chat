# Testing

Suite Python (stdlib saja, tanpa dependency) di `tests/`, tiga kelompok:

- `tests/server/` — server IRC (Ergo)
- `tests/api/` — service akun (`server/api`, Go) + perilaku IRC yang dipakai app
- `tests/e2e/` — app desktop sungguhan (debug build) menjalankan skenario

Test server mencetak tiap baris IRC `>>`/`<<` dan `[PASS]` per langkah; test
api/e2e mencetak `[PASS]`/`[FAIL]` dan keluar non-zero kalau ada yang gagal.

Semua test **self-contained** — bisa dijalankan berulang kali dan setelah
volume di-reset, tanpa setup manual. Yang butuh docker stack menganggap
`docker compose up -d` sudah dijalankan dari `server/`.

Helper bersama ada di `tests/lib/`: `a09f.py` (client IRC ke Ergo dengan
SASL, client service akun, SSE, SQL untuk bersih-bersih, bookkeeping PASS/FAIL) dan `peer.py` (orang
lain dalam skenario e2e).

## tests/server/

### test_ergo.py

```bash
python3 tests/server/test_ergo.py      # A09F_IRC_HOST/PORT (16667), A09F_IRC_TLS_PORT (16697)
```

Memverifikasi: capability IRCv3 yang dipakai app ditawarkan, koneksi tanpa
akun ditolak (SASL wajib), password salah → `904`, akun demo bisa sign in
lewat plain dan TLS, nick = akun, akun always-on + auto-away, dan
pendaftaran akun lewat IRC mati.

## tests/api/

Butuh docker stack + akun demo (`server/scripts/seed-demo.sh`: `alice`,
`bob`, … / password `demo-1234`; override dengan `A09F_DEMO_PASSWORD`).
Alamat lewat env `A09F_IRC_HOST`/`A09F_IRC_PORT`, `A09F_API`, `A09F_MAILPIT`.
Bersih-bersih SQL memakai `docker exec a09f-postgres psql …`; ganti dengan
`A09F_PSQL` / `A09F_PSQL_HISTORY` kalau postgres tidak di docker.

```bash
python3 tests/api/test_messages.py
python3 tests/api/test_friends.py
python3 tests/api/test_rooms_people.py
python3 tests/api/test_irc_features.py
python3 tests/api/test_preview.py
python3 tests/api/test_account.py
```

| file | yang diverifikasi |
| --- | --- |
| `test_messages.py` | hapus, reaksi, edit, pin, polling, pesan menghilang, Saved, kirim nanti |
| `test_friends.py` | friend request, grup, typing, ignore / friends-only, search, perangkat |
| `test_rooms_people.py` | event + RSVP, kategori/bahasa, trending, zona waktu room, saran teman, Seen by, catatan pribadi, halaman undangan |
| `test_irc_features.py` | STATUS, pesan ke akun offline (always-on), `/canpm`, ChanServ REGISTER/AMODE, mode room tersimpan, mute (`+b m:`)/ban, `/knock`, INVITE, CHATHISTORY, pencarian lewat service |
| `test_preview.py` | pratinjau link + penjagaan SSRF (butuh internet untuk kasus publik) |
| `test_account.py` | buat akun, email pemulihan, reset password lewat Mailpit, batas login |

Catatan: `test_account.py` memakai satu dari 5 pembuatan akun per IP per jam,
dan `test_preview.py` butuh akses internet.

## tests/e2e/

Menjalankan app desktop asli (Tauri debug build) dan menggerakkan UI-nya
langsung: skenario JS dijalankan di dalam app, hasil `[PASS]`/`[FAIL]` dibaca
dari stderr.

```bash
python3 tests/e2e/run.py                       # semua skenario
python3 tests/e2e/run.py friends rooms         # hanya ini
python3 tests/e2e/run.py --no-build ...        # tanpa `cargo build`
A09F_E2E_TIMEOUT=600 python3 tests/e2e/run.py  # timeout per skenario (default 420 s)
```

Runner mem-build `desktop/src-tauri` (debug, UI di-embed), lalu untuk tiap
skenario: `prelude.js` + `scenarios/<nama>.js` dijalankan setelah app load
(lewat hook `test_scenario`/`test_log` yang hanya ada di debug build) dan
`scenarios/<nama>.peer.py` berperan sebagai orang lain (bob, frank, …).
Butuh docker stack + akun demo; di macOS jendela app dibawa ke depan karena
WebKit memperlambat timer di jendela tersembunyi.

| skenario | yang diverifikasi |
| --- | --- |
| `messaging.js` | gaya teks, `/me`, reply, edit, reaksi, hapus, pratinjau link, ✓ Seen, search, Saved + lompat |
| `friends.js` | friend request live, typing, status live, invisible, hapus teman dua arah |
| `privacy_time.js` | only friends (dua arah), ignore, peringatan zona waktu, kirim nanti, jam aktif |
| `long_history.js` | 2.500 pesan: jendela 1.000, Load older, Jump to latest, lompat ke pesan |
| `rooms.js` | buat room + mode, moderator/mute/ban/kick, welcome, poll, pin, event, Seen by, link undangan, hapus room |
| `app_settings.js` | mode gelap, quick switcher, DND, profil, warna nama, email pemulihan, perangkat, export JSON |

## tests/visual/

UI asli (`desktop/ui`) dirender di Chrome headless dengan API Tauri palsu;
skrip demo menyiapkan state, hasilnya screenshot di `tests/visual/out/`
(di-ignore git). Tidak butuh server maupun build app. Error JavaScript = gagal.

```bash
python3 tests/visual/run.py            # semua demo
python3 tests/visual/run.py themes     # satu demo (semua variannya)
```

## Menjalankan semua

Dari root repo (docker stack sudah jalan):

```bash
tests/run_all.sh                 # server, api, e2e, visual
tests/run_all.sh api e2e         # sebagian grup
```

Detail tiap grup juga ada di `tests/README.md`.

## Catatan flaky

- Test butuh container jalan: `docker compose up -d` lalu `scripts/seed-demo.sh`.
- Skenario e2e yang membuat akun/room bisa bentrok kalau dijalankan
  bersamaan; jalankan runner-nya satu per satu.
- `test_account.py` butuh Mailpit (email reset password).
