# Panduan fitur a09f

Panduan pemakaian app desktop a09f, per area. Detail teknis tiap fitur ada di
`desktop/README.md`, cara kerjanya di `desktop/docs/arsitektur.md`, dan API
server di `server/docs/api.md`.

## Akun

- **Create account**: pilih ID (3–16 huruf/angka, diawali huruf), email,
  password (≥ 8 karakter, tanpa spasi). Setelah dibuat langsung sign in.
- **Sign In**: ID + password. Pilihan di bawahnya:
  - *Remember my ID & password* — password disimpan di keychain sistem
    (Keychain macOS / Credential Manager Windows), tidak di file.
  - *Sign me in automatically* — saat app dibuka.
  - *Start a09f when my computer starts* — mulai tersembunyi di tray.
- **Forgot password?** — isi ID, kode 6 digit dikirim ke email pemulihan,
  isi kode + password baru. Semua perangkat yang sedang login akan keluar.
- **🔑 Password** (toolbar):
  - ganti password (perangkat lain otomatis keluar);
  - email pemulihan;
  - **Signed-in devices**: perangkat yang login, kapan terakhir aktif, tombol
    *Sign out* untuk mengeluarkannya. Perangkat yang tidak dipakai 2 hari
    keluar sendiri.
- **Menutup jendela** tidak sign out: a09f tetap jalan di tray (pesan, BUZZ,
  notifikasi tetap masuk). Ikon tray: klik = buka; menu Open / Sign Out / Quit.

## Status & profil

- **Status** (kanan atas): Available 🟢, Busy 🔴, Be Right Back / Stepped Out
  🟠, pesan custom (warna biru-abu: tidak menunjukkan ada/tidak), dan
  **👻 Invisible** — semua orang melihatmu Offline, kamu tetap bisa chat.
- **👤 Profile**: nama, lokasi, tentang saya (terlihat semua orang), **warna
  nama** (12 pilihan), **jam aktif** (di luar jam itu namamu bertanda 😴 dan
  orang diminta konfirmasi sebelum mengirim pesan).
- Profil orang lain: 👤 di samping nama, atau arahkan kursor ke nama (kartu
  singkat). Di profil orang lain ada **📝 catatan pribadi** yang hanya kamu
  lihat.
- **Jam lokal** orang tampil di judul chat, profil, dan kartu hover
  ("🕑 21:13 🌙 · 12h behind").

## Teman

- **👥 Add Friend**: ID, grup, pesan singkat → **friend request**. Penerima
  melihat kartu *Accept / Decline*.
- **Find People** (tautan di form Add Friend): cari sebagian ID; hasil
  diurutkan dari zona waktu terdekat. Kalau kotak kosong: **People you may
  know** (teman dari teman, aktif di room yang sama).
- Daftar teman dikelompokkan per **grup**; **⋯** di teman: kirim pesan,
  profil, pindah grup, ignore, hapus. **⋯** di grup: rename.
- **Menghapus teman** memutus pertemanan dari dua sisi.
- Teman offline: "Offline · seen 2h ago".

## Private chat

- Klik nama teman. Di judul: 👤 Profile, 🎨 **Theme** (latar beranimasi yang
  terlihat kedua pihak: pantai, malam, hujan, love, luar angkasa, hutan, salju,
  senja), 🚫 Ignore, 🔍 Search, ⬇ Export.
- **"bob is typing…"**, **✓ Seen** di bawah pesan terakhirmu.
- **BUZZ!** menggetarkan jendela lawan bicara.
- **Auto-reply**: mengirim ke orang yang Busy/away/offline/custom memunculkan
  status mereka sekali.
- **Zona waktu jauh**: pesan pertama ke orang yang **bukan teman** dengan
  selisih > 5 jam, atau ke siapa pun di luar jam aktifnya, minta konfirmasi:
  *Send anyway* atau *Send at their 08:00*.

## Menulis pesan

Bar di atas kotak ketik:

