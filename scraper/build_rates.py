#!/usr/bin/env python3
"""Build docs/today.json and docs/history.json for the Odisha Gold Rate app.

Rate order for each city:
  1. Manual entry dated today (IST), saved by the admin panel in manual/today.json
  2. Scraped feed (sources in sources.json)
No price API is used. If neither gives a rate, the old files are kept.

Uses only the Python standard library.

Exit codes:
  0  published
  1  nothing published (old files kept) -> workflow fails and GitHub emails the admin
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "scraper", "sources.json")
OUT_DIR = os.path.join(ROOT, "docs")
MANUAL_PATH = os.path.join(ROOT, "manual", "today.json")
IST = timezone(timedelta(hours=5, minutes=30))
HISTORY_DAYS = 30

GOLD_FIELDS = ("gold_24k_1g", "gold_22k_1g", "gold_18k_1g")
BUY_FIELDS = ("buy_24k_1g", "buy_22k_1g", "buy_18k_1g")
SOURCE_LABELS = {
    "manual": ("Market rate", "ବଜାର ଦର"),
    "scraped": ("Market rate", "ବଜାର ଦର"),
}
NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, UnicodeDecodeError)


class SourceError(Exception):
    """A source returned missing, stale or implausible data."""


def log(message):
    print(message, flush=True)


def resolve(value):
    """Values written as "env:NAME" are read from environment variables (GitHub Secrets)."""
    if isinstance(value, str) and value.startswith("env:"):
        return os.environ.get(value[4:], "").strip()
    return value


def http_get(url, user_agent, timeout, extra_headers=None):
    headers = {"User-Agent": user_agent, "Accept": "application/json, */*"}
    headers.update(extra_headers or {})
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def parse_number(text):
    if text is None:
        raise SourceError("missing number")
    cleaned = str(text).replace("₹", "").replace(",", "").strip()
    try:
        return float(cleaned)
    except ValueError as exc:
        raise SourceError(f"not a number: {text!r}") from exc


def parse_rate_list(payload, items, now, max_age_hours):
    """Parse a {"response": {"view_rate_list": [...]}} feed into per-gram rates."""
    try:
        rows = payload["response"]["view_rate_list"]
    except (KeyError, TypeError) as exc:
        raise SourceError("unexpected JSON shape") from exc

    by_name = {
        str(row.get("final_metal_type", "")).strip().lower(): row
        for row in rows
        if isinstance(row, dict)
    }
    result = {}
    newest = None
    for key, name in items.items():  # key like "gold_24k" or "silver"
        row = by_name.get(name.strip().lower())
        if key == "silver":
            # Optional: per-gram silver price, published per kg.
            if row is not None:
                try:
                    silver = parse_number(row.get("sell_rate"))
                except SourceError:
                    silver = 0
                if silver > 0:
                    result["silver_1kg"] = round(silver * 1000)
            continue
        if row is None:
            raise SourceError(f"item not found: {key}")
        sell = parse_number(row.get("sell_rate"))
        if sell <= 0:
            raise SourceError(f"non-positive sell rate for {key}")
        result[f"{key}_1g"] = round(sell)

        buy_text = row.get("buy_rate")
        if buy_text not in (None, ""):
            buy = parse_number(buy_text)
            if buy > 0:
                result[f"buy_{key[len('gold_'):]}_1g"] = round(buy)

        stamp = str(row.get("added_date_time", "")).strip()
        if stamp:
            try:
                stamp_time = datetime.strptime(stamp, "%d-%b-%Y %I:%M %p").replace(tzinfo=IST)
            except ValueError as exc:
                raise SourceError(f"bad timestamp: {stamp!r}") from exc
            if newest is None or stamp_time > newest:
                newest = stamp_time

    if newest is None:
        raise SourceError("feed has no timestamp")
    if now - newest > timedelta(hours=max_age_hours):
        raise SourceError(f"feed is stale (last update {newest.isoformat()})")
    return result


def validate_gold(rates, previous, max_move_pct):
    """Reject zero values, wrong purity ratios and big jumps from the previous day."""
    for field in GOLD_FIELDS:
        value = rates.get(field)
        if not isinstance(value, (int, float)) or value <= 0:
            raise SourceError(f"missing or invalid {field}")

    ratio_22 = rates["gold_22k_1g"] / rates["gold_24k_1g"]
    ratio_18 = rates["gold_18k_1g"] / rates["gold_24k_1g"]
    if not 0.90 <= ratio_22 <= 0.93:
        raise SourceError(f"22K/24K ratio out of range: {ratio_22:.4f}")
    if not 0.72 <= ratio_18 <= 0.78:
        raise SourceError(f"18K/24K ratio out of range: {ratio_18:.4f}")

    if previous:
        for field in GOLD_FIELDS:
            old = previous.get(field)
            if isinstance(old, (int, float)) and old > 0:
                move = abs(rates[field] - old) / old * 100
                if move > max_move_pct:
                    raise SourceError(f"{field} moved {move:.1f}% from previous day")


def load_manual(data, today, city_ids):
    """Return {city_id: {field: value}} from manual/today.json if it is dated today.

    The file is written by the admin panel:
      {"schema_version": 1, "date": "YYYY-MM-DD", "cities": {"cuttack": {...}}}
    Entries with missing gold values or wrong purity ratios are ignored.
    """
    if not isinstance(data, dict) or data.get("date") != today:
        return {}
    cities = data.get("cities")
    if not isinstance(cities, dict):
        return {}
    rows = {}
    for city_id, raw in cities.items():
        if city_id not in city_ids or not isinstance(raw, dict):
            log(f"[manual] ignoring unknown city entry")
            continue
        values = {}
        for field in GOLD_FIELDS + ("silver_1kg",):
            value = raw.get(field)
            if isinstance(value, (int, float)) and value > 0:
                values[field] = round(value)
        try:
            validate_gold(values, None, 0)
        except SourceError as exc:
            log(f"[manual] {city_id}: ignored ({exc})")
            continue
        rows[city_id] = values
    return rows


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def default_app_config():
    return {
        "schema_version": 1,
        "min_supported_app_version": "1.0.0",
        "sponsored": {
            "active": False,
            "city_ids": [],
            "title_or": "ଆପଣଙ୍କ ସୋ'ରୁମ୍ ବିଜ୍ଞାପନ ଦିଅନ୍ତୁ",
            "title_en": "Advertise Your Jewellery Showroom Here",
            "whatsapp_url": "",
        },
        "festivals": [],
    }


def build(now=None):
    config = load_json(CONFIG_PATH, None)
    if config is None:
        log("sources.json missing or invalid")
        return 1

    user_agent = config.get("user_agent", "OdishaGoldRateBot/1.0")
    timeout = int(config.get("timeout_seconds", 20))
    max_age = float(config.get("max_feed_age_hours", 36))
    max_move = float(config.get("max_daily_move_pct", 8))
    cities = config["cities"]

    now = now or datetime.now(IST)
    today = now.date().isoformat()

    history = load_json(os.path.join(OUT_DIR, "history.json"), {"schema_version": 1, "days": []})
    past_days = [day for day in history.get("days", []) if day.get("date", "") < today]
    previous_day = past_days[-1]["cities"] if past_days else {}
    reference_previous = previous_day.get(cities[0]["id"]) if previous_day else None

    # 1. Scraped sources, in order.
    base, base_type = None, None
    for source in config.get("sources", []):
        source_id = source.get("id", "source")
        try:
            url = resolve(source.get("url", ""))
            if not url:
                raise SourceError("URL not configured")
            if source.get("type") != "json_rate_list":
                raise SourceError(f"unsupported source type {source.get('type')!r}")
            payload = json.loads(http_get(url, user_agent, timeout))
            rates = parse_rate_list(payload, source["items"], now, max_age)
            validate_gold(rates, reference_previous, max_move)
            base, base_type = rates, "scraped"
            log(f"[{source_id}] ok")
            break
        except (SourceError, KeyError, *NETWORK_ERRORS) as exc:
            log(f"[{source_id}] failed: {exc}")

    # 2. Manual overrides from the admin panel (manual/today.json).
    manual = load_manual(
        load_json(MANUAL_PATH, {}), today, {city["id"] for city in cities}
    )
    log(f"[manual] {len(manual)} city entry(s) for today")

    if base is None and not all(city["id"] in manual for city in cities):
        log("No usable rates for every city. Keeping the old files.")
        return 1

    cities_out = {}
    history_cities = {}
    for city in cities:
        city_id = city["id"]
        previous = previous_day.get(city_id, {}) if previous_day else {}
        if city_id in manual:
            values, source_type = manual[city_id], "manual"
        else:
            values, source_type = base, base_type

        silver = (
            values.get("silver_1kg")
            or (base or {}).get("silver_1kg")
            or previous.get("silver_1kg")
        )
        label_en, label_or = SOURCE_LABELS[source_type]
        record = {
            "name_en": city["name_en"],
            "name_or": city["name_or"],
            "source": {"type": source_type, "label_en": label_en, "label_or": label_or},
        }
        for field in GOLD_FIELDS:
            record[field] = values[field]
        for field in BUY_FIELDS:
            if field in values:
                record[field] = values[field]
        record["silver_1kg"] = silver

        change = {}
        for field in GOLD_FIELDS + ("silver_1kg",):
            old = previous.get(field)
            new = record.get(field)
            change[field] = new - old if isinstance(old, (int, float)) and isinstance(new, (int, float)) else None
        record["change"] = change

        cities_out[city_id] = record
        history_cities[city_id] = {field: record[field] for field in GOLD_FIELDS + ("silver_1kg",)}

    today_doc = {
        "schema_version": 1,
        "updated_at": now.replace(microsecond=0).isoformat(),
        "cities": cities_out,
    }
    days = past_days + [{"date": today, "cities": history_cities}]
    history_doc = {"schema_version": 1, "days": days[-HISTORY_DAYS:]}

    write_json(os.path.join(OUT_DIR, "today.json"), today_doc)
    write_json(os.path.join(OUT_DIR, "history.json"), history_doc)
    config_path = os.path.join(OUT_DIR, "app_config.json")
    if not os.path.exists(config_path):
        write_json(config_path, default_app_config())

    log(f"Published {len(cities_out)} cities, source={base_type or 'manual'}")
    return 0


if __name__ == "__main__":
    sys.exit(build())
