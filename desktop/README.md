# a09f Desktop

Client desktop IRC untuk stack `server/` (Ergo + service akun Go) —
dibangun dengan Tauri (Rust backend + vanilla JS frontend).

Dokumentasi:
- [`docs/fitur.md`](docs/fitur.md) — panduan pemakaian semua fitur
- [`docs/arsitektur.md`](docs/arsitektur.md) — cara kerja & keputusan desain
- [`../server/docs/api.md`](../server/docs/api.md) — API service akun
- [`../tests/README.md`](../tests/README.md) — tes (server, API, e2e di app, visual)

## Fitur (v0.1)

UI mengutamakan pengguna awam (gaya messenger klasik): tidak ada detail
server/protokol di layar.

- Layar **Sign In** (ID + password) → login ke Ergo via SASL PLAIN (ID =
  akun = nick). Alamat (`127.0.0.1:16667`) tetap — konstanta `SERVER` di `ui/app.js`
- Layar **Create account** (ID + password + konfirmasi) → membuat akun lewat
  service akun `server/api` (`http://127.0.0.1:16680`, konstanta
  `REGISTER_URL`), lalu langsung sign in. Tiap akun punya nick IRC sendiri
- Room default **lobby**: kalau akun belum ada di room mana pun setelah sign in
  (akun baru, atau sudah keluar dari semua room), app otomatis join `#lobby`
  (konstanta `DEFAULT_ROOM`). Lobby terdaftar di ChanServ dengan topik sambutan
  (`server/scripts/seed-demo.sh`, milik akun `a09f`); topik room tampil di judul percakapan
- Buat/masuk room: ketik nama room lalu **Join** (`#` ditambahkan otomatis)
- Pindah room dengan klik nama room; riwayat per room tersimpan
- Daftar orang di room (NAMES + JOIN/PART/QUIT/NICK tracking)
- **Private chat** (grup *Private Chats*): klik nama orang untuk chat 1-on-1;
  pesan pribadi masuk otomatis membuka percakapannya; tutup dengan ×
- **Pesan offline & riwayat**: saat sign in app meminta `CHATHISTORY TARGETS`
  (private chat aktif 30 hari terakhir) dan `CHATHISTORY LATEST` (100 pesan)
  per room/chat dari Ergo. Badge belum-dibaca dihitung dari `draft/read-marker`
  (tersinkron antar perangkat) + Tip "X sent you N messages while you were away"
- **Friends list** (grup *Friends*, disimpan lokal per akun di `localStorage`):
  tambah lewat 👥 *Add Friend* atau ➕ di samping nama; status tiap teman:
  🟢 Available / 🔴 Busy / 🟠 Be Right Back, Stepped Out / custom / ⚪ Offline,
  plus notifikasi "X is now online" / "X signed off"
- **Status sendiri** (dropdown di toolbar): Available, Busy, Be Right Back,
  Stepped Out, Custom message
- Cara kerja presence:
  - **Offline** = auto-away Ergo (akun always-on tanpa perangkat tersambung),
    live via `away-notify`, awal via `WHOIS` (301)
  - **Pesan status** = baris `STATUS <code> [text]` di room tersembunyi
    `#a09f-presence` (+s); dibaca dari history room saat sign in, dan
    diumumkan ulang tiap sign in
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
- **Akun**: ID a09f adalah akun Ergo (dibuat service akun), jadi tidak ada
  langkah NickServ di app. Password hanya disimpan di memori selama sesi
- **Room milik sendiri**: room baru yang kamu buat (kosong → kamu op) langsung
  didaftarkan ke ChanServ atas namamu; Ergo menyimpan topik, mode, ban, dan
  moderator room terdaftar (juga saat kosong). Pemilik/moderator ditandai 👑
  dan bisa ubah topik (✏️ Topic). Batas: 50 room per akun
- **Jelajah room** (🔍 Rooms): `LIST >0`, cari nama/topik, Join, atau buat room baru
- **Keluar room**: × di daftar Chat Rooms atau 🚪 Leave di judul room → `PART`;
  Ergo ikut melupakan room-nya. Room milikmu tetap terdaftar dan bisa
  dimasuki lagi dari 🔍 Rooms
- **Profil** (👤 Profile): Name, Location, About me disimpan service akun
  (`GET/POST /profile`); "Member since" = tanggal akun Ergo. Profil orang lain
  dibuka lewat 👤 di daftar Friends/Members atau tombol 👤 Profile di judul
  private chat; terlihat oleh semua user
