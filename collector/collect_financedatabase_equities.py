#!/usr/bin/env python3
"""Download and audit the FinanceDatabase equities CSV snapshot without discarding listings."""
import csv, hashlib, io, json, os, sys, time, urllib.request, zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO = "JerBouma/FinanceDatabase"
BASE = f"https://api.github.com/repos/{REPO}"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}"
OUT = Path("dist")
OUT.mkdir(exist_ok=True)

def get(url, accept="*/*", retries=4):
    req = urllib.request.Request(url, headers={
        "User-Agent": "global-universe-research-collector/1.0",
        "Accept": accept,
    })
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)

commit = json.loads(get(f"{BASE}/commits/main", "application/vnd.github+json"))
commit_sha = commit["sha"]
snapshot_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
entries = json.loads(get(f"{BASE}/contents/database/equities?ref={commit_sha}", "application/vnd.github+json"))
files = sorted([e for e in entries if e.get("type") == "file" and e.get("name","").lower().endswith(".csv")], key=lambda x:x["name"])
if not files:
    raise RuntimeError("No exchange CSV files found in FinanceDatabase/database/equities")

def download(entry):
    url = entry.get("download_url") or f"{RAW_BASE}/{commit_sha}/{entry['path']}"
    data = get(url)
    return entry, data, hashlib.sha256(data).hexdigest(), url

downloads, failures = [], []
with ThreadPoolExecutor(max_workers=10) as pool:
    futures = {pool.submit(download, e): e for e in files}
    for future in as_completed(futures):
        e = futures[future]
        try:
            downloads.append(future.result())
        except Exception as exc:
            failures.append((e, repr(exc)))
downloads.sort(key=lambda x:x[0]["name"])

# Discover a stable union schema, retaining every original source column.
all_headers = []
parsed = []
for entry, data, digest, url in downloads:
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    for h in headers:
        if h not in all_headers:
            all_headers.append(h)
    rows = list(reader)
    parsed.append((entry, data, digest, url, headers, rows))

extra_cols = ["source_file", "source_repo", "upstream_commit_sha", "snapshot_utc", "listing_record_key"]
fieldnames = all_headers + extra_cols
all_rows = []
manifest = []
exchange_counts = Counter()
country_counts = Counter()
missing_isin = missing_figi = missing_symbol = 0
key_counter = Counter()
symbol_exchange_pairs = set()
for entry, data, digest, url, headers, rows in parsed:
    imported = 0
    for raw in rows:
        row = {k: raw.get(k) for k in all_headers}
        symbol = (row.get("symbol") or "").strip()
        exchange = (row.get("exchange") or entry["name"].rsplit(".",1)[0]).strip()
        mic = (row.get("mic") or "").strip()
        isin = (row.get("isin") or "").strip()
        figi = (row.get("figi") or "").strip()
        shareclass_figi = (row.get("shareclass_figi") or "").strip()
        country = (row.get("country") or "").strip()
        if not symbol: missing_symbol += 1
        if not isin: missing_isin += 1
        if not figi: missing_figi += 1
        k = "|".join([exchange, mic, symbol, isin, shareclass_figi or figi])
        key = hashlib.sha256(k.encode("utf-8")).hexdigest()[:24]
        row.update({
            "source_file": entry["name"],
            "source_repo": REPO,
            "upstream_commit_sha": commit_sha,
            "snapshot_utc": snapshot_utc,
            "listing_record_key": key,
        })
        all_rows.append(row)
        imported += 1
        exchange_counts[exchange] += 1
        if country: country_counts[country] += 1
        key_counter[key] += 1
        if symbol and exchange: symbol_exchange_pairs.add((symbol, exchange))
    manifest.append({
        "exchange_file": entry["name"], "source_path": entry["path"],
        "bytes": len(data), "sha256": digest, "download_url": url,
        "declared_exchange_code": entry["name"].rsplit(".",1)[0],
        "source_rows": len(rows), "imported_rows": imported,
        "column_count": len(headers), "columns": "|".join(headers),
        "status": "IMPORTED",
    })

for entry, err in failures:
    manifest.append({
        "exchange_file": entry["name"], "source_path": entry["path"],
        "bytes": entry.get("size", 0), "sha256": "", "download_url": entry.get("download_url",""),
        "declared_exchange_code": entry["name"].rsplit(".",1)[0],
        "source_rows": 0, "imported_rows": 0, "column_count": 0, "columns": "",
        "status": "ERROR: " + err[:500],
    })

if not all_rows:
    raise RuntimeError("No listing rows were downloaded successfully.")

