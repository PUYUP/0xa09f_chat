# Penggunaan

Orang biasa memakai app desktop a09f. Untuk debugging, client IRC biasa
juga bisa tersambung — semua harus login dengan akun a09f (SASL).

## Connect

| | Alamat |
|---|---|
| IRC plain | `127.0.0.1:16667` |
| IRC TLS (self-signed) | `127.0.0.1:16697` |
| Service akun (HTTP) | `http://127.0.0.1:16680` |
| Mailpit (web) | `http://127.0.0.1:16825` |

Login: SASL PLAIN, username = ID a09f, password = password a09f. Nick harus
sama dengan ID (Ergo memaksakan ini). Tanpa SASL koneksi ditolak.

```
CAP LS 302
CAP REQ :sasl server-time message-tags batch echo-message away-notify draft/chathistory
NICK alice
USER alice 0 * :alice
AUTHENTICATE PLAIN
AUTHENTICATE <base64 "alice\0alice\0password">
CAP END
```

Karena akun always-on, client ini menjadi satu "perangkat" lagi dari akun
itu: room yang diikuti langsung tampil, history lewat `CHATHISTORY`.

## Services

| Perintah | Fungsi |
|---|---|
| `/msg ChanServ REGISTER #room` | room jadi milikmu (harus op di room) |
| `/msg ChanServ INFO #room` | founder, tanggal daftar |
| `/msg ChanServ AMODE #room +o <id>` | moderator tetap |
| `/msg ChanServ TRANSFER #room <id>` | beri room (penerima `TRANSFER ACCEPT #room`) |
| `/msg ChanServ UNREGISTER #room` | lepas kepemilikan (minta kode konfirmasi) |
| `/msg NickServ INFO <id>` | info akun |

Mute: `MODE #room +b m:<id>!*@*`. Ban: `MODE #room +b <id>!*@*`.

Pendaftaran akun (`NickServ REGISTER`) dimatikan — buat akun lewat app.