- **Conference** (🗣️ Conference): chat grup privat. App membuat room
  `#conf-<owner>-<kode>` dengan mode `+si` (rahasia + invite-only), tidak
  didaftarkan ke ChanServ (hilang saat semua keluar). Tiap undangan =
  `INVITE` (lolos +i) + `/me invited you to a conference: #conf-…` di private
  chat; baris itu tersimpan di history Ergo, jadi undangan tetap sampai walau
  penerimanya sedang sign out, dan tampil dengan tombol **Join**. Pemilik bisa
  mengundang lagi lewat ➕ Invite. Room conference kosong yang di-join ulang
  langsung ditinggalkan ("That conference has already ended")
- **Teman (server-side) + grup + friend request**: daftar teman disimpan di
  service akun (`server/api`, tabel `friends`/`friend_requests`), jadi
  ikut ke komputer mana pun. Add Friend = kirim request (pilih grup + pesan
  opsional); penerima melihat kartu **Accept / Decline** di Friends. Kalau
  dua orang saling request → langsung berteman. Teman dikelompokkan per grup
  (⋯ di teman: pindah grup / grup baru / hapus; ⋯ di grup: rename). Request
  yang belum dijawab tampil abu-abu "Waiting for approval". Daftar lama di
  localStorage otomatis dikirim sebagai request sekali
- **Typing indicator** ("bob is typing…", private chat saja): lewat service
  akun (`POST /typing` → Server-Sent Events `GET /events`), bukan IRC
- **Invisible** (👻 di pilihan status): app mengirim `AWAY` *sebelum*
  registrasi selesai (`draft/pre-away`), jadi teman tidak pernah melihatmu
  online, bahkan sesaat setelah sign in. Pilihan ini diingat per akun di
  komputer ini
- **Remember my ID & password / Sign me in automatically**: ID + pilihan di
  localStorage, password di keychain OS (Rust `keyring`: Keychain macOS /
  Credential Manager Windows). Password tersimpan dihapus otomatis kalau
  ditolak server
- **Tray**: tombol tutup menyembunyikan jendela, a09f tetap jalan (pesan,
  BUZZ, notifikasi tetap masuk). Ikon tray: klik = buka; menu Open / Sign Out /
  Quit. macOS: klik ikon Dock juga membuka lagi
- **Start a09f when my computer starts** (`tauri-plugin-autostart`): dimulai
  tersembunyi di tray dengan argumen `--autostart`; kombinasikan dengan
  auto sign-in
- **Serba live (SSE dari service akun)**: hapus teman berlaku dua arah dan
  langsung hilang di sisi teman; perubahan teman/grup/ignore/"only friends" di
  satu perangkat langsung tampil di perangkatmu yang lain; profil yang
  disimpan memperbarui dialog profil yang sedang dibuka teman; status di
  dialog profil ikut berubah; **✓ Seen** di private chat saat pesanmu sudah
  dibaca (dikirim saat jendela fokus); ganti password (di app) atau reset
  password mengeluarkan perangkat lain dan meminta sign in ulang
- **@mention**: ketik `@` di room → daftar anggota (↑/↓, Tab/Enter, atau
  klik). `@nama` tampil tebal ungu; pesan yang menyebut namamu disorot kuning,
  berbunyi + notifikasi, dan room-nya mendapat badge **@** oranye sampai dibaca
- **Kelola room** (moderator/pemilik): klik kanan orang di room → Make/Remove
  moderator (`MODE +o` + ChanServ `AMODE +o` di room terdaftar), Mute
  (`+b m:<id>!*@*`), Remove (`KICK`), Ban (`+b <id>!*@*`; nick = akun di
  Ergo). ⚙️ Settings: Private (+i), Hidden (+s), Announcement (+m), password
  (+k), batas orang (+l) lewat `MODE` (Ergo menyimpannya untuk room
  terdaftar); welcome message (service akun `/welcome`, tampil sebagai
  "Welcome" saat masuk); daftar moderator (`CS INFO` + `CS AMODE`) / muted /
  banned dengan tombol cabut; pemilik bisa memberi room ke orang lain
  (`CS TRANSFER` + kode; app penerima menerimanya otomatis) atau menghapusnya
  (`CS UNREGISTER` + kode)
