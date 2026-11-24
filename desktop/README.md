# SolNet Desktop

Client desktop IRC untuk stack `server/` (Solanum + Atheme + Soju) —
dibangun dengan Tauri (Rust backend + vanilla JS frontend).

## Fitur (v0.1)

- Connect ke bouncer Soju via SASL PLAIN (`127.0.0.1:16667`)
- Registrasi NickServ (`REGISTER <password> <email>`)
- Buat/masuk channel (`JOIN` — auto-create di solanum)
- Daftar user aktif per channel (NAMES + JOIN/PART/QUIT/NICK tracking)
- Kirim pesan channel & private (`@nick` di composer atau `/msg nick text`)
- Set/clear status away (`AWAY`)
- `/join #chan`, `/part #chan` slash commands di composer

## Menjalankan

```bash
cd desktop
npm install
npm run dev        # tauri dev (window + hot reload frontend)
# atau build binary:
npm run build      # → src-tauri/target/release/bundle/macos/SolNet.app
```

Binary debug juga bisa langsung: `src-tauri/target/debug/solnet-desktop`
(setelah `cargo build` di `src-tauri/`).

## Cara kerja

- `src-tauri/src/lib.rs` — jembatan TCP tipis: command `connect`/`send`/
  `disconnect`, event `irc-line`/`irc-closed`. Tidak ada logika IRC di Rust.
- `ui/app.js` — seluruh protokol IRC: SASL PLAIN auth, parsing numerics,
  tracking channel/member, render UI.

## Batasan yang diketahui

- **Plaintext only** — connect ke `16667`. TLS `16697` butuh cert
  self-signed ditangani webview (belum diimplementasi).
- **Upstream nick shared** — semua user bouncer `pointilis` muncul di IRC
  sebagai `soluser`. NickServ REGISTER akan teregistrasi untuk `soluser`
  (bukan per-user). Identitas per-user butuh konfigurasi network per-user
  via `sojuctl` — pekerjaan berikutnya.
- Credentials bouncer di UI (default dev `pointilis`/`change-me`) —
  ganti sesuai `.env` server.
