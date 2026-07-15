#!/usr/bin/env python3
"""Sync auth env vars from eod-api Railway service to cp_scheduler + set admin/rep roles."""
import json
import subprocess
import sys

EOD_DIR = r"C:\Users\tgaut\eod-api"
CP_DIR = r"C:\Users\tgaut\cp_scheduler"
CP_URL = "https://cpscheduler-production.up.railway.app"

ADMIN_EMAILS = ",".join(
    [
        "tyson.gauthier@retailodyssey.com",
        "d6ewa.supervisor@gmail.com",
        "tgauthier2011@gmail.com",
    ]
)

REP_EMAILS = ",".join(
    [
        "patricia.marks@youradv.com",
        "bcampb9565@sbcglobal.net",
        "kimberlyjanellclaf@gmail.com",
        "james.duchene@retailodyssey.com",
    ]
)


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, shell=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip())
    return r.stdout


def main():
    eod = json.loads(run("railway.cmd variable list --service eod-api --json", EOD_DIR))
    jwt = eod["JWT_SECRET"]
    db = eod["DATABASE_URL"]

    origins = eod.get("ALLOWED_ORIGINS", "") or ""
    if CP_URL not in origins:
        new_origins = f"{origins},{CP_URL}".strip(",") if origins else CP_URL
        run(f'railway.cmd variable set "ALLOWED_ORIGINS={new_origins}" --service eod-api', EOD_DIR)
        print("Updated eod-api ALLOWED_ORIGINS")

    # Ensure magic-link return hosts include CP (belt + suspenders with ALLOWED_ORIGINS)
    ml = eod.get("MAGIC_LINK_RETURN_HOSTS", "") or ""
    if "cpscheduler-production.up.railway.app" not in ml:
        new_ml = (
            f"{ml},cpscheduler-production.up.railway.app".strip(",")
            if ml
            else "cpscheduler-production.up.railway.app"
        )
        run(
            f'railway.cmd variable set "MAGIC_LINK_RETURN_HOSTS={new_ml}" --service eod-api',
            EOD_DIR,
        )
        print("Updated eod-api MAGIC_LINK_RETURN_HOSTS")

    pairs = [
        ("AUTH_MODE", "session"),
        ("PGSSL", "require"),
        ("CP_SCHEDULER_PUBLIC_URL", CP_URL),
        ("CP_SCHEDULER_ADMIN_EMAILS", ADMIN_EMAILS),
        ("CP_SCHEDULER_REP_EMAILS", REP_EMAILS),
        ("EOD_API_BASE_URL", "https://eod-api.the-dump-bin.com"),
        ("FRONTEND_BASE_URL", "https://the-dump-bin.com"),
        ("MAGIC_LINK_RETURN_HOSTS", "cpscheduler-production.up.railway.app,the-dump-bin.com"),
        ("JWT_SECRET", jwt),
        ("DATABASE_URL", db),
    ]
    # railway variable set accepts multiple KEY=value
    args = " ".join(f'"{k}={v}"' for k, v in pairs)
    run(f"railway.cmd variable set {args} --service cp_scheduler", CP_DIR)
    print("Set cp_scheduler auth + role variables")
    print("ADMIN:", ADMIN_EMAILS)
    print("REP:", REP_EMAILS)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
