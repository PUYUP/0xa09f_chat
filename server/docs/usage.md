# Penggunaan

## Connect langsung ke Solanum

| Cara      | Address              | Catatan                    |
|-----------|----------------------|----------------------------|
| Plain     | `irc://localhost:6667`  | atau host `127.0.0.1`    |
| TLS       | `ircs://localhost:6697` | sertifikat self-signed — client akan warning, accept/ignore |

Di client IRC (WeeChat, HexChat, irssi, The Lounge, dst) cukup set host/port di atas.
Identitas network: `irc.solanum.test` / `SolNet`.

### Services (Atheme)

Begitu connect, services langsung tersedia via private message:

```
/msg NickServ REGISTER <password> <email>     # register nick
/msg NickServ IDENTIFY <nick> <password>      # login
/msg NickServ INFO                             # status akun
/msg NickServ HELP                             # semua perintah

/msg ChanServ REGISTER #<channel> <password>   # register channel
/msg ChanServ OP #<channel>                    # ambil op via access list
/msg ChanServ HELP

/msg HostServ HELP                             # vhost (opsional)
/msg MemoServ / HelpServ                       # services lain
```

Setelah REGISTER, nick auto-login (numeric `900`). Channel yang di-`JOIN` akan
tetap ter-join untuk user itu.

### Oper (admin solanum)

Operator `admin` didefinisikan di `ircd.conf`; passwordnya adalah
`OPER_ADMIN_PASSWORD` di `.env` (di-hash sha512-crypt saat container
start — plaintext/hash tidak ada di repo). Login di client dengan
`/OPER admin <OPER_ADMIN_PASSWORD>`.

## Connect via Soju bouncer

Soju butuh **autentikasi SASL** — client tanpa SASL akan ditolak `464`.

| Cara      | Address                |
|-----------|------------------------|
| Plain     | `irc://localhost:16667`  |
| TLS       | `ircs://localhost:16697` |

### Login bouncer

Di client, aktifkan SASL (mechanism `PLAIN`) dengan:

- **username**: `pointilis` (user bouncer)
- **password**: password yang dipakai saat `sojuctl user create`

Setelah login, soju menampilkan MOTD bouncer. Untuk memilih network upstream,
sesuaikan **username** menjadi `<user>/<network>`:

```
NICK pointilis/solanum
USER pointilis/solanum ...
```

Atau pakai ekstensi `soju.im/bouncer-networks` (client modern seperti WeeChat /
The Lounge mendukungnya — network bisa dipilih dari UI).

Contoh WeeChat:

```
/set irc.server_tls_verify 0          # abaikan cert self-signed
/connect solnet irc+insecure://localhost/16667 -n pointilis/solanum
```

lalu `/sasl add solnet plain pointilis <password>` (urutan tergantung versi).

### Perilaku bouncer

- Channel yang di-join **otomatis di-join ulang** setiap reconnect upstream.
- Pesan yang masuk saat offline disimpan (`message-store db`) dan dikirim
  sebagai backlog saat client connect lagi.
- `PART #chan detach` melepaskan channel tanpa meninggalkan di upstream.
- NickServ/ChanServ dipakai **di dalam network** (setelah bind), sama seperti
  connect langsung — mis. `/msg NickServ IDENTIFY soluser <password>` untuk
  mendaftarkan nick upstream `soluser`.
- `/msg NickServ` di koneksi bouncer (tanpa `/network`) → error; harus pakai
  network-specific session.

## Port cheat sheet

```
6667   solanum plain        → client langsung, upstream soju
6697   solanum TLS          → client langsung TLS
16667  soju plain           → client via bouncer
16697  soju TLS             → client via bouncer TLS
```

Semua bind `0.0.0.0` — bisa diakses dari LAN selama port tidak diblok firewall.