- **Undang ke room & minta masuk**: ➕ Invite di room biasa (INVITE + `/me
  invited you to a room: #x` dengan tombol Join). Room privat (473) →
  tombol 🚪 Ask to join (`POST /knock`, event `knock`); moderator mendapat "X asked to join" +
  tombol Let them in. Room berpassword (475) → kolom password + Join
- **Auto-reply**: kirim private message ke orang yang Busy / Be Right Back /
  Stepped Out / custom-away / Offline → baris "Auto-reply" sekali per status
- Room baru hanya didaftarkan ke ChanServ oleh perangkat yang benar-benar
  mengirim JOIN (Ergo juga meneruskan JOIN dari perangkatmu yang lain)
- **/me**: ketik `/me waves` atau tombol ✨ /me → pesan aksi `* alice waves`
- **Hapus pesan sendiri**: arahkan kursor ke pesanmu → 🗑 → "Delete?" → pesan
  jadi "🚫 This message was deleted" di semua app, termasuk history. Pesan
  dikenali dari pengirim + tujuan + waktu server (sama di semua salinan) + hash
  teks; daftarnya disimpan service akun 30 hari (`/redact`, `/redactions`).
  Catatan: client IRC lain tetap melihat pesannya
- **Pengumuman admin** (📢 Announce, hanya ID di `ADMIN_USERS`): banner kuning
  di atas percakapan semua app, live + untuk yang sign in dalam 7 hari;
  ditutup dengan ✕ (diingat per akun)
- **Jumlah online** di header: orang yang sedang membuka app a09f (koneksi
  live ke service akun) — LUSERS tidak berguna karena semua akun always-on
- **Aksi di tiap pesan** (arahkan kursor ke pesan): 😀 reaksi (👍 ❤️ 😂 😮 😢 🙏
  🎉 🔥, chip dengan jumlah — klik untuk ikut/batal), ↩ Reply (pesan dikirim
  sebagai `↪ nama: “kutipan” balasan`, tetap terbaca di client IRC lain; di
  a09f tampil sebagai kutipan), ✏️ Edit (pesanmu sendiri, tampil "(edited)" di
  semua app a09f), 📌 Pin (moderator; bar di atas room, maks 5), 🗑 Hapus.
  Reaksi/edit/pin disimpan service akun (`/react`, `/edit`, `/pin`,
  `/msgmeta`) dengan identitas pesan yang sama seperti hapus pesan; edit tidak
  terlihat di client IRC lain. Catatan: server tidak memverifikasi status
  moderator untuk pin (tombolnya hanya muncul untuk moderator)
- **Polling** di room: `/poll Makan di mana? | Bakso | Sate | Pizza` → kartu
  polling dengan bar hasil, klik untuk memilih/batal, live (`/poll/*`)
- **Last seen**: teman offline tampil "Offline · seen 2h ago" (dicatat saat
  app terakhir ditutup; diperbarui tiap 2 menit)
- **Pengingat**: `/remind 10m minum air` (m/h/d, maks 30 hari) → "⏰ Reminder"
  + suara + notifikasi; yang jatuh tempo saat app tertutup muncul waktu sign in
- Tombol ⋯ di Friends selalu terlihat, dan daftar Friends hanya digambar ulang
  kalau ada yang berubah (WebKit kehilangan :hover saat baris diganti)
- **Buat room**: nama room yang diketik (kotak Join, 🔍 Rooms → Create,
  `/join`) dicek dulu dengan `LIST #nama`. Sudah ada → langsung masuk. Belum
  ada → dialog **Create Room** (topik, private, hidden, password, batas
  orang, welcome message); room baru dibuat setelah dikonfirmasi, lalu
  pengaturannya dipasang lewat `MODE` (+ welcome message di service akun). Undangan/conference/knock tetap langsung join
- **Warna nama**: 👤 Profile → Name color (12 warna yang terbaca di latar
  putih, atau default). Langsung berlaku di chat, Friends, dan Members semua
  orang (`/namecolor`, event live `namecolor`; warna diambil per batch lewat
  `/namecolors`)
- **Pesan menghilang** (⏳ di bar format: 1 menit / 1 jam / 1 hari): app
  mendaftarkan pesan ke service akun begitu server mengembalikannya
  (`/expire`); loop server mengubahnya jadi pesan terhapus tepat waktu.
  Label ⏳ hitung mundur tampil di semua app a09f
