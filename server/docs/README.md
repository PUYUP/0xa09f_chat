# Server a09f — Ergo + service akun (Go) dalam Docker

| Service  | Peran | Image | Port host (default) |
|----------|-------|-------|---------------------|
| ergo     | Server IRC: akun (NickServ), room (ChanServ), klien *always-on*, history | `ghcr.io/ergochat/ergo:v2.19.1` | `16667` (plain), `16697` (TLS) |
| postgres | History pesan Ergo (`ergo_history`) + data service akun (`a09f`) | `postgres:17-alpine` (pinned) | internal |
| api      | Service akun (Go, `server/api`): buat akun, reset password, teman, event live, metadata pesan, room, pencarian | `a09f-api` (build lokal) | `16680` |
| mailpit  | Penangkap email dev (email reset password) | `axllent/mailpit` v1.27 | `16825` (web) |

Dokumen lain: [configuration.md](configuration.md), [operations.md](operations.md),
[usage.md](usage.md), [testing.md](testing.md), dan **[api.md](api.md)**.
App desktop: `desktop/README.md`, `desktop/docs/`. Tes: `tests/README.md`.

## Arsitektur

```
             docker network a09f (172.30.98.0/24)
 app ──IRC──► ergo (.10) ──history──► postgres (.40) ◄── api (.50) ◄──HTTP+SSE── app
 :16667/:16697   ▲                     ergo_history       a09f DB      :16680
                 └──── HTTP API :8089 (internal) + IRC (JWT) ────┘
```

- **Ergo** satu proses menggantikan solanum (server) + Atheme (services) +
  soju (bouncer). Setiap akun adalah klien **always-on**: tetap ada di
  jaringan tanpa perangkat tersambung (pesan offline, history, room tetap),
  dan otomatis *away* (= "Offline" di app). Tanpa koneksi TCP per akun:
  akun yang tidak aktif hanya state di memori.
- History disimpan **sekali per room** (bukan per anggota) di PostgreSQL.
- **api** (Go) bicara dengan Ergo lewat HTTP API Ergo (buat akun, cek
  password, ganti password, daftar akun, whois) dan, untuk bertindak atas
  nama user (kirim nanti, sign-in pertama akun baru), lewat IRC dengan token
  JWT satu menit (SASL `IRCV3BEARER`) — tanpa menyimpan password. Event live
  untuk app lewat SSE (satu goroutine per app yang terbuka).

## Quickstart

```bash
cd server
./scripts/init-env.sh           # .env dari .env.example + secret acak (tidak dicetak)
docker compose up -d --build
docker compose ps               # semua (healthy)
./scripts/seed-demo.sh          # #lobby, #a09f-presence, akun demo (demo-1234)
```

Akun dibuat lewat app (Create account) atau `seed-demo.sh`; pendaftaran
langsung lewat IRC dimatikan.

## Struktur

```
server/
├── docker-compose.yml       # ergo, postgres, api, mailpit
├── .env.example             # template (.env gitignored)
├── ergo/ircd.yaml           # config Ergo (perubahan dari default ditandai "a09f:")
├── ergo/motd
├── postgres/initdb/         # role + database ergo & a09f (volume baru)
├── api/                     # service akun (Go)
├── scripts/init-env.sh      # isi secret yang belum ada
├── scripts/seed-demo.sh     # room bawaan + akun demo
└── docs/
```
