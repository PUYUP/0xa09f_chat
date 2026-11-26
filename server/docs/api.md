# API service akun (`server/api`)

Service HTTP dalam Go (`server/api`: satu binary, PostgreSQL lewat pgx,
`sojuctl` untuk soju) di `127.0.0.1:16680` (`REGISTER_PORT`). Ia melengkapi IRC
untuk hal-hal yang tidak bisa (atau tidak boleh) lewat IRC: pembuatan akun,
reset password, daftar teman di server, event live, dan metadata pesan.
Datanya di PostgreSQL (database `a09f`); data service Python lama
(`register.db`) diimpor sekali saat start pertama.

Semua respons JSON `{"ok": true, …}` atau `{"ok": false, "error": "<kalimat untuk user>"}`
dengan status 4xx/5xx. CORS `*` (dipanggil dari webview Tauri).

## Autentikasi

- **Tanpa token** (dibatasi per IP): `/register`, `/reset/*`, `/email`,
  `/session`, `/join/<room>`, `/health`.
- **Dengan token**: `POST /session {"username","password","device"}` →
  `{"token","sid","admin"}`. Password dicek dengan login SASL sungguhan ke
  soju. Kirim `Authorization: Bearer <token>`; untuk `GET /events` dan
  `GET /preview/img` token lewat query `?token=` (EventSource/`<img>` tidak
  bisa mengirim header).
- Sesi disimpan di tabel `sessions` (hanya SHA-256 token), jadi restart
  service tidak mengeluarkan siapa pun. Sesi yang tidak dipakai 2 hari
  berakhir sendiri; TTL maksimum 7 hari.
- `sid` = 12 karakter pertama SHA-256 token, publik; dipakai app untuk
  mengenali event yang dipicu perangkatnya sendiri.

### Batas laju

| Yang dibatasi | Batas | Kunci |
|---|---|---|
| `/register`, `/reset/*` | 30 percobaan/jam, 5 akun dibuat/jam | IP |
| `/session`, `/email` (cek password) | 10 password **salah**/jam | IP + ID |
| `/preview*` | 30/menit | user |
| reset code | 1 kode/60 dtk, berlaku 15 menit, 5 tebakan | ID |

Endpoint bertoken lain tidak dibatasi per IP (typing sering).

## Akun

| Method & path | Body / query | Hasil |
|---|---|---|
| `POST /register` | `username, password, email` | 201. Membuat user soju + network upstream (`-auto-away true`), menyimpan email |
| `POST /email` | `username, password[, email]` | baca / ganti email pemulihan |
| `POST /reset/request` | `username` | kirim kode 6 digit ke email (masked di respons) |
| `POST /reset/confirm` | `username, code, password` | ganti password di soju, NickServ (`network quote`) dan SASL soju; semua sesi berakhir + event `signed-out` |
| `POST /session` | `username, password, device` | token (lihat di atas) |
| `POST /session/end` | — | akhiri sesi ini (sign out) |
| `GET /sessions` | — | perangkat yang login: `sid, device, created, last, current` |
| `POST /session/revoke` | `sid` | keluarkan satu perangkat (event `signed-out {only: sid}`) |
| `POST /session/revoke-others` | — | setelah ganti password di app: keluarkan perangkat lain |

## Teman & privasi

| Method & path | Body / query | Catatan |
|---|---|---|
| `GET /friends` | — | `friends[{nick,group}]`, `incoming[{from,msg,created}]`, `outgoing[{to,group}]` |
| `POST /friends/request` | `to, group, msg` | `result: requested` atau `friends` (kalau mereka sudah me-request kita) |
| `POST /friends/respond` | `from, accept, group` | |
| `POST /friends/remove` | `nick` | putus **dua arah** / batalkan request |
| `POST /friends/move` | `nick, group` | |
| `POST /friends/rename-group` | `from, to` | |
| `GET/POST /prefs` | `ignore[], friendsOnly` | ignore list dibersihkan (bukan diri sendiri, ID valid, maks 200) |
| `GET /users/search?q=` | ≥ 2 huruf | ID yang mengandung `q`, **zona waktu terdekat dulu**; juga `tz` per hasil |
| `GET /suggestions` | — | saran teman `[{nick, reasons[]}]`: teman dari teman, aktif di room yang sama 14 hari, zona waktu dekat |
| `GET /notes`, `POST /note` | `about, text` | catatan pribadi tentang seseorang (kosong = hapus) |

## Kehadiran & profil

| Method & path | Body / query | Catatan |
|---|---|---|
| `POST /typing` | `to, active` | `to` = ID (private) atau `#room` (disiarkan ke semua app; app tidak mengirim untuk room hidden/conference) |
| `POST /read` | `to, time` | "✓ Seen" private chat |
| `POST /roomread`, `GET /roomreads?room=` | `room, time` | "👁 Seen by" di room (bukan conference) |
| `POST /profile/updated` | — | beri tahu teman (dan perangkat sendiri) untuk memuat ulang profil (profil disimpan di NickServ) |
| `GET /lastseen?users=` | — | `now` atau unix detik terakhir app ditutup |
| `POST /tz`, `GET /tz?users=` | `tz, offset` (menit timur UTC) | `GET` juga mengembalikan `active` |
| `POST /active` | `start, end` (menit lokal) / `null` | jam aktif |
| `POST /namecolor`, `GET /namecolors?users=` | `color` dari 12 warna / `null` | |
| `POST /imv`, `GET /imv?with=` | `with, theme` | tema private chat (dua sisi) |
| `GET /stats` | — | `online`: jumlah orang yang membuka app |

## Pesan

Pesan IRC tidak punya ID (soju tidak memberi `msgid`), jadi pesan dikenali dari
**`sender` + `target` + `time` + `hash`**:

