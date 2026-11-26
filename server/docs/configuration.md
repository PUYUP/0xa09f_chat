# Konfigurasi

## `.env`

```bash
cd server
./scripts/init-env.sh     # copy .env.example → .env, isi secret yang kosong (openssl rand), chmod 600
```

Script tidak pernah mencetak secret dan aman dijalankan ulang (hanya mengisi
yang masih kosong). Isi `.env`:

| Variabel | Untuk |
|---|---|
| `POSTGRES_PASSWORD` | superuser postgres |
| `ERGO_DB_PASSWORD` | role `ergo` (history Ergo) |
| `A09F_DB_PASSWORD` | role `a09f` (data service akun; boleh *membaca* history untuk pencarian) |
| `ERGO_API_TOKEN` | bearer token api → HTTP API Ergo (`:8089`, hanya di jaringan docker) |
| `JWT_KEY` | kunci HMAC: api menandatangani token login satu menit untuk bertindak atas nama user |
| `IRC_PORT`, `IRC_TLS_PORT`, `API_PORT`, `MAILPIT_PORT`, `BIND_ADDR` | port host |
| `SMTP_*`, `MAIL_FROM` | email reset password (kosong = Mailpit) |
| `ADMIN_USERS` | ID yang boleh 📢 Announce |

Role dan database dibuat oleh `postgres/initdb/01-roles.sh` **hanya saat volume
postgres masih kosong**. Mengganti `ERGO_DB_PASSWORD`/`A09F_DB_PASSWORD`
setelahnya juga perlu `ALTER ROLE … PASSWORD` di postgres.

## `ergo/ircd.yaml`

Berbasis `default.yaml` Ergo 2.19.1; setiap perubahan ditandai `a09f:`.
Secret tidak ada di file ini: masuk lewat *environment override* Ergo
(`ERGO__API__BEARER_TOKENS`, `ERGO__ACCOUNTS__JWT_AUTH__TOKENS`,
`ERGO__DATASTORE__POSTGRESQL__PASSWORD`) yang diisi `docker-compose.yml` dari `.env`.

Yang penting:

| Bagian | Nilai | Kenapa |
|---|---|---|
| `accounts.registration.enabled` | `false` | akun hanya dibuat service akun (`/v1/ns/saregister`) |
| `accounts.require-sasl.enabled` | `true` | semua orang di jaringan punya akun a09f |
| `nick-reservation.force-nick-equals-account` | `true` (default) | ID = nick = akun; ban `<id>!*@*` = ban akun |
| `multiclient.always-on` / `auto-away` | `mandatory` | pesan offline, history, room tetap; tanpa perangkat = away ("Offline") |
| `history.persistent` | postgres, juga room tak terdaftar (conference), DM | history permanen; `expire-time: 0` |
| `history.retention.allow-individual-delete` | `true` | REDACT pesan sendiri |
| `fakelag` | burst 20, 5/dtk, budget CHATHISTORY/WHOIS besar | sign-in mengirim banyak baris sekaligus |
| `ip-limits.exempted` | jaringan privat | dev: semua app datang dari gateway docker. **Hapus di produksi** |
| `api` | `:8089`, token dari env | dipakai service akun saja (tidak dipublish) |
| `jwt-auth` | aktif, `autocreate: false` | login atas nama user oleh service akun |
| `channels.registration.max-channels-per-account` | 50 | |
| `limits.monitor-entries` | 500 | MONITOR teman |

Room terdaftar (ChanServ) di Ergo menyimpan topik, mode (termasuk password
`+k` dan batas `+l`), daftar ban, dan AMODE sendiri — tidak perlu MLOCK.

TLS: `ergo mkcerts` membuat sertifikat self-signed di volume `ergo-tls` saat
pertama start.

## `docker-compose.yml`

Network `a09f` (`A09F_SUBNET`, default `172.30.98.0/24`), IP statis:
ergo `.10`, postgres `.40`, api `.50`, mailpit `.60`. Healthcheck di semua
service; `api` menunggu postgres dan ergo sehat. Volume: `postgres-data`,
`ergo-data` (database akun & room Ergo, `ircd.db`), `ergo-tls`.

Image di-pin: Ergo `v2.19.1`, postgres & mailpit dengan digest. `api` di-build
dari `server/api` (Go 1.25, binary statis di Alpine, user non-root).

## Service akun (`api`)

Variabel environment (diisi compose):

| Variabel | Default | |
|---|---|---|
| `LISTEN` | `:8080` | |
| `DATABASE_URL` | | data service (skema dibuat otomatis saat start) |
| `HISTORY_DATABASE_URL` | | history Ergo, baca saja (pencarian); kosong = pencarian mati |
| `ERGO_API`, `ERGO_API_TOKEN` | `http://ergo:8089` | |
| `ERGO_IRC` | `ergo:6667` | untuk bertindak atas nama user |
| `JWT_KEY` | | sama dengan kunci di Ergo |
| `MAX_ATTEMPTS_PER_HOUR`, `MAX_CREATES_PER_HOUR`, `MAX_LOGIN_FAILS_PER_HOUR` | 30, 5, 10 | batas per IP |

Perintah tambahan binary: `-health` (healthcheck), `-setup-rooms`,
`-seed-demo id,id,…` (dipakai `scripts/seed-demo.sh`).
