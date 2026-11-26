# Tes a09f

**Semua tes ada di folder ini.** Tes baru juga ditaruh di sini: bukan di
folder sementara, bukan di samping kode. Python hanya stdlib.

| Folder | Isi | Butuh |
|---|---|---|
| `server/` | smoke test stack IRC: solanum, soju, TLS | stack docker |
| `api/` | service akun (`server/api`, Go) dan fitur IRC yang dipakai app, lewat HTTP dan koneksi IRC sungguhan | stack docker, akun demo |
| `e2e/` | skenario yang dijalankan **di dalam app desktop asli** (build debug), dengan skrip "peer" sebagai orang lain | stack docker, akun demo, toolchain Rust/Tauri, sesi desktop |
| `visual/` | UI asli dirender di Chrome headless dengan API Tauri palsu → screenshot | Google Chrome |
| `lib/` | pembantu bersama: `a09f.py` (klien IRC lewat soju, klien service akun, SSE, laporan cek), `peer.py` (peer e2e) | — |

Jalankan semua: `tests/run_all.sh` (atau satu grup: `tests/run_all.sh api`).
Setiap skrip mencetak baris `[PASS]` / `[FAIL]` / `[SKIP]` dan keluar dengan
kode bukan nol kalau ada yang gagal.

## Sebelum menjalankan

- Stack `server/` hidup: `cd server && docker compose up -d`.
- Akun demo alice, bob, charlie, diana, evan, frank, grace, henry, irene, jack,
  kate, leo, mia, nina, oscar dengan password `demo-1234`, masing-masing sudah
  pernah sign in lewat app atau terdaftar di NickServ (tes moderasi memakai
  extban akun). Password bisa diganti lewat `A09F_DEMO_PASSWORD`.
- `server/.env` berisi `SOJU_PASSWORD` untuk `server/test_soju.py`.

## server/

```bash
python3 tests/server/test_solanum.py [--tls]
python3 tests/server/test_soju.py [--tls]
python3 tests/server/test_tls.py
```

Rincian yang dicek: `server/docs/testing.md`.

## api/

```bash
python3 tests/api/test_account.py        # registrasi, email pemulihan, reset lewat email (Mailpit), batas login
python3 tests/api/test_friends.py        # request, grup, privasi, typing, perangkat + event live
python3 tests/api/test_messages.py       # hapus, reaksi, edit, pin, polling, pesan menghilang, saved, kirim nanti
python3 tests/api/test_rooms_people.py   # event/RSVP, kategori, trending, zona waktu room, saran teman, seen-by, catatan
python3 tests/api/test_preview.py        # pratinjau link + pengaman SSRF (butuh internet)
python3 tests/api/test_irc_features.py   # +g/ACCEPT, extban $a:, KNOCK, ChanServ, CHATHISTORY, SEARCH, network quote
```

### tests/api/bench_load.py — benchmark user aktif

Bukan cek lulus/gagal untuk CI, tapi pengukur beban: membuka `--users` app
dengan pola app sungguhan (`POST /session`, `GET /events`, lalu `/typing`,
`/read`, `/activity` tiap `--think` detik), menahan semua stream selama
`--window`, lalu memeriksa event asli sampai ke app dan semuanya tertutup
bersih. Tidak mengubah kode server; hanya memakai endpoint yang ada.

```bash
python3 tests/api/bench_load.py                           # 5.000 user, 60 dtk
python3 tests/api/bench_load.py --users 1500 --window 30
python3 tests/api/bench_load.py --mode real --users 100    # password via SASL
```

Akun memakai ID tetap `b1`…`bN`, password `A09F_BENCH_PASSWORD` (default
`demo-1234`), dan dibuat sekali lewat `POST /register` — yang hanya
mengizinkan 5 akun/jam per IP (`MAX_CREATES_PER_HOUR`), jadi run pertama untuk
5.000 akun perlu jatah itu dinaikkan atau dijalankan bertahap. Satu `/events`
= satu thread yang memblok dan macOS membatasi thread per user (`ulimit -u`),
jadi user dipecah ke beberapa proses (`--conns` per proses, `--procs` proses).

Hasil pada mesin 4 core / 16 GB, stack docker lokal, Python 3.9:

