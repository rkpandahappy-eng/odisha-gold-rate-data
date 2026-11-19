import json
import os
import sys
import unittest
from datetime import datetime

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


class ManualSheetTests(unittest.TestCase):
    def test_reads_only_todays_complete_rows(self):
        csv_text = (
            "city_id,date,gold_24k_1g,gold_22k_1g,gold_18k_1g,silver_1kg\n"
            "cuttack,2026-11-19,\"13,326\",12216,9995,158000\n"
            "puri,2026-11-18,13300,12190,9975,157000\n"
            "angul,2026-11-19,13326,,9995,\n"
        )
        rows = br.load_manual_rows(csv_text, "2026-11-19")
        self.assertEqual(list(rows), ["cuttack"])
        self.assertEqual(rows["cuttack"]["gold_24k_1g"], 13326)


class ParseNumberTests(unittest.TestCase):
    def test_strips_symbols(self):
        self.assertEqual(br.parse_number("₹1,22,160.00"), 122160.0)

    def test_rejects_text(self):
        with self.assertRaises(br.SourceError):
            br.parse_number("N/A")


if __name__ == "__main__":
    unittest.main()