- **Mode gelap** (🌙/☀️ di header, diingat per komputer)
- **Quick switcher**: Ctrl/Cmd+K → ketik sebagian nama room/teman/chat
  (huruf berurutan juga cocok: "lby" → lobby), ↑↓ Enter; bisa juga
  "Join or create #nama"
- **⭐ Saved**: ⭐ di toolbar pesan untuk menyimpan, daftar di tombol ⭐ Saved
  (`/save`, `/saved`; sinkron antar perangkat)
- **Do Not Disturb**: klik tombol Sound → bisukan suara, DND 1 jam / sampai
  besok 08:00, jam tenang (default 22:00–07:00, bisa diubah). Saat tenang
  tidak ada suara/notifikasi; badge belum dibaca tetap jalan. Disimpan lokal
- **Typing di room**: "bob and diana are typing…" (tidak dikirim di room
  hidden/conference karena event room disiarkan ke semua app)
- **Trending** di 🔍 Rooms: jumlah pesan per room hari ini (app melapor
  `/activity` saat mengirim; room hidden/conference tidak dihitung)
- **Kartu profil hover**: arahkan kursor ke nama (chat, Friends, Members) →
  status, nama/lokasi dari profil, tombol Message/Profile/➕
- **Tema percakapan (IMVironment)**: 🎨 Theme di judul private chat →
  Beach, Starry night, Rainy day, Love, Outer space, Forest, Snowfall,
  Sunset (animasi CSS, tanpa gambar); tampil di kedua sisi, live (`/imv`)
- **Percakapan panjang**: dibuka dengan 100 pesan terakhir; memori per
  percakapan adalah *jendela geser* 1.000 pesan — Load older membuang yang
  paling baru (bar "⬇ Jump to latest" untuk kembali), pesan baru membuang
  yang paling lama, jadi scroll bisa sampai pesan pertama. History digambar
  sekali per halaman, toolbar pesan dibuat saat hover, identitas pesan
  dihitung sekali per pesan, dan reaksi/edit/expiry diambil hanya untuk
  rentang waktu pesan yang dimuat (`/msgmeta?from=&to=`). Lompat ke pesan
  (Saved/Search) memuat halaman 500 pesan tanpa menggambar tiap halaman
  (±2.500 pesan ke belakang ≈ 8 detik)
- **Zona waktu**: app mengirim zona waktu sistem (`Intl`, offset UTC) ke
  service akun saat sign in (`/tz`). Urutan "terdekat dulu" (selisih jam
  melingkar, UTC+12 vs UTC−11 = 1 jam): hasil Find People (diurutkan
  server), daftar room di 🔍 Rooms (zona room = median offset pengirim pesan
  7 hari terakhir, `/roomtz`), teman per grup (setelah status), dan Members.
  Jam lokal orang tampil di judul private chat, kartu hover, Profile, dan
  Find People ("🕑 21:13 🌙 · 12h behind"). Pesan pertama ke **bukan teman**
  yang selisihnya > 5 jam minta konfirmasi ("Send anyway"); teman tidak
  pernah dibatasi
- **Kirim nanti** (⏰ di bar format): 1 jam lagi, besok 08:00, pagi hari si
  penerima (private chat, sesuai jam aktif/08:00 waktu mereka), atau waktu
  bebas. Disimpan service akun dan dikirim tepat waktu oleh service atas nama
  pengirim (login IRC dengan token JWT satu menit), jadi tetap terkirim walau app ditutup; masuk
  history kedua pihak. Antrian tampil di atas kotak ketik (✕ untuk batal).
  Bar peringatan zona waktu juga punya tombol "Send at their 08:00"
- **Jam aktif** (👤 Profile → Active hours, waktu lokal sendiri): di luar jam
  itu nama tampil 😴 dan **siapa pun** (termasuk teman) diminta konfirmasi
  sebelum mengirim, dengan opsi kirim saat jam aktif mereka mulai
- **Link**: URL di pesan bisa diklik (dibuka di browser sistem lewat
  `tauri-plugin-opener`) dan mendapat kartu pratinjau (judul, deskripsi,
  gambar). Halaman diambil service akun dengan pengaman SSRF (hanya http/https
  port web, semua alamat hasil DNS harus publik dan koneksi ke IP yang sudah
  dicek, redirect dicek ulang, batas ukuran/waktu); gambar lewat proxy
  service sehingga IP user tidak sampai ke situs lain
