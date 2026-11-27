# snailog

Messenger gaya klasik di atas IRC: stack server (Solanum + Atheme + Soju +
service akun Go) di Docker, dan app desktop Tauri.

| Folder | Isi | Mulai dari |
|---|---|---|
| `server/` | stack IRC + service akun (`server/api`, Go) | [`server/docs/README.md`](server/docs/README.md) |
| `desktop/` | app desktop Snailog IM (Tauri) | [`desktop/README.md`](desktop/README.md), [`desktop/docs/fitur.md`](desktop/docs/fitur.md) |
| `tests/` | **semua** tes: server, API, e2e di dalam app, visual | [`tests/README.md`](tests/README.md) |

Dokumen penting:
- Panduan fitur: [`desktop/docs/fitur.md`](desktop/docs/fitur.md)
- Arsitektur app: [`desktop/docs/arsitektur.md`](desktop/docs/arsitektur.md)
- API service akun: [`server/docs/api.md`](server/docs/api.md)
- Operasional server: [`server/docs/operations.md`](server/docs/operations.md)
- Tes: [`tests/README.md`](tests/README.md) — tes baru selalu ditaruh di `tests/`

Cepat mulai:

```bash
cd server && cp .env.example .env   # isi password
./scripts/generate-certs.sh && ./scripts/sync-secrets.sh && ./scripts/soju-host-ip.sh
docker compose up -d postgres && ./scripts/init-api-db.sh
docker compose up -d --build
cd ../desktop && npm install && npm run dev
tests/run_all.sh                    # dari root repo
```
