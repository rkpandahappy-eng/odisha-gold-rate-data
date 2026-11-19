# Odisha Gold Rate data

Daily rate files for the Odisha Gold Rate app, published with GitHub Pages from the `docs/` folder.

| File | What it is |
|---|---|
| `docs/today.json` | Today's rates for 8 Odisha cities |
| `docs/history.json` | Last 30 days |
| `docs/app_config.json` | Sponsored card, festivals, minimum app version (edit by hand) |
| `docs/privacy.html` | Privacy policy page |

## How it updates
`.github/workflows/update-rates.yml` runs at 11:15 AM and 5:30 PM IST (and on demand from the Actions tab). It runs `scraper/build_rates.py`, which picks each city's rate in this order:

1. Manual rates dated today, saved from the admin panel into `manual/today.json`
2. Scraped feed

No price API is used. If the scraper fails and there's no manual entry, the old files are kept and the workflow fails, so GitHub emails the repo owner. Saving manual rates in the admin panel starts the workflow straight away.

## Admin panel
`admin/` (page) and `functions/api/[[route]].js` (Cloudflare Pages Function) run on Cloudflare Pages. The admin can:
- publish manual rates (all cities or per city) or stop them,
- edit the sponsored card and buying days (`docs/app_config.json`),
- see recent rate-update runs.

The function only lets the admin change `manual/today.json` and `docs/app_config.json`, and checks every value before saving.

Cloudflare → Pages project → Settings → Variables and Secrets:
- `GITHUB_TOKEN` (secret): fine-grained token, **Contents: read and write** on this repo only
- Sign-in, one of:
  - Cloudflare Access: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, optional `ADMIN_EMAILS`
  - `ADMIN_PASSWORD` (secret, 12+ characters)

Cloudflare Pages build settings: no build command, output directory `/`.

## One-time setup (GitHub)
1. Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, Folder: `/docs`.
2. Settings → Secrets and variables → Actions → add `SRC1_URL`: the scraped feed URL.
3. Actions tab → *Update rates* → *Run workflow* to test.

## Run tests locally
```bash
python -m unittest discover -s scraper/tests -v
```

```bash
node --test tests/admin_api.test.mjs
```