- **Event di room** (📅 Events di judul room): judul + waktu (waktu lokal
  pembuat), diumumkan di room sebagai kartu dengan RSVP ✅ Going / 🤔 Maybe /
  ❌ Can't; setiap orang melihat jam dalam zona waktunya sendiri. Yang Going/
  Maybe mendapat pengingat 15 menit sebelum mulai. Pembuat bisa membatalkan
- **Kategori & bahasa room** (⚙️ Settings): filter Category/Language di
  🔍 Rooms, label di tiap baris
- **Saran teman** di Find People (saat kotak pencarian kosong): teman dari
  teman, orang yang aktif di room yang sama 14 hari terakhir, bonus zona waktu
  dekat
- **Link undangan** (🔗 Link di judul room publik): link web
  `http://…:16680/join/<room>` (halaman "Open in a09f" → `a09f://join/<room>`).
  Di dalam app, link undangan di chat jadi tombol "💬 Join …"; bisa ditempel
  di kotak Join atau Cmd/Ctrl+K. Membuka `a09f://` dari luar app
  (`tauri-plugin-deep-link`) bekerja di build yang terpasang, tidak di
  `tauri dev`
- **"👁 Seen by"** di bawah pesan terakhirmu di room (room publik saja)
- **Catatan pribadi** tentang seseorang di dialog profilnya (hanya kamu yang
  lihat), tampil juga di kartu hover
- **⬇ Export** percakapan ke `~/Downloads/a09f-<nama>-<tanggal>.json`
  (seluruh history dari Ergo, termasuk edit, hapus, dan reaksi); folder dipilih
  Rust, bukan JavaScript
- **Perangkat yang login** (🔑 Password → Signed-in devices): nama perangkat
  (OS · nama komputer), aktif terakhir, tombol Sign out (perangkat itu langsung
  keluar). Perangkat yang tidak dipakai 2 hari otomatis keluar. Untuk
  mengunci orang lain sepenuhnya tetap perlu ganti password
- **Privacy** (🔒): daftar orang yang di-ignore (pesan mereka tidak tampil di
  mana pun; klik kanan orang / ⋯ / tombol 🚫 Ignore di private chat) dan
  **Only my friends can send me private messages**: Ergo tidak punya
  caller-id, jadi app pengirim bertanya `/canpm` dulu (dan memberi tahu "X
  only accepts messages from friends"), dan app kita menyembunyikan pesan
  pribadi dari bukan-teman (kecuali orang yang pernah kita kirimi pesan) dengan
  Tip sekali. Disimpan di service akun (`/prefs`). Client IRC lain tetap bisa
  mengirim; a09f saja yang menyaring
- **Gaya teks**: tombol B / I / U dan warna di bar smiley, berlaku untuk semua
  pesan yang kamu kirim (diingat di komputer ini); dikirim sebagai kode format
  IRC standar (`\x02` `\x1d` `\x1f` `\x03NN`) dan pesan masuk berformat
  ditampilkan. ➕ membuka pilihan 36 smiley
- **Cari orang**: "Search for people…" di form Add Friend → `GET /users/search`
  (cocok sebagian ID), dengan Profile / Message / Add Friend
- **Arsip pesan**: "⬆ Load older messages" di atas percakapan
  (`CHATHISTORY BEFORE`, 100 per halaman) dan 🔍 Search di judul percakapan
  (`GET /search`: service akun mencari di history Ergo — room yang diikuti +
  private chat sendiri), bisa semua percakapan atau satu saja;
  klik hasil membuka percakapannya
- **Lupa password** (Sign In → *Forgot password?*): isi ID → kode 6 digit
  dikirim ke email pemulihan (`POST /reset/request`) → isi kode + password baru
  (`POST /reset/confirm`). Service mengganti password akun Ergo. Create account sekarang wajib mengisi email
- **Email pemulihan** (🔑 Password → Recovery email): lihat/ganti lewat
  `POST /email` (dicek dengan password sesi). Akun tanpa email mendapat Tip
  sekali setiap sign in
- **Ganti password** (🔑 Password): `POST /password` (password lama dicek
  Ergo); perangkat lain keluar
- Pesan sendiri lewat `echo-message`; jam di tiap pesan (`server-time`)
- Status **I'm Away** / **I'm Back**, tombol smiley
- Pesan teknis (MOTD, numerics, NickServ/ChanServ) disembunyikan;
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
- Akun dibuat lewat Create account (atau `server/scripts/seed-demo.sh`);
  pendaftaran lewat `/msg NickServ REGISTER` dimatikan di server.
