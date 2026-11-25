#!/usr/bin/env python3
"""Refresh ISO 10383 MIC register and cross-check a pinned FinanceDatabase MIC snapshot."""
import csv, hashlib, io, json, re, time, urllib.request, zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("dist_mic")
OUT.mkdir(exist_ok=True)
ISO_URL = "https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv"
SRC_PATH = Path("collector/source_mic_counts.csv")
REQUIRED = ["MIC","OPERATING MIC","OPRT/SGMT","MARKET NAME-INSTITUTION DESCRIPTION",
            "ISO COUNTRY CODE (ISO 3166)","CITY","STATUS","CREATION DATE"]

def download(url, retries=4):
    req=urllib.request.Request(url, headers={"User-Agent":"global-universe-audit/1.0","Accept":"text/csv,*/*"})
    for n in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r: return r.read()
        except Exception:
            if n == retries-1: raise
            time.sleep(2**n)

with SRC_PATH.open(newline="", encoding="utf-8-sig") as f:
    src = {row["source_mic"].strip(): int(row["listing_rows"]) for row in csv.DictReader(f)}
iso_bytes = download(ISO_URL)
iso_sha = hashlib.sha256(iso_bytes).hexdigest()
text = iso_bytes.decode("utf-8-sig")
reader = csv.DictReader(io.StringIO(text))
headers = reader.fieldnames or []
missing = [x for x in REQUIRED if x not in headers]
if missing: raise RuntimeError(f"ISO source missing required columns: {missing}")
records = []
for raw in reader:
    mic=(raw.get("MIC") or "").strip()
    if not mic: continue
    records.append({
        "mic":mic, "operating_mic":(raw.get("OPERATING MIC") or "").strip(),
        "mic_type":(raw.get("OPRT/SGMT") or "").strip(),
        "venue_name":(raw.get("MARKET NAME-INSTITUTION DESCRIPTION") or "").strip(),
        "acronym":(raw.get("ACRONYM") or "").strip(),
        "country_code":(raw.get("ISO COUNTRY CODE (ISO 3166)") or "").strip(),
        "city":(raw.get("CITY") or "").strip(),
        "status":(raw.get("STATUS") or "").strip(),
        "creation_date":(raw.get("CREATION DATE") or "").strip(),
        "last_update_date":(raw.get("LAST UPDATE DATE") or "").strip(),
        "expiry_date":(raw.get("EXPIRY DATE") or "").strip(),
    })
by_mic = {r["mic"]:r for r in records}
if len(by_mic) != len(records): raise RuntimeError("Duplicate MICs found in latest ISO source")
for mic, n in src.items():
    if mic not in by_mic:
        continue
op_rows=Counter()
for mic,n in src.items():
    rec=by_mic.get(mic)
    if rec:
        op_rows[rec["operating_mic"]] += n

# Full MIC register with exact source coverage and operating-venue aggregation.
register=[]
for r in sorted(records,key=lambda x:x["mic"]):
    register.append({
        **r,
        "source_direct_listing_rows":src.get(r["mic"],0),
        "source_rows_via_mic_or_segment":op_rows.get(r["mic"],0),
        "source_mic_match":"DIRECT" if src.get(r["mic"],0)>0 else "",
        "operating_mic_coverage":"HAS_SOURCE_ROWS" if op_rows.get(r["mic"],0)>0 else "NO_SOURCE_ROWS",
    })

# Discovery heuristic only. It deliberately excludes obvious non-equity venue types,
# but still requires human/exchange confirmation before adding any venue to the core.
include = re.compile(r"(STOCK EXCHANGE|STOCK MARKET|SECURITIES EXCHANGE|EQUITIES EXCHANGE|EQUITY EXCHANGE|BOLSA DE VALORES|BOLSA DE COMERCIO|BOURSE|EXCHANGE.*EQUITIES|EQUITIES.*EXCHANGE|LISTED SECURITIES)", re.I)
exclude = re.compile(r"(FUTURES|DERIVATIVE|COMMODIT|CURRENCY|FOREX|OPTION|BOND|ENERGY|FREIGHT|CARBON|CLEARING|DEPOSITORY|SWAP|INTEREST RATE|TRADE REPORT|TRADE REPORTING|SETTLEMENT|INDEX|DIGITAL ASSET|CRYPTO|OTF|ATS|DARK|SYSTEMATIC INTERNAL|MONEY MARKET|GOLD|BULLION|WAREHOUSE|LENDING|REPO)", re.I)
candidates=[]
for r in records:
    if r["mic_type"]!="OPRT" or r["status"]!="ACTIVE": continue
    if not include.search(r["venue_name"]) or exclude.search(r["venue_name"]): continue
    candidates.append({
        "mic":r["mic"],"country_code":r["country_code"],"city":r["city"],
        "venue_name":r["venue_name"],"acronym":r["acronym"],
        "iso_status":r["status"],"last_update_date":r["last_update_date"],
        "source_direct_listing_rows":src.get(r["mic"],0),
        "source_rows_via_segments":op_rows.get(r["mic"],0),
        "review_status":"DISCOVERY CANDIDATE — verify current cash-equity issuer market and official issuer register",
    })
