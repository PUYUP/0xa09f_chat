# Arsitektur app desktop a09f

## Gambaran

```
 app desktop (Tauri)                               server (docker)
┌──────────────────────────┐  IRC (TCP 16667)   ┌──────────────────────┐
│ ui/app.js  (semua logika) │ ────────────────▶ │ Ergo (server IRC +   │──┐
│ ui/index.html (UI + CSS)  │                    │ NickServ/ChanServ +  │  │ history
│ src-tauri/src/lib.rs      │                    │ klien always-on)     │  ▼
│  (jembatan TCP, keychain, │  HTTP + SSE 16680  ├──────────────────────┤ PostgreSQL
│   tray, file export)      │ ────────────────▶ │ api (Go, service akun)│──┘
└──────────────────────────┘                    └──────────────────────┘
```

- **Rust (`lib.rs`) tipis**: membuka TCP ke Ergo dan meneruskan baris IRC
  mentah (`connect`/`send`/`disconnect`, event `irc-line`/`irc-closed`),
  plus keychain (`cred_*`), tray, autostart, deep link `a09f://`, nama
  perangkat, dan menulis file export ke Downloads. Semua protokol IRC ada di
  JavaScript.
- **Ergo**: ID a09f = akun Ergo = nick (dipaksa server). App login dengan
  SASL PLAIN. Setiap akun adalah klien **always-on**: tetap ada di jaringan
  tanpa perangkat tersambung, jadi pesan offline dan room tetap; tanpa
  perangkat = auto-away = "Offline" di app. History (`CHATHISTORY`), read
  marker (`MARKREAD`), kepemilikan room (ChanServ REGISTER/AMODE/TRANSFER/
  UNREGISTER) semua di Ergo.
- **Service akun** (`server/api`, Go): hal yang tidak bisa lewat IRC atau
  harus berlaku lintas perangkat — lihat `server/docs/api.md`.

## Mengapa beberapa hal tidak lewat IRC

| Fitur | Masalah di IRC | Solusi |
|---|---|---|
| typing | TAGMSG tidak sampai ke app yang belum terhubung; dulu solanum membuangnya | SSE service akun |
| hapus/edit/reaksi | kunci pesan lama (tanpa msgid) dipertahankan supaya data tetap cocok | kunci pesan sender+target+waktu+hash, disimpan service |
| daftar teman | MONITOR per koneksi, tidak sinkron antar perangkat | tabel `friends` + friend request |
| kirim nanti | app mungkin tertutup | service login sebagai user (token JWT, *pre-away*) dan mengirim |
| invisible | AWAY biasa sempat terlihat online sesaat setelah sign in | `AWAY` dikirim **sebelum** registrasi (`draft/pre-away`) |
| only friends | Ergo tidak punya caller-id (`+g`) | app pengirim bertanya `/canpm`; app penerima menyembunyikan pesan dari bukan-teman (kecuali orang yang pernah kita kirimi pesan) |
| ask to join | Ergo tidak punya KNOCK | `/knock` → event `knock` → moderator room |
| profil, pesan sambutan | Ergo tidak punya property akun / ENTRYMSG | `/profile`, `/welcome` |
| pencarian pesan | tidak ada perintah SEARCH di Ergo | service mencari di history Ergo (room yang diikuti + private chat sendiri) |

## Kehadiran (presence)

- Online/offline: `away-notify` + WHOIS + MONITOR (klien always-on selalu
  "online" untuk MONITOR; away = tidak ada perangkat).
- Status (Busy, custom …): baris `STATUS <kode> [teks]` di room tersembunyi
  `#a09f-presence` (+nts, milik akun `a09f`), diumumkan ulang tiap sign in.
- Jam aktif, zona waktu, last seen, warna nama: service akun.

## Identitas pesan

`sender | target | time | hash` — `target` = room, atau ID penerima dari sisi
pengirim; `time` = `@time` server (sama di semua salinan); `hash` = FNV-1a teks.
Dipakai untuk hapus, edit, reaksi, pin, saved, pesan menghilang, lompat ke
pesan (`data-key` di DOM). Dihitung sekali per pesan (`msgKeyOf`).

## Riwayat & performa

- Per percakapan: **jendela geser 1.000 pesan**. Load older membuang yang
  terbaru (bar "Jump to latest"), pesan baru membuang yang terlama.
- History digambar **sekali per halaman** (`onHistoryBatch`), bukan per pesan.
- Toolbar pesan dibuat saat hover; reaksi/edit diambil per rentang waktu
  (`/msgmeta?from=&to=`).
- Redraw mempertahankan posisi baca; pesan baru hanya ikut turun kalau
  pembaca di bawah atau pesannya kiriman sendiri.

## Antrian & batas laju

- Ergo membatasi laju per koneksi (`fakelag`: burst 20, lalu 5 baris/dtk,
  budget besar untuk CHATHISTORY/WHOIS/MARKREAD saat sign-in).
- Perintah ChanServ lewat `serviceQueue` (jeda 0,4 dtk, 1 dtk setelah
  REGISTER). `csAsk()` mengumpulkan balasan **sejak perintahnya benar-benar
  dikirim**, mengenali awal balasan multi-baris (atau jumlah baris yang
  diumumkan, mis. AMODE), dan menahan antrian sampai balasan selesai.
  Perintah yang meminta kode konfirmasi (TRANSFER, UNREGISTER) dikirim ulang
  dengan kodenya.

## Keamanan

- Password hanya di memori selama sesi (dan di keychain kalau *Remember*).
- Ban/mute memakai `<id>!*@*` (mute: `m:<id>!*@*`): nick = akun di Ergo, jadi
  itu sama dengan ban akun, dan tidak bergantung pada IP.
- Room hidden & conference tidak pernah dikirim ke event yang disiarkan ke
  semua app (typing room, read room, activity), supaya namanya tidak bocor.
- Pratinjau link: pengaman SSRF di service (lihat `server/docs/api.md`).
- Export menulis hanya ke Downloads dengan nama yang disanitasi Rust.
- Pengait tes (`test_scenario`, `test_log`) hanya ada di build debug.

## Tes

Lihat `tests/README.md`: tes server, API, **e2e di dalam app asli** (build
debug + skrip peer), dan visual.
