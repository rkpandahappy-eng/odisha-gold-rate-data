import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_rates as br  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "rate_list.json")
ITEMS = {"gold_24k": "Gold 24K", "gold_22k": "Gold 22K", "gold_18k": "Gold 18K", "silver": "Silver 925"}
NOW = datetime(2026, 11, 18, 18, 0, tzinfo=br.IST)


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as handle:
        return json.load(handle)


class ParseRateListTests(unittest.TestCase):
    def test_parses_sell_and_buy_rates(self):
        rates = br.parse_rate_list(load_fixture(), ITEMS, NOW, 36)
        self.assertEqual(rates["gold_24k_1g"], 13325)
        self.assertEqual(rates["gold_22k_1g"], 12215)
        self.assertEqual(rates["gold_18k_1g"], 9994)
        self.assertEqual(rates["buy_22k_1g"], 11848)
        self.assertEqual(rates["silver_1kg"], 172000)

    def test_missing_silver_is_optional(self):
        payload = load_fixture()
        payload["response"]["view_rate_list"] = [
            row for row in payload["response"]["view_rate_list"] if row["metal_type"] != "Silver"
        ]
        rates = br.parse_rate_list(payload, ITEMS, NOW, 36)
        self.assertNotIn("silver_1kg", rates)
        self.assertEqual(rates["gold_24k_1g"], 13325)

    def test_missing_item_raises(self):
        payload = load_fixture()
        payload["response"]["view_rate_list"] = [
            row for row in payload["response"]["view_rate_list"] if row["purity"] != "22K"
        ]
        with self.assertRaises(br.SourceError):
            br.parse_rate_list(payload, ITEMS, NOW, 36)

    def test_stale_feed_raises(self):
        later = datetime(2026, 11, 21, 12, 0, tzinfo=br.IST)
        with self.assertRaises(br.SourceError):
            br.parse_rate_list(load_fixture(), ITEMS, later, 36)

    def test_unexpected_shape_raises(self):
        with self.assertRaises(br.SourceError):
            br.parse_rate_list({"data": []}, ITEMS, NOW, 36)


CARDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "rate_cards.html")
CARD_ITEMS = {"gold_24k": "24K Fine Gold", "gold_22k": "22K Ornament Gold", "gold_18k": "18K Diamond Gold"}


def load_cards():
    with open(CARDS, encoding="utf-8") as handle:
        return handle.read()


class ParseHtmlCardsTests(unittest.TestCase):
    def test_parses_gold_cards(self):
        rates = br.parse_html_cards(load_cards(), CARD_ITEMS, 36)
        self.assertEqual(rates, {"gold_24k_1g": 12327, "gold_22k_1g": 11300, "gold_18k_1g": 9245})
        br.validate_gold(rates, None, 8)

    def test_ignores_script_text(self):
        # The script mentions "24K Fine Gold ₹1.00"; the real card must win.
        self.assertEqual(br.parse_html_cards(load_cards(), CARD_ITEMS, 36)["gold_24k_1g"], 12327)

    def test_missing_card_raises(self):
        page = load_cards().replace("22K Ornament Gold", "22K Gold")
        with self.assertRaises(br.SourceError):
            br.parse_html_cards(page, CARD_ITEMS, 36)

    def test_stale_card_raises(self):
        with self.assertRaises(br.SourceError):
            br.parse_html_cards(load_cards(), {"silver": "Silver"}, 36)

    def test_silver_when_listed(self):
        rates = br.parse_html_cards(load_cards(), {"silver": "Silver"}, 72)
        self.assertEqual(rates, {"silver_1kg": 158500})

    def test_age_text(self):
        self.assertEqual(br.parse_age_hours("Updated 58 minutes ago"), 58 / 60)
        self.assertEqual(br.parse_age_hours("Updated an hour ago"), 1)
        self.assertEqual(br.parse_age_hours("Updated 3 days ago"), 72)
        self.assertEqual(br.parse_age_hours("Updated just now"), 0)
        with self.assertRaises(br.SourceError):
            br.parse_age_hours("Updated yesterday")


