#!/usr/bin/env python3
"""One-off: sync auth env vars from eod-api Railway service to cp_scheduler."""
import json
import subprocess
import sys

EOD_DIR = r"C:\Users\tgaut\eod-api"
CP_DIR = r"C:\Users\tgaut\cp_scheduler"
CP_URL = "https://cpscheduler-production.up.railway.app"


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, shell=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip())
    return r.stdout


def main():
    eod = json.loads(run("railway variable list --service eod-api --json", EOD_DIR))
    jwt = eod["JWT_SECRET"]
    db = eod["DATABASE_URL"]

    origins = eod.get("ALLOWED_ORIGINS", "")
    if CP_URL not in origins:
        new_origins = f"{origins},{CP_URL}".strip(",") if origins else CP_URL
        run(f'railway variable set "ALLOWED_ORIGINS={new_origins}" --service eod-api', EOD_DIR)
        print("Updated eod-api ALLOWED_ORIGINS")

    pairs = [
        ("AUTH_MODE", "session"),
        ("PGSSL", "require"),
        ("CP_SCHEDULER_REP_EMAILS", "patricia.marks@youradv.com,bcampb9565@sbcglobal.net,kimberlyjanellclaf@gmail.com,james.duchene@retailodyssey.com,d6ewa.supervisor@gmail.com"),
        ("EOD_API_BASE_URL", "https://eod-api.the-dump-bin.com"),
        ("JWT_SECRET", jwt),
        ("DATABASE_URL", db),
    ]
    args = " ".join(f'"{k}={v}"' for k, v in pairs)
    run(f"railway variable set {args} --service cp_scheduler", CP_DIR)
    print("Set cp_scheduler auth variables")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