- `target`: nama room (huruf kecil), atau untuk private chat **ID penerima
  dari sudut pandang pengirim**.
- `time`: waktu server (ms) dari tag `@time`; solanum memberi waktu yang sama
  ke semua salinan pesan.
- `hash`: FNV-1a 32-bit atas unit UTF-16 teks pesan (setelah ACTION dilepas),
  base36 — `msgHash()` di app, `fnv()` di `tests/lib/a09f.py`.

| Method & path | Body / query | Catatan |
|---|---|---|
| `POST /redact`, `GET /redactions?since=` | kunci pesan sendiri | hapus untuk semua (30 hari) |
| `POST /edit` | kunci + `text` | hanya pesan sendiri |
| `POST /react` | kunci + `emoji, on` | 👍 ❤️ 😂 😮 😢 🙏 🎉 🔥 |
| `POST /pin` | `room` + kunci + `text, on` | maks 5 per room; status moderator **tidak** diverifikasi server |
| `POST /expire` | kunci + `after` (dtk, 10 dtk – 7 hari) | pesan sendiri menghilang; loop server mengubahnya jadi redact |
| `GET /msgmeta?conv=&from=&to=` | rentang waktu ms opsional | reactions, edits, expiring (+ pins untuk room) satu percakapan |
| `POST /save`, `GET /saved` | kunci + `conv, text, on` | pesan tersimpan pribadi |
| `POST /poll/create`, `GET /poll?id=`, `POST /poll/vote` | `room, question, options[2..8]` / `id, option|null` | |
| `POST /schedule`, `GET /scheduled`, `POST /scheduled/cancel` | `target, text, due` (1 menit – 30 hari) | dikirim soju atas nama user (`sojuctl user run <id> network quote`), maks 50 antre |
| `POST /remind`, `GET /reminders`, `GET /reminders/due` | `text, minutes` | pengingat pribadi |
| `GET /preview?url=`, `GET /preview/img?u=&token=` | | pratinjau link, lihat "Pengaman SSRF" |

## Room

| Method & path | Body / query | Catatan |
|---|---|---|
| `POST /event/create` | `room, title, start` (unix, ≤ 1 tahun) | pembuat otomatis "going"; maks 20 event mendatang per room |
| `GET /roomevents?room=`, `GET /event?id=` | | `people{going,maybe,no}`, `mine` |
| `POST /event/rsvp` | `id, status` (`going`/`maybe`/`no`/`null`) | |
| `POST /event/delete` | `id` | hanya pembuat |
| `POST /roominfo`, `GET /roominfo?rooms=` | `room, category, lang` | kategori: general games music tech sports study movies hangout other |
| `POST /activity`, `GET /trending` | `room` | app melapor tiap pesan (bukan room hidden/conference); dipakai juga untuk zona waktu room & saran teman |
| `GET /roomtz?rooms=` | | median offset pengirim pesan 7 hari (berbobot jumlah pesan) |
| `GET /join/<room>` | publik | halaman HTML "Open in a09f" → `a09f://join/<room>` |

## Admin

| Method & path | Catatan |
|---|---|
| `POST /announce {"text"}` | hanya ID di `ADMIN_USERS` (env); disiarkan ke semua app, tersimpan 7 hari |
| `GET /announcements?after=<id>` | untuk yang sign in belakangan |

## Event live (`GET /events?token=`)

Server-Sent Events. Setiap event `event: <nama>` + `data: <json>`; keepalive
komentar tiap 25 dtk. Satu koneksi = satu goroutine; app yang lambat
kehilangan event (buffer 256) alih-alih memperlambat yang lain.

| Event | Ke siapa | Data |
|---|---|---|
| `friend-request`, `friend-accepted`, `friend-declined`, `friend-removed`, `friend-request-cancelled` | yang bersangkutan | `from` / `nick`, `msg` |
| `friends-changed`, `prefs-changed`, `saved-changed`, `scheduled-changed`, `notes-changed` | perangkat sendiri | `sid` pemicu (kalau ada) |
| `typing` | penerima / semua (room) | `from, active[, room]` |
| `read`, `room-read` | pengirim / semua | `from`/`user, time[, room]` |
| `redact`, `edit`, `reaction`, `expire` | dua pihak private chat / semua (room) | kunci pesan + data |
| `pins`, `poll`, `event`, `roominfo` | semua | `room` / `id` |
| `event-soon` | yang going/maybe | event, 15 menit sebelum mulai |
| `profile-updated`, `namecolor`, `active-changed` | teman / semua | `nick`/`user` |
| `imv` | kedua pihak | `a, b, theme, by` |
| `announcement` | semua | `id, author, text, created` |
| `online` | semua | `count` (di-debounce 2 dtk) |
| `reminder` | user | pengingat yang jatuh tempo |
| `signed-out` | perangkat user | `except: sid` (ganti password) atau `only: sid` (dikeluarkan) |

## Pengaman SSRF (`preview.go`)

Halaman diambil server atas nama user, jadi tidak boleh jadi jalan masuk ke
jaringan internal:

- hanya `http`/`https`, port 80/443/8080/8443;
- host di-resolve di service dan **semua** alamatnya harus publik (bukan
  private, loopback, link-local, multicast, reserved, jaringan docker);
- koneksi dibuat ke IP yang sudah dicek itu (tanpa resolve ulang), dengan
  Host/SNI asli; sertifikat HTTPS tetap diverifikasi;
- redirect diikuti manual, maks 3, masing-masing dicek ulang;
- timeout 5 dtk, halaman maks 512 KB (HTML saja), gambar maks 1 MB
  (jpeg/png/gif/webp), cache 6 jam;
- gambar diproksi lewat `/preview/img` sehingga IP user tidak sampai ke situs
  lain.

Diuji di `tests/api/test_preview.py`.
