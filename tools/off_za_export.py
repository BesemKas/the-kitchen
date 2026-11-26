"""South African products from the Open Food Facts export, for the shared catalogue.

Open Food Facts asks that anything more than a few hundred products comes from their data export, not their API.
This reads their Parquet export (downloaded once by the GitHub Action) with DuckDB, keeps products sold in South
Africa, and writes them as gzipped JSON lines in the shape of their product API, so the app's parser reads them.

    python tools/off_za_export.py food.parquet data/off-za.jsonl.gz
    python tools/off_za_export.py food.parquet --describe

Data: Open Food Facts, Open Database License (ODbL). See data/README.md.
"""
import gzip
import json
import re
import sys

import duckdb

source, out = sys.argv[1], sys.argv[2]
COUNTRY = "en:south-africa"
NUTRIENTS = ["energy-kj", "energy-kcal", "energy", "proteins", "carbohydrates", "sugars", "fat", "saturated-fat", "trans-fat",
             "monounsaturated-fat", "polyunsaturated-fat", "cholesterol", "fiber", "sodium", "salt"]

con = duckdb.connect()
if out == "--describe":
    for row in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{source}')").fetchall():
        print(row[0], "|", row[1][:200])
    sys.exit(0)

rows = con.execute(f"""
    SELECT code, product_name, brands, quantity, product_quantity, product_quantity_unit, nutriscore_grade, nova_group,
           additives_tags, ingredients_text, nutriments, coalesce(unique_scans_n, 0) AS scans
    FROM read_parquet('{source}')
    WHERE list_contains(countries_tags, '{COUNTRY}') AND code IS NOT NULL
    ORDER BY scans DESC, code
""").fetchall()


def pick(texts, prefer=("main", "en")):
    """A product's name or ingredients: the main language first, then English; skip ones with HTML in them."""
    if not texts:
        return None
    clean = [t for t in texts if t and t.get("text") and "<" not in t["text"]] or [t for t in texts if t and t.get("text")]
    for lang in prefer:
        for t in clean:
            if t.get("lang") == lang:
                return t["text"].strip()
    return clean[0]["text"].strip() if clean else None


written = with_name = with_nutrition = 0
with gzip.open(out, "wt", encoding="utf-8", compresslevel=9) as f:
    for code, names, brands, quantity, pq, pqu, ns, nova, additives, ingredients, nutriments, scans in rows:
        code = re.sub(r"\D", "", code or "")
        name = pick(names)
        if not code or not name:
            continue
        n = {}
        for item in nutriments or []:
            if item and item.get("name") in NUTRIENTS and item.get("100g") is not None:
                n[f"{item['name']}_100g"] = round(float(item["100g"]), 3)
        product = {"code": code, "product_name": name, "brands": brands or "", "quantity": quantity or "",
                   "product_quantity": pq or "", "product_quantity_unit": pqu or "", "nutriscore_grade": ns or "",
                   "nova_group": nova or 0, "additives_tags": list(additives or []), "ingredients_text": pick(ingredients) or "",
                   "nutriments": n}
        f.write(json.dumps(product, ensure_ascii=False, separators=(",", ":")) + "\n")
        written += 1
        with_nutrition += 1 if n else 0
print(f"South African products: {written} written, {with_nutrition} with nutrition")
