# Arsitektur app desktop a09f

## Gambaran

```
 app desktop (Tauri)                                  server (docker)
┌──────────────────────────┐   IRC (TCP 16667)   ┌──────┐     ┌─────────┐   ┌────────┐
│ ui/app.js  (semua logika) │ ─────────────────▶ │ soju │ ──▶ │ solanum │◀─▶│ atheme │
│ ui/index.html (UI + CSS)  │                     └──────┘     └─────────┘   └────────┘
│ src-tauri/src/lib.rs      │   HTTP + SSE (16680) ┌──────────────────────┐
│  (jembatan TCP, keychain, │ ─────────────────▶  │ register (service    │
│   tray, file export)      │                      │ akun, SQLite)        │
└──────────────────────────┘                      └──────────────────────┘
```

- **Rust (`lib.rs`) tipis**: membuka TCP ke soju dan meneruskan baris IRC
  mentah (`connect`/`send`/`disconnect`, event `irc-line`/`irc-closed`),
  plus keychain (`cred_*`), tray, autostart, deep link `a09f://`, nama
  perangkat, dan menulis file export ke Downloads. Semua protokol IRC ada di
  JavaScript.
- **soju** adalah bouncer: setiap akun a09f = user soju dengan satu koneksi
  upstream permanen ke solanum. Karena itu setiap akun **selalu online di
  IRC** — "offline" di app = soju `auto-away` (tidak ada perangkat
  tersambung). History, read marker, dan pencarian juga dari soju.
- **Atheme** (NickServ/ChanServ): akun NickServ dibuat app saat sign in
  pertama (password sama, `BouncerServ sasl set-plain` supaya soju login
  sendiri), kepemilikan room (ChanServ REGISTER/GUARD/MLOCK/FLAGS/ENTRYMSG),
  profil (`NickServ SET PROPERTY`).
- **Service akun** (`server/register`): hal yang tidak bisa lewat IRC atau
  harus berlaku lintas perangkat — lihat `server/docs/api.md`.

## Mengapa beberapa hal tidak lewat IRC

| Fitur | Masalah di IRC | Solusi |
|---|---|---|
| typing | solanum membuang `TAGMSG`/client tag; CTCP masuk history soju | SSE service akun |
| hapus/edit/reaksi | soju tidak memberi `msgid` (REDACT tidak bisa) | kunci pesan sender+target+waktu+hash, disimpan service |
| daftar teman | MONITOR/ACCEPT per koneksi, tidak sinkron antar perangkat | tabel `friends` + friend request |
| kirim nanti | app mungkin tertutup | service menyuruh soju mengirim (`sojuctl … network quote`) |
| invisible | AWAY biasa sempat terlihat online sesaat setelah sign in | `AWAY` dikirim **sebelum** registrasi (`draft/pre-away`) |

## Kehadiran (presence)

- Online/offline: `away-notify` + WHOIS (cache WHO soju bisa basi) + MONITOR.
- Status (Busy, custom …): baris `STATUS <kode> [teks]` di room tersembunyi
  `#a09f-presence` (+nts), diumumkan ulang tiap sign in (history soju per akun).
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

- soju menahan laju baris dari app ke solanum. Setelah sign in (banyak WHOIS,
  MONITOR, history, MODE) baris berikutnya bisa tertunda beberapa detik.
- Perintah ChanServ/NickServ lewat `serviceQueue` (jeda 1,5 dtk, 3 dtk setelah
  REGISTER) karena flood protection Atheme (`flood_msgs = 16` per 10 dtk di
  `atheme.conf.tmpl`). `csAsk()` mengumpulkan balasan **sejak perintahnya
  benar-benar dikirim**, mengenali awal balasan multi-baris, dan menahan
  antrian sampai balasan selesai (balasan perintah lain yang terlambat tidak
  ikut terhitung). Timeout 15 dtk.
- Mode "only friends" (`+g`): sebelum memasang `+g`, app membaca daftar
  ACCEPT di server (`ACCEPT *`) dan menghapus yang bukan teman — daftar itu
  hidup di koneksi upstream dan bertahan antar sesi. Catatan: solanum otomatis
  menambahkan siapa pun yang **kita kirimi pesan** ke daftar ACCEPT.

## Keamanan

- Password hanya di memori selama sesi (dan di keychain kalau *Remember*).
- Ban/mute memakai `$a:<akun>` dan `<id>!*@*` — semua user datang dari IP soju
  yang sama, jadi ban host akan mengenai semua orang.
- Room hidden & conference tidak pernah dikirim ke event yang disiarkan ke
  semua app (typing room, read room, activity), supaya namanya tidak bocor.
- Pratinjau link: pengaman SSRF di service (lihat `server/docs/api.md`).
- Export menulis hanya ke Downloads dengan nama yang disanitasi Rust.
- Pengait tes (`test_scenario`, `test_log`) hanya ada di build debug.

## Tes

Lihat `tests/README.md`: tes server, API, **e2e di dalam app asli** (build
debug + skrip peer), dan visual.