def write_csv(path, columns, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

write_csv(OUT/"equity_listings.csv", fieldnames, all_rows)
write_csv(OUT/"exchange_manifest.csv", list(manifest[0].keys()), manifest)

country_rows = [{"country":k, "listing_rows":v} for k,v in sorted(country_counts.items(), key=lambda kv:(-kv[1],kv[0]))]
exchange_rows = [{"exchange":k, "listing_rows":v} for k,v in sorted(exchange_counts.items(), key=lambda kv:(-kv[1],kv[0]))]
write_csv(OUT/"coverage_by_country.csv", ["country","listing_rows"], country_rows)
write_csv(OUT/"coverage_by_exchange.csv", ["exchange","listing_rows"], exchange_rows)

# Preserve original source files alongside the normalized combined CSV.
with zipfile.ZipFile(OUT/"finance_database_original_exchange_csvs.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for entry, data, digest, url in downloads:
        z.writestr(entry["name"], data)

license_text = get(f"{RAW_BASE}/{commit_sha}/LICENSE").decode("utf-8", errors="replace")
(OUT/"LICENSE_FinanceDatabase.txt").write_text(license_text, encoding="utf-8")

total = len(all_rows)
unique_symbols = len({(r.get("symbol") or "").strip() for r in all_rows if (r.get("symbol") or "").strip()})
unique_isins = len({(r.get("isin") or "").strip() for r in all_rows if (r.get("isin") or "").strip()})
unique_figis = len({(r.get("figi") or "").strip() for r in all_rows if (r.get("figi") or "").strip()})
dup_keys = sum(1 for n in key_counter.values() if n > 1)
summary = [
    "GLOBAL EQUITY UNIVERSE — SOURCE IMPORT AUDIT",
    f"Snapshot UTC: {snapshot_utc}",
    f"Source repository: https://github.com/{REPO}",
    f"Source commit SHA: {commit_sha}",
    f"Source folder: database/equities/",
    f"Exchange CSV files discovered: {len(files)}",
    f"Exchange CSV files imported: {len(downloads)}",
    f"Exchange CSV files failed: {len(failures)}",
    f"Listing rows imported (not deduplicated): {total}",
    f"Distinct symbol strings: {unique_symbols}",
    f"Distinct ISINs where present: {unique_isins}",
    f"Distinct FIGIs where present: {unique_figis}",
    f"Rows missing symbol: {missing_symbol}",
    f"Rows missing ISIN: {missing_isin}",
    f"Rows missing FIGI: {missing_figi}",
    f"Repeated listing-record keys: {dup_keys}",
    f"Distinct country names populated: {len(country_counts)}",
    f"Distinct exchange field values populated: {len(exchange_counts)}",
    "",
    "IMPORTANT SCOPE NOTES:",
    "- This is a snapshot of FinanceDatabase's equities folder, not a verified census of every global exchange/security.",
    "- Rows are preserved at exchange-listing/security-symbol level; the same issuer/share class may appear on multiple venues.",
    "- It does not claim to include every debt instrument, OTC instrument, private company, derivative, inactive security, or every delisted historical listing.",
    "- Blank identifiers are left blank; no identifiers have been guessed.",
    "- The repository software is MIT-licensed; data provenance/licensing can vary by underlying exchange/market source. Review individual provenance before redistribution.",
    "- This import is a raw discovery layer, not investment advice or a fundamentals dataset.",
]
(OUT/"audit_summary.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
readme = [
    "FinanceDatabase equity universe snapshot",
    f"Snapshot UTC: {snapshot_utc}",
    f"Upstream commit: {commit_sha}",
    "Files: equity_listings.csv (combined rows), exchange_manifest.csv (per-file hashes/counts),",
    "coverage_by_country.csv, coverage_by_exchange.csv, finance_database_original_exchange_csvs.zip,",
    "audit_summary.txt, LICENSE_FinanceDatabase.txt.",
    "All imported rows are retained. Deduplication has intentionally not been applied.",
]
(OUT/"README.txt").write_text("\n".join(readme)+"\n", encoding="utf-8")

# Build a single portable archive for downstream Excel import.
with zipfile.ZipFile(OUT/"global_equity_universe_snapshot.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p in sorted(OUT.iterdir()):
        if p.is_file() and p.name != "global_equity_universe_snapshot.zip":
            z.write(p, p.name)

print(json.dumps({
    "snapshot_utc": snapshot_utc, "source_commit": commit_sha,
    "files_discovered": len(files), "files_imported": len(downloads), "files_failed": len(failures),
    "listing_rows": total, "distinct_symbols": unique_symbols, "distinct_isins": unique_isins,
    "distinct_figis": unique_figis, "countries": len(country_counts), "exchanges": len(exchange_counts),
    "artifact_dir": str(OUT), "failed_files": [{"file":e["name"],"error":err[:300]} for e,err in failures]
}, indent=2))
