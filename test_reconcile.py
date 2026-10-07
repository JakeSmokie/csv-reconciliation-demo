import csv
import json
import random
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
import reconcile


class ReconciliationResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def csv(self, name, header, rows):
        path = self.root / name
        with path.open("w", encoding="utf-8-sig", newline="") as out:
            writer = csv.writer(out)
            writer.writerow(header)
            writer.writerows(rows)
        return path

    def paths(self, expected, actual):
        return (self.csv("expected.csv", reconcile.SCHEMAS["expected"], expected),
                self.csv("actual.csv", reconcile.SCHEMAS["actual"], actual))

    def test_synthetic_golden_totals_statuses_and_source_rows(self):
        exp, act = self.paths([("T001", "1000", "100", "0"), ("T002", "500", "50", "0"),
                               ("T003", "200", "20", "30")], [("T001", "900"), ("T002", "430"), ("T004", "75")])
        report = reconcile.reconcile(exp, act)
        self.assertEqual(report["counts"], dict(matched=1, mismatch=1, missing=1, unexpected=1))
        self.assertEqual(report["totals"], dict(gross="1700.00", commission="170.00", refund="30.00",
                                              expected_net="1500.00", actual_net="1405.00", delta="-95.00",
                                              underpayment="170.00", overpayment="75.00"))
        self.assertEqual([e["delta"] for e in report["entries"]], ["0.00", "-20.00", "-150.00", "75.00"])
        self.assertEqual(report["entries"][2]["expected_source"]["line_start"], 4)
        self.assertEqual(report["entries"][2]["expected_source"]["values"]["refund"], "30")
        self.assertIsNone(report["entries"][2]["actual_source"])
        paths = reconcile.write_report(report, self.root / "reports")
        self.assertEqual(json.loads(paths[0].read_text(encoding="utf-8")), report)
        with paths[1].open(encoding="utf-8-sig", newline="") as src:
            exported = list(csv.DictReader(src))
        self.assertEqual(exported[2]["expected_line_start"], "4")
        self.assertEqual(json.loads(exported[2]["expected_source_values_json"])["id"], "T003")

    def test_cents_are_exact_and_signed_adjustments_survive(self):
        exp, act = self.paths([("CENT", "0.30", "0.10", "0.10"), ("ADJ", "0", "0", "5")],
                              [("CENT", "0.10"), ("ADJ", "-5.00")])
        report = reconcile.reconcile(exp, act)
        self.assertEqual(report["counts"]["matched"], 2)
        self.assertEqual(report["totals"]["expected_net"], "-4.90")
        self.assertEqual(report["totals"]["delta"], "0.00")

    def test_duplicate_in_either_input_rejects_cli_without_report(self):
        for side in ("expected", "actual"):
            with self.subTest(side=side):
                exp_rows = [("A", "10", "1", "0")]
                act_rows = [("A", "9")]
                (exp_rows if side == "expected" else act_rows).append((exp_rows if side == "expected" else act_rows)[0])
                exp, act = self.paths(exp_rows, act_rows)
                out = self.root / ("out-" + side)
                run = subprocess.run([sys.executable, str(Path(reconcile.__file__)), str(exp), str(act),
                                      "--out-dir", str(out)], capture_output=True, text=True)
                self.assertEqual(run.returncode, 2)
                self.assertIn("duplicate id", run.stderr)
                self.assertFalse(out.exists())

    def test_invalid_schema_ids_cells_and_money_reject(self):
        cases = [
            (("gross", "id", "commission", "refund"), [("1", "A", "0", "0")]),
            (reconcile.SCHEMAS["expected"], [("A", "1", "0")]),
            (reconcile.SCHEMAS["expected"], [("A", "1", "0", "0", "extra")]),
            (reconcile.SCHEMAS["expected"], [("", "1", "0", "0")]),
        ]
        cases += [(reconcile.SCHEMAS["expected"], [("A", raw, "0", "0")])
                  for raw in ("not-money", "NaN", "Infinity", "-Infinity", "0.001", "1e2", "1000000000000000")]
        actual = self.csv("actual.csv", reconcile.SCHEMAS["actual"], [])
        for header, rows in cases:
            with self.subTest(rows=rows):
                expected = self.csv("expected.csv", header, rows)
                with self.assertRaises(reconcile.InputError):
                    reconcile.reconcile(expected, actual)
        for raw in ("NaN", "oops", "0.001"):
            exp, act = self.paths([("A", "1", "0", "0")], [("A", raw)])
            with self.assertRaises(reconcile.InputError):
                reconcile.reconcile(exp, act)

    def test_formula_and_control_leading_ids_export_as_text_with_exact_json_identity(self):
        ids = ["=1+1", "+SUM(1,1)", "-2+3", "@SUM(1,1)", "\t=1+1",
               "\r=1+1", "\n=1+1", " =1+1", "\x01=1+1", "\ufeff=1+1", "ordinary-id"]
        exp, act = self.paths([(key, "1.00", "0.10", "0") for key in ids],
                              [(key, "0.90") for key in ids])
        report = reconcile.reconcile(exp, act)
        self.assertEqual(report["counts"]["matched"], len(ids))
        self.assertEqual(report["totals"]["expected_net"], "9.90")
        self.assertEqual(report["totals"]["actual_net"], "9.90")
        self.assertEqual(report["totals"]["delta"], "0.00")
        paths = reconcile.write_report(report, self.root / "reports")
        saved = json.loads(paths[0].read_text(encoding="utf-8"))
        self.assertEqual([entry["id"] for entry in saved["entries"]], ids)
        self.assertEqual([entry["expected_source"]["values"]["id"] for entry in saved["entries"]], ids)
        with paths[1].open(encoding="utf-8-sig", newline="") as stream:
            exported = list(csv.DictReader(stream))
        self.assertEqual([entry["id"] for entry in exported], ["'" + key for key in ids[:-1]] + [ids[-1]])
        self.assertEqual([json.loads(entry["expected_source_values_json"])["id"] for entry in exported], ids)

    def test_empty_files_with_headers_are_zero_and_safe(self):
        report = reconcile.reconcile(*self.paths([], []))
        self.assertEqual(report["entries"], [])
        self.assertEqual(sum(report["counts"].values()), 0)
        self.assertTrue(all(value == "0.00" for value in report["totals"].values()))

    def test_seeded_integer_cent_oracle_conserves_all_money(self):
        rng = random.Random(610)
        expected, actual = [], []
        expected_cents = actual_cents = under_cents = over_cents = 0
        def text(cents):
            sign = "-" if cents < 0 else ""
            return f"{sign}{abs(cents) // 100}.{abs(cents) % 100:02d}"
        for i in range(200):
            gross, fee, refund = rng.randrange(1_000_000), rng.randrange(10_000), rng.randrange(10_000)
            net = gross - fee - refund
            expected.append((str(i), text(gross), text(fee), text(refund)))
            expected_cents += net
            paid = 0 if i % 5 == 0 else net + (i % 3 - 1)
            if i % 5:
                actual.append((str(i), text(paid)))
                actual_cents += paid
            delta = paid - net
            under_cents += max(0, -delta)
            over_cents += max(0, delta)
        for i in range(25):
            paid = rng.randrange(10_000)
            actual.append(("extra" + str(i), text(paid)))
            actual_cents += paid
            over_cents += paid
        report = reconcile.reconcile(*self.paths(expected, actual))
        for field, cents in (("expected_net", expected_cents), ("actual_net", actual_cents),
                             ("delta", actual_cents - expected_cents), ("underpayment", under_cents),
                             ("overpayment", over_cents)):
            self.assertEqual(report["totals"][field], text(cents))
        self.assertEqual(report["counts"]["missing"], 40)
        self.assertEqual(report["counts"]["unexpected"], 25)
        self.assertEqual(sum(Decimal(e["delta"]) for e in report["entries"]), Decimal(text(actual_cents - expected_cents)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
