# webapp — im.snailog.com on Cloudflare Workers

The webapp is `desktop/ui/` served as static files; `deploy.sh` copies it into
`public/` with the production `config.js` and `_headers`, then runs
`wrangler deploy`.

```bash
npx wrangler login          # once
./webapp/deploy.sh --dry-run  # optional: look at webapp/public/ first
./webapp/deploy.sh
```

| File | What |
|---|---|
| `config.js` | production endpoints (`https://irc.snailog.com`, `wss://…/socket`) |
| `_headers` | HSTS, CSP (starts Report-Only), cache rules |
| `wrangler.jsonc` | Worker `snailog-webapp`, custom domain `im.snailog.com` |
| `public/` | build output, gitignored |

Before the first deploy: zone `snailog.com` on Cloudflare, backend live at
`irc.snailog.com`, and `http-origin https://im.snailog.com` in
`server/soju/config`. Full checklist: `server/docs/deploy.md`.