def write(name, fields, rows):
    with (OUT/name).open("w",newline="",encoding="utf-8-sig") as f:
        w=csv.DictWriter(f,fieldnames=fields,extrasaction="ignore"); w.writeheader(); w.writerows(rows)
reg_fields=list(register[0].keys())
write("latest_iso_mic_register.csv",reg_fields,register)
cand_fields=list(candidates[0].keys()) if candidates else ["mic","country_code","city","venue_name","acronym","iso_status","last_update_date","source_direct_listing_rows","source_rows_via_segments","review_status"]
write("active_cash_equity_venue_candidates.csv",cand_fields,candidates)
write("source_mic_coverage.csv",["source_mic","listing_rows","iso_mic_found","operating_mic","mic_type","iso_venue_name","iso_status"],[
    {"source_mic":mic,"listing_rows":n,"iso_mic_found":"YES" if mic in by_mic else "NO",
     "operating_mic":by_mic.get(mic,{}).get("operating_mic",""),
     "mic_type":by_mic.get(mic,{}).get("mic_type",""),
     "iso_venue_name":by_mic.get(mic,{}).get("venue_name",""),
     "iso_status":by_mic.get(mic,{}).get("status","")}
    for mic,n in sorted(src.items())
])
missing_source_mics=[{"source_mic":m,"listing_rows":n} for m,n in src.items() if m not in by_mic]
write("source_mics_not_found_in_latest_iso.csv",["source_mic","listing_rows"],missing_source_mics)
summary = {
    "snapshot_utc":datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "iso_source_url":ISO_URL,"iso_source_sha256":iso_sha,
    "iso_mic_records":len(records),
    "active_operating_mics":sum(1 for r in records if r["mic_type"]=="OPRT" and r["status"]=="ACTIVE"),
    "source_mic_codes":len(src),"source_listing_rows":sum(src.values()),
    "source_mics_found_in_latest_iso":len([m for m in src if m in by_mic]),
    "source_mics_not_found_in_latest_iso":missing_source_mics,
    "source_listing_rows_with_mic_found":sum(n for m,n in src.items() if m in by_mic),
    "source_listing_rows_with_mic_unresolved":sum(n for m,n in src.items() if m not in by_mic),
    "active_cash_equity_venue_candidates_by_name_heuristic":len(candidates),
    "candidate_venues_with_no_source_rows_direct_or_via_segments":sum(1 for x in candidates if x["source_rows_via_segments"]==0),
    "source_snapshot_reference":"FinanceDatabase pinned snapshot dbdf56858180bc8681a7af794e61e8bb86839014",
    "limitations":[
        "Name heuristic is discovery-only and may include non-cash-equity or inactive-in-practice venues.",
        "ISO 10383 includes trading facilities and segments; it is not a global issuer list.",
        "FinanceDatabase MIC labels may be missing or inconsistent, and its snapshot is pinned to one commit.",
        "An operating MIC with no observed rows is a candidate gap, not proof an issuer listing is missing."
    ]
}
(OUT/"mic_audit_summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
(OUT/"mic_audit_summary.txt").write_text("\n".join(f"{k}: {v}" for k,v in summary.items())+"\n",encoding="utf-8")
with zipfile.ZipFile(OUT/"latest_iso_mic_coverage_audit.zip","w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(OUT.iterdir()):
        if p.is_file() and p.name!="latest_iso_mic_coverage_audit.zip": z.write(p,p.name)
print(json.dumps(summary,indent=2))
