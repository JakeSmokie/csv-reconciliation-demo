#!/usr/bin/env python3
"""Exact offline reconciliation for explicitly prepared transaction/payout CSVs."""
import argparse
import csv
import hashlib
import json
import re
import sys
import unicodedata
from decimal import Decimal, localcontext
from pathlib import Path

SCHEMAS = {
    "expected": ("id", "gross", "commission", "refund"),
    "actual": ("id", "actual_net"),
}
MONEY = re.compile(r"[+-]?[0-9]+(?:\.[0-9]{1,2})?\Z")
MAX_MONEY = Decimal("999999999999999.99")
MAX_ROWS = 100_000
ZERO = Decimal("0.00")


class InputError(ValueError):
    pass


def amount(raw, where):
    try:
        value = Decimal(raw)
    except Exception as exc:
        raise InputError(f"{where}: invalid decimal money") from exc
    if not value.is_finite():
        raise InputError(f"{where}: nonfinite money is forbidden")
    if not MONEY.fullmatch(raw) or abs(value) > MAX_MONEY:
        raise InputError(f"{where}: money must use dot, <=2 decimals and <= {MAX_MONEY} absolute")
    return ZERO if value == ZERO else value


def money(value):
    return format(ZERO if value == ZERO else value, ".2f")


def read_rows(path, kind):
    path = Path(path).resolve()
    # Parse the exact bytes whose digest is recorded, including a possible UTF-8 BOM.
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InputError(f"{path.name}: expected UTF-8 CSV") from exc
    import io
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    rows = {}
    schema = SCHEMAS[kind]
    try:
        header = next(reader, None)
        if header != list(schema):
            raise InputError(f"{path.name}: exact header required: {','.join(schema)}")
        while True:
            start_line = reader.line_num + 1
            cells = next(reader, None)
            if cells is None:
                break
            where = f"{path.name}:line {start_line}"
            if len(cells) != len(schema):
                raise InputError(f"{where}: expected {len(schema)} cells, received {len(cells)}")
            original = dict(zip(schema, cells))
            key = original["id"]
            if not key:
                raise InputError(f"{where}: id must be nonempty; exact whitespace is significant")
            if key in rows:
                raise InputError(f"{where}: duplicate id; first occurrence line {rows[key]['source']['line_start']}")
            if len(rows) >= MAX_ROWS:
                raise InputError(f"{where}: maximum {MAX_ROWS} data records per file")
            values = {field: amount(original[field], f"{where}:{field}") for field in schema[1:]}
            rows[key] = {
                "values": values,
                "source": {"path": str(path), "line_start": start_line,
                           "line_end": reader.line_num, "values": original},
            }
    except csv.Error as exc:
        raise InputError(f"{path.name}:line {reader.line_num}: malformed CSV") from exc
    return rows, {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                  "rows": len(rows)}


def reconcile(expected_path, actual_path):
    with localcontext() as ctx:
        # Bounds on rows and amounts keep every operation exact within this precision.
        ctx.prec = 40
        expected, expected_meta = read_rows(expected_path, "expected")
        actual, actual_meta = read_rows(actual_path, "actual")
        entries = []
        counts = dict.fromkeys(("matched", "mismatch", "missing", "unexpected"), 0)
        gross = commission = refund = total_expected = total_actual = ZERO
        underpayment = overpayment = ZERO
        for key in list(expected) + [key for key in actual if key not in expected]:
            exp = expected.get(key)
            act = actual.get(key)
            net = ZERO
            if exp:
                values = exp["values"]
                gross += values["gross"]
                commission += values["commission"]
                refund += values["refund"]
                net = values["gross"] - values["commission"] - values["refund"]
            paid = act["values"]["actual_net"] if act else ZERO
            delta = paid - net
            status = "unexpected" if exp is None else "missing" if act is None else "matched" if delta == ZERO else "mismatch"
            counts[status] += 1
            total_expected += net
            total_actual += paid
            underpayment += max(ZERO, -delta)
            overpayment += max(ZERO, delta)
            entries.append({"id": key, "status": status, "expected_net": money(net),
                            "actual_net": money(paid), "delta": money(delta),
                            "expected_source": exp["source"] if exp else None,
                            "actual_source": act["source"] if act else None})
        delta_total = total_actual - total_expected
        if (total_expected != gross - commission - refund
                or delta_total != sum((Decimal(entry["delta"]) for entry in entries), ZERO)
                or delta_total != overpayment - underpayment):
            raise ArithmeticError("money conservation failed")
        return {"schema_version": 1, "money_unit": "RUB", "delta_definition": "actual - expected",
                "inputs": {"expected": expected_meta, "actual": actual_meta}, "counts": counts,
                "totals": {"gross": money(gross), "commission": money(commission), "refund": money(refund),
                           "expected_net": money(total_expected), "actual_net": money(total_actual),
                           "delta": money(delta_total), "underpayment": money(underpayment),
                           "overpayment": money(overpayment)}, "conservation_verified": True,
                "entries": entries}


def write_report(report, out_dir):
    out_dir = Path(out_dir).resolve()
    inputs = {Path(meta["path"]) for meta in report["inputs"].values()}
    targets = [out_dir / "report.json", out_dir / "report.csv"]
    if any(target.resolve() in inputs for target in targets):
        raise InputError("output paths must not overwrite input CSV files")
    out_dir.mkdir(parents=True, exist_ok=True)
    targets[0].write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    fields = ("id", "status", "expected_net", "actual_net", "delta",
              "expected_line_start", "expected_line_end", "actual_line_start", "actual_line_end",
              "expected_source_values_json", "actual_source_values_json")
    with targets[1].open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for entry in report["entries"]:
            row = {field: entry[field] for field in fields[:5]}
            # Preserve exact IDs in JSON; neutralize spreadsheet formulas in the CSV view.
            if (row["id"][0] in "=+-@" or row["id"][0].isspace()
                    or unicodedata.category(row["id"][0]) in ("Cc", "Cf")):
                row["id"] = "'" + row["id"]
            for side in ("expected", "actual"):
                source = entry[f"{side}_source"]
                row[f"{side}_line_start"] = source["line_start"] if source else ""
                row[f"{side}_line_end"] = source["line_end"] if source else ""
                row[f"{side}_source_values_json"] = json.dumps(source["values"], ensure_ascii=False) if source else ""
            writer.writerow(row)
    return targets


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expected_csv", type=Path)
    parser.add_argument("actual_csv", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = reconcile(args.expected_csv, args.actual_csv)
        paths = write_report(report, args.out_dir)
    except (InputError, OSError, ArithmeticError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"counts": report["counts"], "totals": report["totals"],
                      "reports": [str(path) for path in paths]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
