# Odisha Gold Rate data

Daily rate files for the Odisha Gold Rate app, published with GitHub Pages from the `docs/` folder.

| File | What it is |
|---|---|
| `docs/today.json` | Today's rates for 8 Odisha cities |
| `docs/history.json` | Last 30 days |
| `docs/app_config.json` | Sponsored card, festivals, minimum app version (edit by hand) |
| `docs/privacy.html` | Privacy policy page |

## How it updates
`.github/workflows/update-rates.yml` runs at 11:15 AM and 5:30 PM IST (and on demand from the Actions tab). It runs `scraper/build_rates.py`, which picks each city's rate in this order: manual Sheet row for today → scraped feed → gold API estimate. It then commits the changed files.

## One-time setup
1. Create a **public** GitHub repo named `odisha-gold-rate-data` and push this folder to it.
2. Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, Folder: `/docs`.
3. Settings → Secrets and variables → Actions → add:
   - `SRC1_URL`: the scraped feed URL
   - `GOLD_API_KEY`: goldapi.io key (optional; enables silver and the fallback estimate)
   - `SHEET_CSV_URL`: published Google Sheet CSV link (optional; manual overrides)
4. Actions tab → *Update rates* → *Run workflow* to test.

## Run locally
```bash
python -m unittest discover -s scraper/tests -v
```

```bash
SRC1_URL="..." python scraper/build_rates.py
```

## Google Sheet columns
`city_id, date, gold_24k_1g, gold_22k_1g, gold_18k_1g, silver_1kg` with dates as `YYYY-MM-DD`. Only rows dated today (IST) are used.
