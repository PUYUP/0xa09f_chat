# Testing

Suite Python (stdlib saja, tanpa dependency) di `tests/`, tiga kelompok:

- `tests/server/` — infrastruktur: Solanum, Soju, TLS
- `tests/api/` — service akun (`server/api`, Go) + perilaku IRC yang dipakai app
- `tests/e2e/` — app desktop sungguhan (debug build) menjalankan skenario

Test server mencetak tiap baris IRC `>>`/`<<` dan `[PASS]` per langkah; test
api/e2e mencetak `[PASS]`/`[FAIL]` dan keluar non-zero kalau ada yang gagal.

Semua test **self-contained** — bisa dijalankan berulang kali dan setelah
volume di-reset, tanpa setup manual. Yang butuh docker stack menganggap
`docker compose up -d` sudah dijalankan dari `server/`.

Helper bersama ada di `tests/lib/`: `a09f.py` (client IRC lewat soju dengan
SASL, client service akun, SSE, bookkeeping PASS/FAIL) dan `peer.py` (orang
lain dalam skenario e2e).

## tests/server/

### test_solanum.py

Connect langsung ke Solanum (default `127.0.0.1:6667`).

```bash
python3 tests/server/test_solanum.py             # plain :6667
python3 tests/server/test_solanum.py --tls       # TLS :6697
python3 tests/server/test_solanum.py <host> <port>
```

Yang diverifikasi:

1. `CAP LS`/`ACK echo-message`
2. `001` welcome + MOTD `372` (membuktikan motd termuat — bukan `422`)
3. `NickServ REGISTER` → services Atheme hidup
4. `NickServ IDENTIFY` → `900` / "already logged in" (Atheme auto-login
   setelah register, jadi kedua balasan diterima)
5. `JOIN #testchan` + echo `PRIVMSG`

Self-contained: nick dibuat unik per run (`t<random8>`), jadi REGISTER
selalu sukses walau `services.db` di-reset. Efek samping: `services.db`
menumpuk nick uji — tidak masalah untuk dev.

### test_soju.py

Connect ke Soju (default `127.0.0.1:16667`).

```bash
python3 tests/server/test_soju.py              # plain :16667
python3 tests/server/test_soju.py --tls        # TLS :16697
python3 tests/server/test_soju.py <host> <port>
```

Self-contained setup (idempotent, via `docker exec soju sojuctl`):

1. `user status pointilis` → kalau belum ada, `user create`; kalau ada,
   `user update -password` (sinkron dengan `.env` `SOJU_PASSWORD`).
2. `network status` → kalau network `SOJU_NETWORK` belum ada,
   `network create -addr irc+insecure://solanum:16668`.

Kredensial dibaca dari `server/.env` (`SOJU_USER`, `SOJU_PASSWORD`,
`SOJU_NETWORK`) dengan fallback default.

Yang diverifikasi:

1. `CAP LS` → `sasl=PLAIN` + cap `soju.im/*`
2. `AUTHENTICATE PLAIN` → `903`
3. `001` welcome sebagai `soluser` di `irc.solanum.test`
4. `JOIN #testchan` → numeric upstream solanum
5. `PRIVMSG` → `PING soju-msgid-*`
6. `NickServ INFO` → services reachable lewat bouncer

### test_tls.py

Handshake TLS smoke test untuk kedua listener TLS.

```bash
python3 tests/server/test_tls.py              # 127.0.0.1:6697 + :16697
python3 tests/server/test_tls.py <host> <solanum_port> <soju_port>
```

Memverifikasi handshake + server merespons setelah `NICK`/`USER`
(solanum kirim `NOTICE *** Checking Ident`, soju kirim `464`).

Catatan: cert self-signed → `CERT_NONE`. SNI dikirim sebagai IP literal
(`127.0.0.1`) — **jangan** pakai `irc.solanum.test` sebagai SNI ke solanum:
ssld solanum menolak handshake dengan alert `access_denied` untuk SNI
tersebut (quirk upstream; client IRC pada umumnya tidak mengirim SNI).

## tests/api/

Butuh docker stack + akun demo (`alice`, `bob`, … / password `demo-1234`;
override dengan `A09F_DEMO_PASSWORD`). Alamat bisa diubah lewat env
`A09F_SOJU_HOST`/`A09F_SOJU_PORT`, `A09F_SOLANUM_HOST`/`A09F_SOLANUM_PORT`,
`A09F_API`, `A09F_MAILPIT`.

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
| `test_irc_features.py` | STATUS, `+g`/ACCEPT, ChanServ REGISTER/FLAGS/MLOCK/ENTRYMSG, mute/ban by account, KNOCK, INVITE, CHATHISTORY, SEARCH, `network quote` |
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
| `privacy_time.js` | `+g` (716/718), ignore, peringatan zona waktu, kirim nanti, jam aktif |
| `long_history.js` | 2.500 pesan: jendela 1.000, Load older, Jump to latest, lompat ke pesan |
| `rooms.js` | buat room + MLOCK, moderator/mute/ban/kick, welcome, poll, pin, event, Seen by, link undangan, hapus room |
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

- `400 JOIN :Disconnected from upstream network` di test_soju → soju baru
  restart / upstream belum reconnect (backoff ~1 menit). Tunggu lalu ulang.
- Burst koneksi TLS beruntun bisa ke-throttle solanum
  (`throttle_duration = 60`, `throttle_count = 4` di `general{}`) →
  handshake ditolak `access_denied` sementara. Tunggu ±1 menit.
- Test butuh container jalan: `docker compose up -d` dulu.
- Skenario e2e yang membuat akun/room bisa bentrok kalau dijalankan
  bersamaan; jalankan runner-nya satu per satu.
