# Testing

Dua test suite Python (stdlib saja, tanpa dependency) di `tests/`. Keduanya
cetak tiap baris IRC `>>`/`<<` dan `[PASS]` per langkah; exit non-zero (traceback)
jika timeout.

## test_solanum.py

Connect **langsung** ke Solanum di port `6667`, negosiasi `echo-message`,
register nick via NickServ (Atheme), identify, join channel, kirim pesan.

```bash
python3 tests/test_solanum.py            # default 127.0.0.1:6667
python3 tests/test_solanum.py <host> <port>
```

Yang diverifikasi:

1. `001` welcome + MOTD (`372`/`376`) — membuktikan solanum jalan dan MOTD termuat
2. `CAP LS`/`ACK echo-message` — IRCv3 caps
3. `NickServ REGISTER` → balasan services (Atheme link hidup)
4. `NickServ IDENTIFY` → `900 You are now logged in`
5. `JOIN #testchan` → echo JOIN
6. `PRIVMSG` → echo pesan sendiri (membuktikan `echo-message` aktif)

Catatan: nick `soltest2` didaftarkan sekali dan tetap ada di `services.db` —
run berikutnya dapat "already registered" lalu auto-identify, tetap PASS.

## test_soju.py

Connect ke **Soju** di port `16667`, SASL PLAIN sebagai user bouncer
`pointilis`, bind network `pointilis/solanum`, join channel lewat upstream
solanum, query NickServ.

```bash
python3 tests/test_soju.py             # default 127.0.0.1:16667
python3 tests/test_soju.py <host> <port>
```

Yang diverifikasi:

1. `CAP LS` → `sasl=PLAIN` + `soju.im/*` caps (bouncer, bukan solanum langsung)
2. `AUTHENTICATE PLAIN` → `903` (auth internal soju)
3. `001` welcome sebagai `soluser` di network `irc.solanum.test`
4. `JOIN #testchan` → numeric upstream solanum (`005` dengan CHANMODES dst)
5. `PRIVMSG` → `PING soju-msgid-*` (soju membungkus pesan)
6. `NickServ INFO` → services AtHEME reachable lewat bouncer

## Menjalankan keduanya

```bash
cd /Volumes/SSD1/Private/0xa09f/irc
python3 tests/test_solanum.py && python3 tests/test_soju.py
```

Pre-requisite untuk `test_soju.py`: user `pointilis` + network `solanum` sudah
dibuat via `sojuctl` (lihat configuration.md). Kalau database soju di-reset,
buat ulang dulu.

## Tips debugging test

- Output verbose by design — baris `<<` menunjukkan numeric mentah, berguna
  untuk lihat di mana flow macet.
- `400 JOIN :Disconnected from upstream network` di test_soju → soju baru
  restart / upstream belum reconnect. Tunggu ~1 menit (backoff soju) lalu ulang.
- `464 Authentication required` → SASL belum dikirim / password salah.
- Kode test ada di `tests/` — silakan edit konstanta (NICK, CHANNEL,
  password) sesuai kebutuhan.