| Tombol | Fungsi |
|---|---|
| 🙂 … ➕ | smiley (➕ = 36 pilihan) |
| ⏳ | **pesan menghilang**: 1 menit / 1 jam / 1 hari setelah dikirim, untuk semua orang |
| ⏰ | **kirim nanti**: 1 jam lagi, besok 08:00, pagi hari si penerima, atau waktu bebas; tetap terkirim walau app ditutup |
| ✨ /me | aksi ("* alice waves") |
| **B** *I* U, kotak warna | gaya teks untuk semua yang kamu kirim |
| BUZZ! | (private chat) |

Perintah: `/me …`, `/join room`, `/poll Pertanyaan | A | B`,
`/remind 10m minum air` (m/h/d), `/msg id teks`.

Ketik `@` di room untuk menyebut seseorang (daftar anggota muncul).
URL bisa diklik dan mendapat kartu pratinjau. Link undangan room menjadi
tombol **💬 Join**.

## Aksi di pesan

Arahkan kursor ke pesan:

- 😀 **reaksi** (👍 ❤️ 😂 😮 😢 🙏 🎉 🔥) — chip jumlah di bawah pesan
- ↩ **reply** — pesan dikirim dengan kutipan
- ⭐ **simpan** — daftar di ⭐ Saved; klik item untuk lompat ke pesannya
- ✏️ **edit** (pesanmu) — "(edited)"
- 📌 **pin** (moderator) — bar di atas room
- 🗑 **hapus** (pesanmu) — dua klik; hilang untuk semua

## Room

- **🔍 Rooms**: semua room publik, dengan 🔥 trending hari ini, kategori &
  bahasa (bisa difilter), jumlah orang, dan zona waktu ("🕑 +2h"); urut dari
  zona waktu terdekat.
- **Join / Create**: nama room yang sudah ada → langsung masuk. Room baru →
  dialog **Create Room** (topik, private, hidden, password, batas orang, pesan
  sambutan) — room baru dibuat setelah dikonfirmasi dan menjadi milikmu.
- Judul room: ✏️ Topic, ➕ Invite, ⚙️ Settings (moderator), 📅 Events,
  🔗 Link (undangan), 🚪 Leave, 🔍 Search, ⬇ Export. Di jendela sempit hanya
  ikon yang tampil.
- **Moderasi** (klik kanan nama di Members): jadikan moderator, mute, keluarkan,
  ban. **⚙️ Settings**: private/hidden/announcement, password, batas orang,
  kategori & bahasa, pesan sambutan, daftar moderator/muted/banned, beri room
  ke orang lain, hapus room.
- **Room private**: orang lain bisa **🚪 Ask to join**; moderator mendapat
  tombol *Let them in*.
- **📅 Events**: judul + waktu; setiap orang melihat jam dalam zona waktunya
  sendiri; RSVP ✅/🤔/❌; pengingat 15 menit sebelum mulai.
- **👁 Seen by** di bawah pesan terakhirmu.
- Daftar Chat Rooms diurutkan dari pesan terbaru.

## Conference

**🗣️ Conference** (toolbar): pilih teman / ketik ID (boleh beberapa, dipisah
koma) → room rahasia khusus undangan. Hilang sendiri setelah semua keluar.

## Riwayat & pencarian

- Percakapan dibuka dengan 100 pesan terakhir; **⬆ Load older messages** di
  atas untuk mundur sampai pesan pertama. Kalau sudah jauh ke belakang, bar
  **⬇ Jump to latest** membawa kembali ke yang terbaru.
- **🔍 Search** (judul percakapan): cari di satu percakapan atau semua; klik
  hasil untuk lompat ke pesannya.
- **⬇ Export**: seluruh percakapan disimpan sebagai JSON di folder Downloads.

## Kenyamanan

- **Cmd/Ctrl+K**: pindah cepat ke room, teman, atau chat.
- **🌙 / ☀️** (header): mode gelap.
- **Sound** (toolbar): bisukan suara, **Do Not Disturb** 1 jam / sampai
  besok 08:00, **jam tenang** (default 22:00–07:00).
- **🔒 Privacy**: *Only my friends can send me private messages*, dan daftar
  orang yang di-ignore.
- **📢 Announce** (hanya admin): pengumuman ke semua orang (banner kuning).
- Header menampilkan jumlah orang yang sedang online.
