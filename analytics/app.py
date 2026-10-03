"""Private, self-hosted analytics for Wei Ye's academic website."""

import csv
import hashlib
import hmac
import io
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import maxminddb
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

ROOT = Path(__file__).parent
COOKIE = "wei_analytics_session"
BOT = re.compile(r"bot|spider|crawler|headless|preview|facebookexternalhit|curl|wget", re.I)
PATHS = {"/", "/research/", "/publications/", "/teaching/", "/cv/", "/404.html"}
CV_PATH = "/assets/pdf/CV_academic.pdf"


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600_000).hex()
    return f"pbkdf2_sha256$600000${salt}${digest}"


def verify_password(password, stored):
    try:
        algorithm, iterations, salt, digest = stored.split("$")
        if algorithm != "pbkdf2_sha256" or int(iterations) != 600_000:
            return False
        actual = password_hash(password, salt).rsplit("$", 1)[1]
        return hmac.compare_digest(actual, digest)
    except (ValueError, TypeError):
        return False


def create_app(settings=None):
    config = dict(os.environ)
    config.update(settings or {})
    secret = config.get("ANALYTICS_SECRET", "")
    stored_password = config.get("ADMIN_PASSWORD_HASH", "")
    public_origin = config.get("PUBLIC_ORIGIN", "http://127.0.0.1:8100").rstrip("/")
    site_origins = config.get("SITE_ORIGINS", "https://weiyeecon.github.io").split(",")
    site_origins = [value.strip().rstrip("/") for value in site_origins if value.strip()]
    secure = urlsplit(public_origin).scheme == "https"
    if len(secret) < 32 or not re.fullmatch(r"pbkdf2_sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}", stored_password):
        raise RuntimeError("Run manage.py init first; a secret and password hash are required.")
    if not secure and urlsplit(public_origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("The public admin address must use HTTPS.")
    db_path = Path(config.get("DATABASE_PATH", str(ROOT / "data/analytics.sqlite3")))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    tz = ZoneInfo(config.get("ANALYTICS_TIMEZONE", "America/New_York"))
    demo = config.get("DEMO_MODE", "false").lower() == "true"
    if demo and secure:
        raise RuntimeError("Demo mode is restricted to a loopback preview address.")
    geo_path = config.get("GEOIP_DATABASE", str(ROOT / "data/country.mmdb"))
    geo = maxminddb.open_database(geo_path) if Path(geo_path).is_file() else None
    limiter = defaultdict(deque)

    @contextmanager
    def database():
        with sqlite3.connect(db_path, timeout=10) as db:
            db.row_factory = sqlite3.Row
            yield db

    with database() as db:
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, day TEXT NOT NULL,
                visitor TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
                country TEXT NOT NULL, referrer TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS events_day ON events(day);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS login_attempts (visitor TEXT NOT NULL, attempted_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS attempts_time ON login_attempts(attempted_at);
        """)

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.database = database
    app.state.timezone = tz
    app.add_middleware(CORSMiddleware, allow_origins=site_origins, allow_methods=["POST"], allow_headers=["Content-Type"])

    def hashed(value):
        return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()

    def require_login(request):
        token = request.cookies.get(COOKIE, "")
        with database() as db:
            row = db.execute("SELECT expires FROM sessions WHERE token = ?", (hashed(token),)).fetchone()
        if not token or not row or row["expires"] <= time.time():
            raise HTTPException(401, "Please sign in.")

    def require_admin_origin(request):
        if request.headers.get("origin") != public_origin:
            raise HTTPException(403, "Origin not allowed.")

    async def body_json(request):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 4096:
                raise HTTPException(413, "Request too large.")
        try:
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(400, "Invalid JSON.")

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        })
        if secure:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.get("/health")
    def health():
        with database() as db:
            db.execute("SELECT 1")
        return {"ok": True}

    @app.post("/api/login")
    async def login(request: Request):
        require_admin_origin(request)
        client = hashed(request.client.host if request.client else "unknown")
        now = time.time()
        with database() as db:
            db.execute("DELETE FROM login_attempts WHERE attempted_at < ?", (now - 900,))
            attempts = db.execute("SELECT COUNT(*) FROM login_attempts WHERE visitor = ?", (client,)).fetchone()[0]
            if attempts >= 5:
                raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
            db.execute("INSERT INTO login_attempts VALUES (?, ?)", (client, now))
        value = await body_json(request)
        password = value.get("password", "")
        if not isinstance(password, str) or not verify_password(password, stored_password):
            raise HTTPException(401, "Incorrect password.")
        token = secrets.token_urlsafe(32)
        with database() as db:
            db.execute("DELETE FROM login_attempts WHERE visitor = ?", (client,))
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?)", (hashed(token), now + 43_200))
        response = Response(status_code=204)
        response.set_cookie(COOKIE, token, max_age=43_200, httponly=True, secure=secure, samesite="strict", path="/")
        return response

    @app.post("/api/logout")
    def logout(request: Request):
        require_admin_origin(request)
        with database() as db:
            db.execute("DELETE FROM sessions WHERE token = ?", (hashed(request.cookies.get(COOKIE, "")),))
        response = Response(status_code=204)
        response.delete_cookie(COOKIE, path="/", secure=secure, httponly=True, samesite="strict")
        return response

    @app.post("/api/collect", status_code=204)
    async def collect(request: Request):
        if request.headers.get("origin") not in site_origins:
            raise HTTPException(403, "Origin not allowed.")
        if demo or BOT.search(request.headers.get("user-agent", "")):
            return Response(status_code=204)
        ip = request.client.host if request.client else "unknown"
        now = datetime.now(timezone.utc)
        day = now.astimezone(tz).date().isoformat()
        key = hashed(day + ip)
        # Bounded, per-process abuse protection. Production runs one worker.
        if len(limiter) > 10_000:
            for old_key in list(limiter):
                if not limiter[old_key] or limiter[old_key][-1] < time.monotonic() - 60:
                    del limiter[old_key]
        queue = limiter[key]
        stamp = time.monotonic()
        while queue and queue[0] < stamp - 60:
            queue.popleft()
        if len(queue) >= 60 or len(limiter) > 10_000:
            raise HTTPException(429, "Request limit reached.")
        queue.append(stamp)
        value = await body_json(request)
        event_id, kind, path = value.get("id"), value.get("kind"), value.get("path")
        if not isinstance(event_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", event_id):
            raise HTTPException(400, "Invalid event ID.")
        if not isinstance(kind, str) or not isinstance(path, str):
            raise HTTPException(400, "Invalid event fields.")
        if not (kind == "pageview" and path in PATHS or kind == "cv_download" and path == CV_PATH):
            raise HTTPException(400, "Unknown event or path.")
        referrer = value.get("referrer", "")
        if not isinstance(referrer, str) or len(referrer) > 255:
            raise HTTPException(400, "Invalid referrer.")
        # Store domains only; query strings, full URLs, and raw IPs are never saved.
        referrer = referrer.lower().strip().rstrip(".")
        if referrer and not re.fullmatch(r"[a-z0-9.-]+", referrer):
            raise HTTPException(400, "Invalid referrer domain.")
        if referrer in {urlsplit(origin).hostname for origin in site_origins}:
            referrer = ""
        country = "ZZ"
        if geo:
            try:
                address = ipaddress.ip_address(ip)
                if address.is_global:
                    record = geo.get(str(address)) or {}
                    candidate = record.get("country", {}).get("iso_code", "ZZ")
                    if re.fullmatch(r"[A-Z]{2}", candidate):
                        country = candidate
            except ValueError:
                pass
        visitor = hashed(day + "|" + ip + "|" + request.headers.get("user-agent", "")[:512])
        with database() as db:
            db.execute("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (
                event_id, now.isoformat(), day, visitor, kind, path, country, referrer,
            ))
            cutoff = (now.astimezone(tz).date() - timedelta(days=365)).isoformat()
            db.execute("DELETE FROM events WHERE day < ?", (cutoff,))
        return Response(status_code=204)

    def date_range(days):
        if days not in {7, 30, 90}:
            raise HTTPException(400, "Choose 7, 30, or 90 days.")
        end = datetime.now(tz).date()
        start = end - timedelta(days=days - 1)
        return start, end

    @app.get("/api/stats")
    def stats(request: Request, days: int = 30):
        require_login(request)
        start, end = date_range(days)
        with database() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM events WHERE day BETWEEN ? AND ? ORDER BY created_at", (start.isoformat(), end.isoformat()))]
            previous_start = start - timedelta(days=days)
            previous_end = start - timedelta(days=1)
            previous = db.execute("SELECT COUNT(*) FROM events WHERE kind = 'pageview' AND day BETWEEN ? AND ?", (previous_start.isoformat(), previous_end.isoformat())).fetchone()[0]
        views = [row for row in rows if row["kind"] == "pageview"]
        countries, pages, referrers = {}, {}, {}
        timeline = { (start + timedelta(days=n)).isoformat(): {"views": 0, "visitors": set()} for n in range(days) }
        for row in views:
            timeline[row["day"]]["views"] += 1
            timeline[row["day"]]["visitors"].add(row["visitor"])
            countries[row["country"]] = countries.get(row["country"], 0) + 1
            page = pages.setdefault(row["path"], {"path": row["path"], "views": 0, "visitors": set()})
            page["views"] += 1
            page["visitors"].add(row["visitor"])
            source = row["referrer"] or "Direct"
            referrers[source] = referrers.get(source, 0) + 1
        for page in pages.values():
            page["visitors"] = len(page["visitors"])
        return {
            "meta": {"demo": demo, "timezone": str(tz), "geoip_ready": geo is not None, "site": site_origins[0], "updated_at": datetime.now(timezone.utc).isoformat(), "start": start.isoformat(), "end": end.isoformat()},
            "summary": {"views": len(views), "visitors": len({r["visitor"] for r in views}), "countries": len(set(countries) - {"ZZ"}), "downloads": sum(r["kind"] == "cv_download" for r in rows), "today": sum(r["day"] == end.isoformat() for r in views), "previous_views": previous},
            "timeline": [{"day": day, "views": data["views"], "visitors": len(data["visitors"])} for day, data in timeline.items()],
            "countries": [{"code": code, "views": count} for code, count in sorted(countries.items(), key=lambda item: -item[1])],
            "pages": sorted(pages.values(), key=lambda item: -item["views"]),
            "referrers": [{"domain": source, "views": count} for source, count in sorted(referrers.items(), key=lambda item: -item[1])],
            "recent": [{key: row[key] for key in ("created_at", "country", "kind", "path", "referrer")} for row in reversed(rows[-12:])],
        }

    @app.get("/api/export")
    def export(request: Request, days: int = 30):
        require_login(request)
        start, end = date_range(days)
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["day", "pageviews", "daily_visits", "cv_downloads"])
        with database() as db:
            rows = db.execute("""SELECT day,
                SUM(kind = 'pageview') AS views,
                COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN visitor END) AS visitors,
                SUM(kind = 'cv_download') AS downloads
                FROM events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day""", (start.isoformat(), end.isoformat())).fetchall()
        by_day = {row["day"]: row for row in rows}
        for n in range(days):
            day = (start + timedelta(days=n)).isoformat()
            row = by_day.get(day)
            writer.writerow([day, row["views"] if row else 0, row["visitors"] if row else 0, row["downloads"] if row else 0])
        return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="wei-ye-analytics-{end}.csv"'})

    @app.get("/")
    def dashboard(request: Request):
        try:
            require_login(request)
        except HTTPException:
            return FileResponse(ROOT / "web/login.html")
        return FileResponse(ROOT / "web/dashboard.html")

    @app.get("/static/{filename}")
    def asset(filename: str):
        if filename not in {"dashboard.css", "dashboard.js", "login.js"}:
            raise HTTPException(404, "Not found.")
        return FileResponse(ROOT / "web" / filename)

    return app


# A factory avoids initializing credentials/databases during management or tests.
