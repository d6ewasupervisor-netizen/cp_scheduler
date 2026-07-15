#!/usr/bin/env python3
"""
Build the D8 store-to-store mileage matrix (one-time).

Reads GOOGLE_MAPS_API from .env in the same directory (or parent dirs),
pulls driving distances for all 11 D8 stores via chunked Distance Matrix
calls (11x11 = 121 elements, max 100 per request), and writes:

  d8_mileage_matrix.json  - directed miles, keyed "origin-dest" (app consumes)
  d8_mileage_matrix.csv   - human-readable grid for approval

Usage:  python3 scripts/build_d8_matrix.py
Re-running overwrites outputs. No third-party packages required.
"""

import json
import csv
import os
import sys
import urllib.parse
import urllib.request

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
MAX_ELEMENTS = 100


def load_api_key():
    d = os.path.abspath(os.path.dirname(__file__))
    while True:
        env_path = os.path.join(d, ".env")
        if os.path.isfile(env_path):
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GOOGLE_MAPS_API="):
                        key = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if key:
                            return key
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    sys.exit("ERROR: GOOGLE_MAPS_API not found in any .env up the tree.")


def fetch_chunk(api_key, origin_nums, dest_nums):
    params = urllib.parse.urlencode({
        "origins": "|".join(D8_STORES[n] for n in origin_nums),
        "destinations": "|".join(D8_STORES[n] for n in dest_nums),
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
    return data


def fetch_matrix(api_key):
    nums = sorted(D8_STORES)
    per_chunk = max(1, MAX_ELEMENTS // len(nums))  # origins per request
    matrix = {}
    problems = []

    for start in range(0, len(nums), per_chunk):
        origin_nums = nums[start:start + per_chunk]
        data = fetch_chunk(api_key, origin_nums, nums)
        for i, origin in enumerate(origin_nums):
            for j, dest in enumerate(nums):
                el = data["rows"][i]["elements"][j]
                if origin == dest:
                    matrix[f"{origin}-{dest}"] = 0.0
                    continue
                if el.get("status") != "OK":
                    problems.append(f"{origin}->{dest}: {el.get('status')}")
                    continue
                miles = round(el["distance"]["value"] / METERS_PER_MILE, 1)
                matrix[f"{origin}-{dest}"] = miles

    if problems:
        print("WARNING - unresolved pairs (fix addresses and re-run):")
        for p in problems:
            print("  " + p)
    return nums, matrix


def write_outputs(nums, matrix):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    data_dir = os.path.join(root, "data")
    os.makedirs(data_dir, exist_ok=True)

    out = {
        "units": "miles",
        "mode": "driving",
        "source": "google_distance_matrix",
        "stores": {str(n): D8_STORES[n] for n in nums},
        "matrix": matrix,
    }
    json_path = os.path.join(data_dir, "d8_mileage_matrix.json")
    csv_path = os.path.join(data_dir, "d8_mileage_matrix.csv")

    with open(json_path, "w") as f:
        json.dump(out, f, indent=1)

    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["from\\to"] + nums)
        for o in nums:
            w.writerow([o] + [matrix.get(f"{o}-{d}", "") for d in nums])

    print(f"Wrote {json_path} ({len(matrix)} directed pairs) "
          f"and {csv_path}")


if __name__ == "__main__":
    key = load_api_key()
    nums, matrix = fetch_matrix(key)
    write_outputs(nums, matrix)
