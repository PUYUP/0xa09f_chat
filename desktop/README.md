# a09f Desktop

Client desktop IRC untuk stack `server/` (Solanum + Atheme + Soju) —
dibangun dengan Tauri (Rust backend + vanilla JS frontend).

## Fitur (v0.1)

UI mengutamakan pengguna awam (gaya messenger klasik): tidak ada detail
server/protokol di layar.

- Layar **Sign In** (ID + password) → login ke bouncer Soju via SASL PLAIN.
  Alamat (`127.0.0.1:16667`) dan network (`solanum`) tetap — ubah konstanta
  `SERVER` / `NETWORK` di `ui/app.js`
- Layar **Create account** (ID + password + konfirmasi) → membuat akun lewat
  service `server/register` (`http://127.0.0.1:16680`, konstanta
  `REGISTER_URL`), lalu langsung sign in. Tiap akun punya nick IRC sendiri
- Room default **lobby**: kalau akun belum ada di room mana pun setelah sign in
  (akun baru, atau sudah keluar dari semua room), app otomatis join `#lobby`
  (konstanta `DEFAULT_ROOM`). Lobby terdaftar di ChanServ dengan topik sambutan
  (`server/scripts/setup-rooms.py`); topik room tampil di judul percakapan
- Buat/masuk room: ketik nama room lalu **Join** (`#` ditambahkan otomatis)
- Pindah room dengan klik nama room; riwayat per room tersimpan
- Daftar orang di room (NAMES + JOIN/PART/QUIT/NICK tracking)
- **Private chat** (grup *Private Chats*): klik nama orang untuk chat 1-on-1;
  pesan pribadi masuk otomatis membuka percakapannya; tutup dengan ×
- **Pesan offline & riwayat**: saat sign in app meminta `CHATHISTORY TARGETS`
  (private chat aktif 30 hari terakhir) dan `CHATHISTORY LATEST` (100 pesan)
  per room/chat dari soju. Badge belum-dibaca dihitung dari `draft/read-marker`
  (tersinkron antar perangkat) + Tip "X sent you N messages while you were away"
- **Friends list** (grup *Friends*, disimpan lokal per akun di `localStorage`):
  tambah lewat 👥 *Add Friend* atau ➕ di samping nama; status tiap teman:
  🟢 Available / 🔴 Busy / 🟠 Be Right Back, Stepped Out / custom / ⚪ Offline,
  plus notifikasi "X is now online" / "X signed off"
- **Status sendiri** (dropdown di toolbar): Available, Busy, Be Right Back,
  Stepped Out, Custom message
- Cara kerja presence (soju mengganti teks AWAY klien jadi "Auto away", jadi
  AWAY tidak bisa membawa pesan status):
  - **Offline** = soju auto-away (tidak ada perangkat tersambung; network dibuat
    dengan `-auto-away true`), live via `away-notify`, awal via `WHOIS` (301)
  - **Pesan status** = baris `STATUS <code> [text]` di room tersembunyi
    `#a09f-presence` (+s); dibaca dari riwayat soju saat sign in, dan
    diumumkan ulang tiap sign in (riwayat soju per akun)
  - teman non-a09f dipantau via `MONITOR`
- **BUZZ!** (tombol di bawah chat, hanya di private chat, jeda 10 detik):
  dikirim sebagai `/me BUZZ!!` (klien IRC lain melihat "* bob BUZZ!!").
  Penerima a09f: jendela bergoyang sungguhan (`setPosition`), dibawa ke depan,
  chat-nya terbuka, suara buzz, notifikasi. BUZZ dari riwayat tidak menggoyang
- **Notifikasi desktop** (`tauri-plugin-notification`) untuk pesan pribadi,
  BUZZ, nick disebut di room, dan teman online — hanya saat jendela tidak
  sedang dilihat. Di build dev macOS notifikasi tampil atas nama Terminal
- **Suara** (disintesis WebAudio, tanpa file audio): pesan masuk, mention,
  BUZZ, teman online/offline, sign in. Tombol 🔊/🔇 di toolbar (diingat)
- Judul jendela menampilkan total belum dibaca, mis. "a09f (3)"
- **Akun NickServ otomatis**: saat sign in app cek `WHOIS <diri>` (330 =
  sudah login). Kalau belum: `NickServ REGISTER <password> <id>@users.a09f.invalid`
  (email unik: Atheme `maxusers = 5` per email), atau `IDENTIFY` kalau nick sudah
  terdaftar, lalu `BouncerServ sasl set-plain` supaya soju login sendiri tiap
  reconnect. Password hanya disimpan di memori selama sesi. Password dengan spasi
  tidak bisa (batasan Atheme) — pendaftaran akun baru menolaknya
