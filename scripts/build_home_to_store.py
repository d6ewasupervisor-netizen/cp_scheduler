#!/usr/bin/env python3
"""
Build home-to-store mileage for D8 mileage reps (one-time; re-run only
when an address changes).

PII handling:
  - Home addresses are NOT in this file. They load from .env as
    REP_HOME_<EID>="street, city, ST zip" (same .env as GOOGLE_MAPS_API).
  - Output files contain EID + miles only. Safe to commit.

4 origins x 11 D8 stores = 44 elements (~$0.22). Home->store directed;
the app mirrors values for the return leg.

Outputs (under data/):
  d8_home_to_store.json
  d8_home_to_store.csv

Usage:  python3 scripts/build_home_to_store.py
"""

import json
import csv
import os
import sys
import urllib.parse
import urllib.request

# EIDs and display names only — no PII. Add an EID here plus a matching
# REP_HOME_<EID> line in .env to onboard another mileage rep.
REPS = {
    "800553343": "Brian Campbell",
    "800605698": "Kimberly Claflin",
    "800627385": "James Duchene",
    "800619482": "Alexandra Wright",
}

D8_STORES = {
    19:  "801 Auburn Way N., Auburn, WA 98002",
    23:  "2041 148th N. E., Bellevue, WA 98007",
    28:  "14300 First Ave S., Burien, WA 98168",
    31:  "17801 108th Ave S. E., Renton, WA 98055",
    53:  "16735 S. E. 272nd St., Covington, WA 98042",
    111: "33702 21st Ave. S. W., Federal Way, WA 98023",
    215: "25250 Pacific Hwy. South, Kent, WA 98032",
    391: "12221 120th Ave. N. E., Kirkland, WA 98034",
    459: "365 Renton Center Way S. W., Renton, WA 98055",
    658: "6100 E. Lake Sammamish Pkwy. S. E., Issaquah, WA 98029",
    682: "26520 Maple Valley-Black Diamond Rd, Maple Valley, WA 98038",
}

METERS_PER_MILE = 1609.344


def load_env():
    """Walk up from this script's directory; return .env as a dict."""
    d = os.path.abspath(os.path.dirname(__file__))
    while True:
        env_path = os.path.join(d, ".env")
        if os.path.isfile(env_path):
            env = {}
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
            return env
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit("ERROR: no .env found up the tree.")
        d = parent


def get_config():
    env = load_env()
    key = env.get("GOOGLE_MAPS_API")
    if not key:
        sys.exit("ERROR: GOOGLE_MAPS_API missing from .env.")
    homes = {}
    missing = []
    for eid in REPS:
        addr = env.get(f"REP_HOME_{eid}")
        if addr:
            homes[eid] = addr
        else:
            missing.append(f"REP_HOME_{eid}  ({REPS[eid]})")
    if missing:
        sys.exit("ERROR: missing .env entries:\n  " + "\n  ".join(missing))
    return key, homes


def fetch(api_key, homes):
    store_nums = sorted(D8_STORES)
    eids = list(REPS)
    params = urllib.parse.urlencode({
        "origins": "|".join(homes[e] for e in eids),
        "destinations": "|".join(D8_STORES[n] for n in store_nums),
        "units": "imperial",
        "mode": "driving",
        "key": api_key,
    })
    url = f"https://maps.googleapis.com/maps/api/distancematrix/json?{params}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = json.load(resp)

    if data.get("status") != "OK":
        sys.exit(f"ERROR: API status {data.get('status')}: "
                 f"{data.get('error_message', 'no detail')}")

    result = {}
    problems = []
    for i, eid in enumerate(eids):
        result[eid] = {"name": REPS[eid], "miles": {}}
        for j, num in enumerate(store_nums):
            el = data["rows"][i]["elements"][j]
            if el.get("status") != "OK":
                problems.append(f"{REPS[eid]} -> store {num}: {el.get('status')}")
                continue
            result[eid]["miles"][str(num)] = round(
                el["distance"]["value"] / METERS_PER_MILE, 1)

    if problems:
        print("WARNING - unresolved legs (fix .env addresses and re-run):")
        for p in problems:
            print("  " + p)
    return store_nums, result


def write_outputs(store_nums, result):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    data_dir = os.path.join(root, "data")
    os.makedirs(data_dir, exist_ok=True)

    # EID + miles only. No addresses. Safe to commit.
    json_path = os.path.join(data_dir, "d8_home_to_store.json")
    csv_path = os.path.join(data_dir, "d8_home_to_store.csv")

    with open(json_path, "w") as f:
        json.dump({"units": "miles", "mode": "driving",
                   "source": "google_distance_matrix",
                   "reps": result}, f, indent=1)

    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rep\\store"] + store_nums)
        for eid, r in result.items():
            w.writerow([r["name"]] +
                       [r["miles"].get(str(n), "") for n in store_nums])

    print(f"Wrote {json_path} and {csv_path} "
          f"({sum(len(r['miles']) for r in result.values())} legs)")


if __name__ == "__main__":
    api_key, homes = get_config()
    store_nums, result = fetch(api_key, homes)
    write_outputs(store_nums, result)