class ValidateGoldTests(unittest.TestCase):
    GOOD = {"gold_24k_1g": 13325, "gold_22k_1g": 12215, "gold_18k_1g": 9994}

    def test_good_rates_pass(self):
        br.validate_gold(self.GOOD, {"gold_24k_1g": 13604, "gold_22k_1g": 12470, "gold_18k_1g": 10203}, 8)

    def test_bad_ratio_fails(self):
        bad = dict(self.GOOD, gold_22k_1g=13000)
        with self.assertRaises(br.SourceError):
            br.validate_gold(bad, None, 8)

    def test_big_jump_fails(self):
        with self.assertRaises(br.SourceError):
            br.validate_gold(self.GOOD, {"gold_24k_1g": 11000, "gold_22k_1g": 10076, "gold_18k_1g": 8250}, 8)

    def test_zero_fails(self):
        with self.assertRaises(br.SourceError):
            br.validate_gold(dict(self.GOOD, gold_18k_1g=0), None, 8)


class ManualFileTests(unittest.TestCase):
    CITIES = {"cuttack", "puri", "angul"}
    GOOD = {"gold_24k_1g": 13326, "gold_22k_1g": 12216, "gold_18k_1g": 9995, "silver_1kg": 158000}

    def test_reads_todays_valid_entries(self):
        data = {
            "schema_version": 1,
            "date": "2026-11-19",
            "cities": {
                "cuttack": self.GOOD,
                "angul": {"gold_24k_1g": 13326, "gold_18k_1g": 9995},
                "puri": dict(self.GOOD, gold_22k_1g=13300),
                "nowhere": self.GOOD,
            },
        }
        rows = br.load_manual(data, "2026-11-19", self.CITIES)
        self.assertEqual(list(rows), ["cuttack"])
        self.assertEqual(rows["cuttack"]["silver_1kg"], 158000)

    def test_old_date_is_ignored(self):
        data = {"schema_version": 1, "date": "2026-11-18", "cities": {"cuttack": self.GOOD}}
        self.assertEqual(br.load_manual(data, "2026-11-19", self.CITIES), {})

    def test_empty_file_is_ignored(self):
        self.assertEqual(br.load_manual({}, "2026-11-19", self.CITIES), {})


class ParseNumberTests(unittest.TestCase):
    def test_strips_symbols(self):
        self.assertEqual(br.parse_number("₹1,22,160.00"), 122160.0)

    def test_rejects_text(self):
        with self.assertRaises(br.SourceError):
            br.parse_number("N/A")


if __name__ == "__main__":
    unittest.main()


class UnchangedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_out = br.OUT_DIR
        br.OUT_DIR = self.tmp.name
        self.today = {"schema_version": 1, "updated_at": NOW.isoformat(), "cities": {"cuttack": {"gold_22k_1g": 11540}}}
        self.history = {"schema_version": 1, "days": [{"date": "2026-11-18", "cities": {}}]}
        br.write_json(os.path.join(br.OUT_DIR, "today.json"), self.today)
        br.write_json(os.path.join(br.OUT_DIR, "history.json"), self.history)

    def tearDown(self):
        br.OUT_DIR = self.old_out
        self.tmp.cleanup()

    def test_same_rates_soon_after_are_kept(self):
        later = NOW + timedelta(minutes=5)
        doc = dict(self.today, updated_at=later.isoformat())
        self.assertTrue(br.unchanged_and_recent(doc, self.history, later))

    def test_new_rate_is_written(self):
        doc = {"schema_version": 1, "updated_at": NOW.isoformat(), "cities": {"cuttack": {"gold_22k_1g": 11600}}}
        self.assertFalse(br.unchanged_and_recent(doc, self.history, NOW))

    def test_refreshed_after_six_hours(self):
        later = NOW + timedelta(hours=6, minutes=1)
        self.assertFalse(br.unchanged_and_recent(self.today, self.history, later))

    def test_new_day_is_written(self):
        tomorrow = datetime(2026, 11, 19, 0, 30, tzinfo=br.IST)
        self.assertFalse(br.unchanged_and_recent(self.today, self.history, tomorrow))
