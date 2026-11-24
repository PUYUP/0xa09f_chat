# SolNet — Solanum + Atheme + Soju dalam Docker

Stack IRC lengkap yang berjalan di atas Docker Compose:

| Service  | Peran                        | Image                                   | Port host         |
|----------|------------------------------|-----------------------------------------|-------------------|
| solanum  | IRC daemon (server)          | `solanum-local` (build dari source)     | `6667`, `6697`    |
| atheme   | IRC services (NickServ dll)  | `s0fx2/atheme-irc-services:latest`      | internal only     |
| soju     | Bouncer                     | `codeberg.org/emersion/soju:latest`     | `16667`, `16697`  |

## Arsitektur

```
            ┌────────────────────────── docker network: ircnet (172.30.99.0/24) ──────────────────────────┐
            │                                                                                            │
  client ──►│  solanum (172.30.99.10)  ◄──TS6/charybdis──  atheme (172.30.99.20)                            │
  :6667/:6697│       ▲                                                                                    │
            │       │ upstream (NICK/USER)                                                                │
  client ──►│  soju (172.30.99.30)                                                                       │
  :16667/:16697└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **solanum** — IRC daemon utama. Menerima client langsung di `6667` (plain) dan `6697` (TLS). Atheme
  terhubung sebagai server "services" via port `6667` di jaringan internal.
- **atheme** — services (NickServ, ChanServ, dll). Dial-out ke `solanum:6667` dengan password TS6.
  Muncul di jaringan sebagai `services.int` (numeric `00A`).
- **soju** — bouncer. Client connect dengan SASL, soju meneruskan ke solanum sebagai nick upstream
  (`soluser`). Menyimpan riwayat pesan di SQLite.

Identitas jaringan:

- Server IRC: `irc.solanum.test`, SID `10A`, nama network `SolNet`
- Services: `services.int`
- Bouncer: hostname iklan `irc.solanum.test`, judul `SolNet Bouncer`

## Quickstart

```bash
docker compose up -d --build    # build solanum + start semua service
docker compose ps               # cek status
docker compose logs -f solanum  # tail log
```

Semua service `restart: unless-stopped` — stack otomatis bangkit setelah Docker restart.

## Dokumentasi

- [configuration.md](configuration.md) — penjelasan tiap file konfigurasi
- [usage.md](usage.md) — cara connect sebagai client, perintah NickServ/ChanServ
- [operations.md](operations.md) — manajemen service, logs, persistence, troubleshooting
- [testing.md](testing.md) — test suite di `tests/`

## Struktur repo

```
.
├── docker-compose.yml          # definisi 3 service + network + volumes
├── solanum/
│   ├── Dockerfile              # build solanum dari source (Debian bookworm-slim)
│   ├── entrypoint.sh           # foreground mode + cleanup pidfile
│   └── etc/
│       ├── ircd.conf           # konfigurasi solanum
│       ├── motd                # MOTD (di-mount ke /usr/local/etc/ircd.motd)
│       ├── ssl-cert.pem        # sertifikat TLS self-signed
│       ├── ssl-key.pem
│       └── dh.pem              # DH parameters
├── atheme/etc/
│   ├── atheme.conf             # konfigurasi services
│   └── services.db             # database Atheme (persistent)
├── soju/
│   ├── config                  # konfigurasi soju
│   ├── motd                    # MOTD bouncer
│   ├── tls-cert.pem            # sertifikat TLS bouncer
│   └── tls-key.pem
├── tests/
│   ├── test_solanum.py         # test koneksi langsung ke solanum
│   └── test_soju.py            # test bouncer + upstream
└── docs/                       # dokumentasi ini
```
