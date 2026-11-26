"""South African products from the Open Food Facts export, for the shared catalogue.

Reads Open Food Facts' Parquet export on Hugging Face with DuckDB (only the columns and rows needed, so it never
downloads the whole 3+ million products), keeps products sold in South Africa, and writes them as gzipped JSON lines
in the same shape as their product API, so the app's existing parser reads them.

    python tools/off_za_export.py data/off-za.jsonl.gz        # write the file
    python tools/off_za_export.py --describe                  # print the export's columns and one sample row

Data: Open Food Facts, Open Database License (ODbL). See data/README.md.
"""
import gzip
import json
import sys

import duckdb

SOURCE = "hf://datasets/openfoodfacts/product-database/food.parquet"
COUNTRY = "en:south-africa"

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")

if "--describe" in sys.argv:
    for row in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{SOURCE}')").fetchall():
        print(row[0], "|", row[1][:300])
    sample = con.execute(f"""SELECT code, product_name, brands, quantity, product_quantity, product_quantity_unit,
        nutriscore_grade, nova_group, additives_tags, ingredients_text, nutriments
        FROM read_parquet('{SOURCE}') WHERE list_contains(countries_tags, '{COUNTRY}') AND nutriments IS NOT NULL LIMIT 1""").fetchall()
    print("SAMPLE:", json.dumps(sample, default=str)[:3000])
    n = con.execute(f"SELECT count(*) FROM read_parquet('{SOURCE}') WHERE list_contains(countries_tags, '{COUNTRY}')").fetchone()[0]
    print("SOUTH AFRICAN PRODUCTS:", n)
    sys.exit(0)