| Metrik | Nilai |
|---|---|
| `POST /session` (cek password SASL ke soju) | p50 111 ms, max 180 ms |
| `GET /friends` + `POST /typing` tanpa beban | p50 3,0 ms, p99 17 ms |
| 300 stream `/events` hidup bersamaan | 300/300; `POST /typing` p50 2,4 ms |
| Laju buka sesi + stream dari satu proses Python | ±8 app/detik |
| Pembuka yang menentukan batas | thread per user di klien, `max_connections` Postgres (200), pool `api` (32) |

Catatan:
- `test_account.py` membuat satu akun (service register mengizinkan 5 per IP
  per jam; restart container `api` untuk mereset hitungannya).
- `test_irc_features.py` bisa SKIP cek KNOCK: solanum hanya mengizinkan satu
  knock per user setiap beberapa menit (`knock_delay`).
- Tes membersihkan apa yang dibuatnya (room di-DROP lewat ChanServ, baris di
  Postgres service akun dihapus; `A09F_PSQL` untuk postgres di luar docker). Run yang terputus bisa meninggalkan room
  `#zz-test-*`; run berikutnya menghapusnya.

## e2e/

```bash
python3 tests/e2e/run.py                    # semua skenario (build app debug dulu)
python3 tests/e2e/run.py rooms friends      # sebagian
python3 tests/e2e/run.py --no-build rooms   # pakai build terakhir
```

Cara kerjanya — tidak ada file source yang diubah:

- Build debug app punya dua pengait tes (`desktop/src-tauri/src/lib.rs`,
  `#[cfg(debug_assertions)]`, tidak ada di build rilis): `test_scenario`
  memberi UI skrip yang ditunjuk `$A09F_TEST_SCENARIO`, dan `test_log`
  mencetak `A09F-TEST {json}` ke stderr.
- `run.py` menggabungkan `prelude.js` + `scenarios/<nama>.js`, menjalankan
  `scenarios/<nama>.peer.py` (kalau ada), membuka app, lalu membaca hasilnya.
  Jendela app dibawa ke depan, karena WebKit memperlambat timer di jendela
  yang tersembunyi.
- Skenario mengendalikan UI dan membaca state app langsung (`S`, `conv()`, …).
  Pembantu dari `prelude.js`: `check`, `skip`, `note`, `until`, `wait`,
  `signIn(user)`, `peer(cmd, to)`, `ask(cmd, to)`, `finish()`.
- Peer (`tests/lib/peer.py`) menerima `cmd:<nama> <argumen>` sebagai private
  message dari alice dan membalas `re:<teks>`. Pakai
  `Peer(user, control="bob")` kalau mengirim pesan ke `user` akan mengubah
  tes (daftar ACCEPT user +g otomatis bertambah dengan siapa pun yang dia
  kirimi pesan).

| Skenario | Cakupan |
|---|---|
| `friends` | kartu request → accept, typing, status live, invisible (pre-away), hapus teman dua arah |
| `messaging` | gaya teks, /me, reply, edit, reaksi dari peer, hapus, pratinjau link, Seen, search, saved + lompat |
| `rooms` | dialog Create Room + MLOCK, pengaturan pemilik, moderator/mute/ban, pesan sambutan, polling, pin, event, Seen by, link undangan, hapus room |
| `privacy_time` | hanya-teman (+g, sinkron ACCEPT), ignore, konfirmasi zona waktu jauh, kirim nanti, jam aktif |
| `long_history` | 2.500 pesan: 100 pertama, jendela 1.000, Jump to latest, pesan pertama, lompat jauh |
| `app_settings` | mode gelap, Cmd+K, Do Not Disturb, profil, warna nama, email pemulihan, perangkat, ekspor JSON |

Tips: skenario yang lambat atau kadang gagal biasanya sedang menunggu soju
menahan laju baris app setelah sign in. `signIn()` sudah menunggu antrian itu
habis. Bandingkan jawaban peer hanya setelah perintah dikirim (`ask` sudah
melakukannya). Sign in sebagai alice di jendela lain saat tes berjalan
(misalnya jendela demo) bisa membuat cek invisible menjadi SKIP.

## visual/

```bash
python3 tests/visual/run.py           # screenshot semua demo -> tests/visual/out/
python3 tests/visual/run.py themes    # satu demo (semua variannya)
```

Demo (`visual/demos/<nama>.js`) menyiapkan state UI; baris `// size: WxH` dan
`// variants: a b c` (satu screenshot per varian, diberikan sebagai
`location.hash`). Error JavaScript membuat demo gagal. Screenshot dilihat
manual, tidak dibandingkan otomatis. `out/` di-ignore git.
