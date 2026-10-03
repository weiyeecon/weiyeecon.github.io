"""Manage credentials, local preview data, and offline country lookup."""

import argparse
import gzip
import getpass
import json
import os
import secrets
import sqlite3
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from app import CV_PATH, create_app, password_hash

ROOT = Path(__file__).parent


def initialize(preview=False):
    destination = ROOT / (".env.preview" if preview else ".env")
    if destination.exists():
        raise SystemExit(f"{destination.name} already exists. Move it aside before initializing new credentials.")
    password = getpass.getpass("Set your admin password (at least 12 characters): ")
    if len(password) < 12 or password != getpass.getpass("Confirm password: "):
        raise SystemExit("Passwords must match and contain at least 12 characters.")
    origin = "http://127.0.0.1:8100" if preview else "https://stats.example.org"
    content = (
        f"ANALYTICS_DOMAIN=stats.example.org\nPUBLIC_ORIGIN={origin}\n"
        "SITE_ORIGINS=https://weiyeecon.github.io\nANALYTICS_TIMEZONE=America/New_York\n"
        f"ANALYTICS_SECRET={secrets.token_hex(32)}\nADMIN_PASSWORD_HASH='{password_hash(password)}'\n"
        f"DEMO_MODE={'true' if preview else 'false'}\n"
    )
    if preview:
        content += f"DATABASE_PATH={ROOT / 'data/preview.sqlite3'}\n"
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write(content)
    print(f"Created {destination.name}; no password or secret was printed. Keep this file private.")


def seed_demo():
    app = create_app()
    if os.environ.get("DEMO_MODE") != "true":
        raise SystemExit("Demo seeding requires DEMO_MODE=true and a loopback PUBLIC_ORIGIN.")
    with app.state.database() as db:
        if db.execute("SELECT COUNT(*) FROM events").fetchone()[0]:
            raise SystemExit("Database is not empty. Demo seeding never overwrites existing data.")
        today = datetime.now(app.state.timezone).replace(hour=12, minute=0, second=0, microsecond=0)
        paths = ["/", "/research/", "/research/", "/cv/", "/teaching/"]
        countries = ["US", "US", "US", "CN", "CA", "GB", "DE", "JP", "HK", "SG", "FR", "AU"]
        referrers = ["", "", "", "google.com", "scholar.google.com", "fordham.edu", "papers.ssrn.com", "github.com"]
        for n in range(90):
            day = today - timedelta(days=n)
            total = max(3, 9 + (90 - n) // 4 + (n * 13 % 17) - (7 if n % 7 in {0, 6} else 0))
            for i in range(total):
                moment = day.replace(hour=8 + i % 12, minute=(i * 17) % 60)
                visitor = f"demo-{day.date()}-{i // 2}"
                kind = "cv_download" if i % 11 == 10 else "pageview"
                db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (
                    secrets.token_hex(16), moment.isoformat(), day.date().isoformat(), visitor, kind,
                    CV_PATH if kind == "cv_download" else paths[i % len(paths)], countries[(i + n) % len(countries)], referrers[(i * 3 + n) % len(referrers)],
                ))
    print("Seeded clearly labeled demo data into an empty preview database.")


def download_geo(month):
    # No visitor IP is sent to this provider: a database is downloaded once.
    import re
    if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", month):
        raise SystemExit("Use a month such as 2026-10.")
    destination = ROOT / "data/country.mmdb"
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://download.db-ip.com/free/dbip-country-lite-{month}.mmdb.gz"
    request = urllib.request.Request(url, headers={"User-Agent": "WeiYeAnalytics/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        compressed = response.read(32 * 1024 * 1024 + 1)
    if len(compressed) > 32 * 1024 * 1024:
        raise SystemExit("Download exceeded the size limit.")
    temporary = destination.with_suffix(".tmp")
    temporary.write_bytes(gzip.decompress(compressed))
    import maxminddb
    with maxminddb.open_database(temporary) as reader:
        reader.get("8.8.8.8")
    temporary.replace(destination)
    (ROOT / "data/country-source.json").write_text(json.dumps({"provider": "DB-IP Lite", "license": "CC BY 4.0", "month": month, "url": url}, indent=2))
    print(f"Installed offline country database ({month}). IP addresses stay on your server.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    init = subcommands.add_parser("init")
    init.add_argument("--preview", action="store_true")
    subcommands.add_parser("seed-demo")
    geo = subcommands.add_parser("geoip")
    geo.add_argument("--month", default=datetime.now().strftime("%Y-%m"))
    subcommands.add_parser("backup")
    args = parser.parse_args()
    if args.command == "init":
        initialize(args.preview)
    elif args.command == "seed-demo":
        seed_demo()
    elif args.command == "geoip":
        download_geo(args.month)
    elif args.command == "backup":
        app = create_app()
        target = ROOT / "data" / f"backup-{datetime.now():%Y%m%d-%H%M%S}.sqlite3"
        target.parent.mkdir(parents=True, exist_ok=True)
        with app.state.database() as source, sqlite3.connect(target) as destination:
            source.backup(destination)
        print(f"Backup created: {target}")
