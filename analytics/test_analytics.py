import csv
import io
import json
import tempfile
import unittest
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import COOKIE, CV_PATH, create_app, password_hash

ADMIN_ORIGIN = "http://127.0.0.1:8100"
SITE_ORIGIN = "https://weiyeecon.github.io"
SECRET = "test-key-only-never-for-production" * 2
PASSWORD = "example-test-password-only"
UA = "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"


class AnalyticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = password_hash(PASSWORD)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = {
            "DATABASE_PATH": str(Path(self.directory.name) / "test.sqlite3"),
            "ANALYTICS_SECRET": SECRET,
            "ADMIN_PASSWORD_HASH": self.password,
            "PUBLIC_ORIGIN": ADMIN_ORIGIN,
            "SITE_ORIGINS": SITE_ORIGIN,
            "GEOIP_DATABASE": str(Path(self.directory.name) / "missing.mmdb"),
            "DEMO_MODE": "false",
        }
        self.app = create_app(self.config)
        self.client = TestClient(self.app, base_url=ADMIN_ORIGIN, client=("8.8.8.8", 40000))

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def login(self, password=PASSWORD, origin=ADMIN_ORIGIN):
        return self.client.post("/api/login", headers={"Origin": origin}, json={"password": password})

    def collect(self, path="/", kind="pageview", event_id=None, referrer="google.com", origin=SITE_ORIGIN, ua=UA, **extra):
        return self.client.post("/api/collect", headers={"Origin": origin, "User-Agent": ua}, json={
            "id": event_id or str(uuid.uuid4()), "kind": kind, "path": path, "referrer": referrer, **extra,
        })

    def stats(self, days=30):
        self.login()
        response = self.client.get(f"/api/stats?days={days}")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_data_and_dashboard_require_login(self):
        self.assertEqual(self.client.get("/api/stats").status_code, 401)
        self.assertEqual(self.client.get("/api/export").status_code, 401)
        self.assertIn("管理员密码", self.client.get("/").text)
        self.assertEqual(self.client.get("/static/dashboard.html").status_code, 404)
        self.assertEqual(self.client.get("/static/../app.py").status_code, 404)
        self.assertEqual(self.login().status_code, 204)
        self.assertIn("访问概览", self.client.get("/").text)

    def test_cookie_flags_logout_and_expiry(self):
        response = self.login()
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("SameSite=strict", response.headers["set-cookie"])
        self.assertEqual(self.client.post("/api/logout", headers={"Origin": "https://other.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/stats").status_code, 200)
        self.assertEqual(self.client.post("/api/logout", headers={"Origin": ADMIN_ORIGIN}).status_code, 204)
        self.assertEqual(self.client.get("/api/stats").status_code, 401)
        self.login()
        with self.app.state.database() as db:
            db.execute("UPDATE sessions SET expires = 0")
        self.assertEqual(self.client.get("/api/stats").status_code, 401)

    def test_production_cookie_secure_and_http_refused(self):
        app = create_app({**self.config, "PUBLIC_ORIGIN": "https://stats.example.org"})
        with TestClient(app, base_url="https://stats.example.org") as client:
            response = client.post("/api/login", headers={"Origin": "https://stats.example.org"}, json={"password": PASSWORD})
            self.assertIn("Secure", response.headers["set-cookie"])
            self.assertIn("max-age=", response.headers["strict-transport-security"])
        with self.assertRaises(RuntimeError):
            create_app({**self.config, "PUBLIC_ORIGIN": "http://stats.example.org"})

    def test_login_origin_and_rate_limit(self):
        self.assertEqual(self.login(origin=SITE_ORIGIN).status_code, 403)
        for _ in range(5):
            self.assertEqual(self.login(password="wrong").status_code, 401)
        self.assertEqual(self.login().status_code, 429)

    def test_collection_origin_path_and_body_limits(self):
        self.assertEqual(self.collect(origin="https://other.example").status_code, 403)
        self.assertEqual(self.collect(path="/research/?email=private").status_code, 400)
        self.assertEqual(self.collect(path=["/"]).status_code, 400)
        self.assertEqual(self.collect(referrer="https://google.com/?email=private").status_code, 400)
        self.assertEqual(self.collect(extra="x" * 5000).status_code, 413)
        self.assertEqual(self.client.post("/api/collect", content="invalid", headers={"Origin": SITE_ORIGIN}).status_code, 400)
        preflight = self.client.options("/api/collect", headers={"Origin": SITE_ORIGIN, "Access-Control-Request-Method": "POST"})
        self.assertEqual(preflight.headers["access-control-allow-origin"], SITE_ORIGIN)
        self.assertNotIn("access-control-allow-credentials", preflight.headers)

    def test_real_collection_deduplication_and_privacy(self):
        event_id = str(uuid.uuid4())
        self.assertEqual(self.collect(event_id=event_id).status_code, 204)
        self.assertEqual(self.collect(event_id=event_id).status_code, 204)
        self.assertEqual(self.collect(path="/research/", referrer="weiyeecon.github.io").status_code, 204)
        self.assertEqual(self.collect(path=CV_PATH, kind="cv_download").status_code, 204)
        data = self.stats()
        self.assertEqual(data["summary"]["views"], 2)
        self.assertEqual(data["summary"]["visitors"], 1)
        self.assertEqual(data["summary"]["downloads"], 1)
        self.assertEqual(data["summary"]["countries"], 0)
        self.assertFalse(data["meta"]["geoip_ready"])
        self.assertEqual({row["domain"] for row in data["referrers"]}, {"google.com", "Direct"})
        with self.app.state.database() as db:
            content = "\n".join(db.iterdump())
        self.assertNotIn("8.8.8.8", content)
        self.assertNotIn(UA, content)
        self.assertNotIn(PASSWORD, content)
        self.assertNotIn(self.client.cookies.get(COOKIE), content)
        self.assertNotIn("visitor", json.dumps(data["recent"]))

    def test_country_lookup_is_local(self):
        geo_path = Path(self.directory.name) / "test.mmdb"
        geo_path.touch()
        with patch("app.maxminddb.open_database") as reader:
            reader.return_value.get.return_value = {"country": {"iso_code": "US"}}
            app = create_app({**self.config, "GEOIP_DATABASE": str(geo_path)})
            with TestClient(app, base_url=ADMIN_ORIGIN, client=("8.8.8.8", 40000)) as client:
                response = client.post("/api/collect", headers={"Origin": SITE_ORIGIN, "User-Agent": UA, "X-Forwarded-For": "1.1.1.1"}, json={"id": str(uuid.uuid4()), "kind": "pageview", "path": "/", "referrer": ""})
                self.assertEqual(response.status_code, 204)
                reader.return_value.get.assert_called_once_with("8.8.8.8")
                client.post("/api/login", headers={"Origin": ADMIN_ORIGIN}, json={"password": PASSWORD})
                self.assertEqual(client.get("/api/stats").json()["countries"], [{"code": "US", "views": 1}])

    def test_bots_and_demo_do_not_count(self):
        self.assertEqual(self.collect(ua="Googlebot").status_code, 204)
        self.assertEqual(self.stats()["summary"]["views"], 0)
        app = create_app({**self.config, "DEMO_MODE": "true"})
        with TestClient(app, base_url=ADMIN_ORIGIN) as client:
            response = client.post("/api/collect", headers={"Origin": SITE_ORIGIN, "User-Agent": UA}, json={"id": str(uuid.uuid4()), "kind": "pageview", "path": "/", "referrer": ""})
            self.assertEqual(response.status_code, 204)
        self.assertEqual(self.stats()["summary"]["views"], 0)

    def test_daily_visits_windows_and_export(self):
        day = datetime.now(self.app.state.timezone).date()
        from datetime import timedelta
        yesterday = day - timedelta(days=1)
        last_period = day - timedelta(days=40)
        with self.app.state.database() as db:
            for n, date in enumerate((day, yesterday, last_period)):
                db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (str(n), str(date) + "T12:00:00+00:00", str(date), f"daily-{date}", "pageview", "/", "US", ""))
        data = self.stats()
        self.assertEqual(data["summary"]["views"], 2)
        self.assertEqual(data["summary"]["visitors"], 2)
        self.assertEqual(data["summary"]["previous_views"], 1)
        self.assertEqual(len(data["timeline"]), 30)
        self.assertEqual(data["timeline"][-1]["day"], str(day))
        exported = list(csv.DictReader(io.StringIO(self.client.get("/api/export").text)))
        self.assertEqual(len(exported), 30)
        self.assertEqual(sum(int(row["pageviews"]) for row in exported), 2)
        self.assertEqual(sum(int(row["daily_visits"]) for row in exported), 2)
        self.assertEqual(self.client.get("/api/stats?days=9999").status_code, 400)

    def test_no_default_credentials_and_security_headers(self):
        with self.assertRaises(RuntimeError):
            create_app({**self.config, "ANALYTICS_SECRET": ""})
        response = self.client.get("/")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-robots-tag"], "noindex, nofollow")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])

    def test_collection_rate_limit(self):
        for _ in range(60):
            self.assertEqual(self.collect().status_code, 204)
        self.assertEqual(self.collect().status_code, 429)


if __name__ == "__main__":
    unittest.main()