- **Room milik sendiri**: room baru yang kamu buat (kosong → kamu op) langsung
  didaftarkan ke ChanServ atas namamu + `GUARD` (room tidak hilang saat kosong) +
  `KEEPTOPIC`. Pemilik/moderator ditandai 👑 dan bisa ubah topik (✏️ Topic).
  Batas Atheme: 5 room per akun (`maxchans`)
- **Jelajah room** (🔍 Rooms): `LIST >0` (LIST polos di solanum
  menyembunyikan room sepi), cari nama/topik, Join, atau buat room baru
- **Keluar room**: × di daftar Chat Rooms atau 🚪 Leave di judul room → `PART`;
  soju ikut melupakan room-nya. Room milikmu tetap terdaftar (GUARD) dan bisa
  dimasuki lagi dari 🔍 Rooms
- **Profil** (👤 Profile): Name, Location, About me disimpan sebagai metadata
  akun NickServ (`SET PROPERTY name|location|about <value>`, value kosong =
  hapus). Profil orang lain dibuka lewat 👤 di daftar Friends/Members atau
  tombol 👤 Profile di judul private chat → `NickServ INFO <id>` (baris
  `Metadata : key = value` + `Registered` untuk "Member since"). Butuh akun yang
  sudah tertaut ke NickServ; terlihat oleh semua user
- **Conference** (🗣️ Conference): chat grup privat. App membuat room
  `#conf-<owner>-<kode>` dengan mode `+si` (rahasia + invite-only), tidak
  didaftarkan ke ChanServ (hilang saat semua keluar). Tiap undangan =
  `INVITE` (lolos +i) + `/me invited you to a conference: #conf-…` di private
  chat; baris itu tersimpan di history soju, jadi undangan tetap sampai walau
  penerimanya sedang sign out, dan tampil dengan tombol **Join**. Pemilik bisa
  mengundang lagi lewat ➕ Invite. Room conference kosong yang di-join ulang
  langsung ditinggalkan ("That conference has already ended")
- **Lupa password** (Sign In → *Forgot password?*): isi ID → kode 6 digit
  dikirim ke email pemulihan (`POST /reset/request`) → isi kode + password baru
  (`POST /reset/confirm`). Server mengganti password di soju, NickServ, dan
  SASL soju sekaligus. Create account sekarang wajib mengisi email
- **Email pemulihan** (🔑 Password → Recovery email): lihat/ganti lewat
  `POST /email` (dicek dengan password sesi). Akun tanpa email mendapat Tip
  sekali setiap sign in
- **Ganti password** (🔑 Password): berurutan `BouncerServ user update
  -password` → `NickServ SET PASSWORD` (kalau tertaut) → `BouncerServ sasl
  set-plain`; tiap langkah menunggu balasan, timeout 10 dtk
- Pesan sendiri lewat `echo-message`; jam di tiap pesan (`server-time`)
- Status **I'm Away** / **I'm Back**, tombol smiley
- Pesan teknis (MOTD, numerics, NickServ/BouncerServ) disembunyikan;
  error ditampilkan dengan bahasa sederhana
- Shortcut power-user tetap jalan: `/join`, `/part`, `/msg nick text`

## Menjalankan

```bash
cd desktop
npm install
npm run dev        # tauri dev (window + hot reload frontend)
# atau build binary:
npm run build      # → src-tauri/target/release/bundle/macos/a09f.app
```

Binary debug juga bisa langsung: `src-tauri/target/debug/a09f-desktop`
(setelah `cargo build` di `src-tauri/`).

## Cara kerja

- `src-tauri/src/lib.rs` — jembatan TCP tipis: command `connect`/`send`/
  `disconnect`, event `irc-line`/`irc-closed`. Tidak ada logika IRC di Rust.
- `ui/app.js` — seluruh protokol IRC: SASL PLAIN auth, parsing numerics,
  tracking channel/member, render UI.

## Batasan yang diketahui

- **Plaintext only** — connect ke `16667`. TLS `16697` butuh cert
  self-signed ditangani webview (belum diimplementasi).
- **Akun dev `pointilis` memakai nick bersama `soluser`.** Akun yang dibuat
  lewat Create account punya nick sendiri (= ID-nya).
- Form Sign In kosong; akun dev lama `pointilis` (lihat `.env` server) masih
  bisa dipakai.
- Registrasi NickServ tidak ada lagi di UI (masih bisa lewat
  `/msg NickServ REGISTER <password> <email>`).
