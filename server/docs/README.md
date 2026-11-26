# SolNet — Solanum + Atheme + Soju dalam Docker

Stack IRC lengkap yang berjalan di atas Docker Compose:

| Service  | Peran                        | Image                                   | Port host (default) |
|----------|------------------------------|-----------------------------------------|---------------------|
| solanum  | IRC daemon (server)          | `solanum-local` (build dari source)     | `6667`, `6697`      |
| atheme   | IRC services (NickServ dll)  | `s0fx2/atheme-irc-services` (pinned)    | internal only       |
| soju     | Bouncer                     | `codeberg.org/emersion/soju` (pinned)   | `16667`, `16697`    |
| postgres | Database soju (users, networks, message history) | `postgres:17-alpine` (pinned) | internal only |
| api | Service akun a09f (Go): buat akun, reset password, teman, event live, metadata pesan, room | `a09f-api` (build lokal, `server/api/`) | `16680` |
| mailpit | Penangkap email dev: email reset password dibaca di web | `axllent/mailpit` v1.27 | `16825` (web) |

Dokumen lain di folder ini: `configuration.md`, `operations.md`, `usage.md`,
`testing.md`, dan **`api.md`** (API service akun `api`: akun, teman,
event live, metadata pesan, room). App desktop: `desktop/README.md` dan
`desktop/docs/`. Semua tes: `tests/README.md`.

## Arsitektur

```
            ┌────────────────────────── docker network: ircnet (172.30.99.0/24) ──────────────────────────┐
            │                                                                                            │
  client ──►│  solanum (172.30.99.10)  ◄──TS6/charybdis──  atheme (172.30.99.20)                            │
  :6667/:6697│       ▲                                                                                    │
            │       │ upstream (NICK/USER)                                                                │
  client ──►│  soju (172.30.99.30)                                                                       │
  :16667/:16697│       │                                                                                  │
            │       └──db postgres──► postgres (172.30.99.40)                                            │
            └────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **solanum** — IRC daemon utama. Menerima client langsung di `6667` (plain)
  dan `6697` (TLS). Atheme terhubung sebagai server "services" via `6667`.
- **atheme** — services (NickServ, ChanServ, dll). Dial-out ke `solanum:6667`
  dengan password TS6. Muncul sebagai `services.int` (numeric `00A`).
- **soju** — bouncer. Client connect dengan SASL, soju meneruskan ke solanum
  sebagai nick upstream (`soluser`). Users, networks, channels dan history
  pesan disimpan di **PostgreSQL** (`message-store db`), sehingga search
  history dan retensi bisa diskalakan.

Identitas jaringan: server `irc.solanum.test` SID `10A`, network `SolNet`,
services `services.int`, bouncer `SolNet Bouncer`.

## Quickstart

```bash
cd server
cp .env.example .env            # sesuaikan password/port
./scripts/generate-certs.sh     # generate TLS cert (sekali saja)
docker compose up -d --build
docker compose ps               # semua harus (healthy)
```

Semua service `restart: unless-stopped` + healthcheck — stack otomatis
bangkit dan saling menunggu (`depends_on: service_healthy`).

## Dokumentasi

- [configuration.md](configuration.md) — `.env`, templating config, image
  pinning, healthcheck, volume
- [usage.md](usage.md) — cara connect sebagai client, perintah NickServ/ChanServ
- [operations.md](operations.md) — manajemen service, logs, persistence, troubleshooting
- [testing.md](testing.md) — test suite di `tests/` (self-contained)

## Struktur repo

```
server/
├── docker-compose.yml          # 4 service + network + volumes + healthcheck
├── .env.example                # template env (copy ke .env, gitignored)
├── scripts/generate-certs.sh   # generate TLS cert self-signed + SAN
├── solanum/
│   ├── Dockerfile              # multi-stage build, pinned commit
│   ├── entrypoint.sh           # render config + foreground + cleanup pidfile
│   └── etc/
│       ├── ircd.conf.tmpl      # template config (placeholder __VAR__)
│       ├── motd                # MOTD (mount ke /usr/local/etc/ircd.motd)
│       └── ssl-*.pem, dh.pem   # cert TLS (generated, gitignored)
├── atheme/
│   ├── entrypoint.sh           # render atheme.conf lalu delegasi ke image entrypoint
│   └── etc/
│       ├── atheme.conf.tmpl    # template config services
│       └── services.db         # database Atheme (persistent, gitignored)
├── soju/
│   ├── config                  # konfigurasi soju
│   ├── motd                    # MOTD bouncer
│   └── tls-*.pem               # cert TLS bouncer (generated, gitignored)
└── docs/                       # dokumentasi ini
```

Test suite ada di `tests/` di root repo (lihat [testing.md](testing.md)):
`tests/server/`, `tests/api/`, dan `tests/e2e/`.

Catatan: file cert/private key dan `.env` **tidak di-commit** — generate
dengan `scripts/generate-certs.sh` dan `cp .env.example .env`.
