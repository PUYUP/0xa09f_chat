# Testing

Tiga test suite Python (stdlib saja) di `tests/`. Keduanya cetak tiap baris
IRC `>>`/`<<` dan `[PASS]` per langkah; exit non-zero (traceback) jika timeout.

Semua test **self-contained** — bisa dijalankan berulang kali dan setelah
volume di-reset, tanpa setup manual.

## test_solanum.py

Connect langsung ke Solanum (default `127.0.0.1:6667`).

```bash
python3 tests/test_solanum.py             # plain :6667
python3 tests/test_solanum.py --tls       # TLS :6697
python3 tests/test_solanum.py <host> <port>
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

## test_soju.py

Connect ke Soju (default `127.0.0.1:16667`).

```bash
python3 tests/test_soju.py              # plain :16667
python3 tests/test_soju.py --tls        # TLS :16697
python3 tests/test_soju.py <host> <port>
```

Self-contained setup (idempotent, via `docker exec soju sojuctl`):

1. `user status pointilis` → kalau belum ada, `user create`; kalau ada,
   `user update -password` (sinkron dengan `.env` `SOJU_PASSWORD`).
2. `network status` → kalau network `SOJU_NETWORK` belum ada,
   `network create -addr irc+insecure://solanum:6667`.

Kredensial dibaca dari `server/.env` (`SOJU_USER`, `SOJU_PASSWORD`,
`SOJU_NETWORK`) dengan fallback default.

Yang diverifikasi:

1. `CAP LS` → `sasl=PLAIN` + cap `soju.im/*`
2. `AUTHENTICATE PLAIN` → `903`
3. `001` welcome sebagai `soluser` di `irc.solanum.test`
4. `JOIN #testchan` → numeric upstream solanum
5. `PRIVMSG` → `PING soju-msgid-*`
6. `NickServ INFO` → services reachable lewat bouncer

## test_tls.py

Handshake TLS smoke test untuk kedua listener TLS.

```bash
python3 tests/test_tls.py              # 127.0.0.1:6697 + :16697
python3 tests/test_tls.py <host> <solanum_port> <soju_port>
```

Memverifikasi handshake + server merespons setelah `NICK`/`USER`
(solanum kirim `NOTICE *** Checking Ident`, soju kirim `464`).

Catatan: cert self-signed → `CERT_NONE`. SNI dikirim sebagai IP literal
(`127.0.0.1`) — **jangan** pakai `irc.solanum.test` sebagai SNI ke solanum:
ssld solanum menolak handshake dengan alert `access_denied` untuk SNI
t tersebut (quirk upstream; client IRC pada umumnya tidak mengirim SNI).

## Menjalankan semua

```bash
cd server
python3 tests/test_solanum.py && python3 tests/test_solanum.py --tls
python3 tests/test_soju.py && python3 tests/test_soju.py --tls
python3 tests/test_tls.py
```

## Catatan flaky

- `400 JOIN :Disconnected from upstream network` di test_soju → soju baru
  restart / upstream belum reconnect (backoff ~1 menit). Tunggu lalu ulang.
- Burst koneksi TLS beruntun bisa ke-throttle solanum
  (`throttle_duration = 60`, `throttle_count = 4` di `general{}`) →
  handshake ditolak `access_denied` sementara. Tunggu ±1 menit.
- Test butuh container jalan: `docker compose up -d` dulu.
