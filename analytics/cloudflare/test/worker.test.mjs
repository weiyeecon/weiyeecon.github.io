import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../dist/private-worker.js";
import {
  ADMIN,
  COOKIE,
  FROZEN_NOW,
  MIGRATION,
  PASSWORD,
  PASSWORD_HASH,
  SECRET,
  SITE,
  SqliteD1,
  assertPrivate,
  fixture,
  freeze,
  parseCsv,
  sign,
} from "./helpers.mjs";

const EVENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CV_PATH = "/assets/pdf/CV_academic.pdf";
const US_NY = { country: "US", regionCode: "NY", region: "New York", city: "New York" };

// Tests import exactly the copy-pastable build shipped to Cloudflare, and use a
// real SQLite execution engine. Fixtures contain no production credentials.
test("D1 adapter enforces SQLite constraints and transaction rollback", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    h.db.batch([
      h.db.prepare("INSERT INTO wa_meta (key, value) VALUES (?, ?)").bind("same", "first"),
      h.db.prepare("INSERT INTO wa_meta (key, value) VALUES (?, ?)").bind("same", "second"),
    ]),
    /UNIQUE/
  );
  assert.equal(h.count("wa_meta"), 0);
  await h.db.prepare("INSERT INTO wa_meta (key, value) VALUES (?, ?)").bind("key", "value").run();
  assert.equal(await h.db.prepare("SELECT value FROM wa_meta WHERE key = ?").bind("key").first("value"), "value");
});

test("migration is repeatable and preserves existing Python tables and data", (t) => {
  const db = new SqliteD1();
  t.after(() => db.sqlite.close());
  // Mirror the existing Python backend schema rather than mock table names.
  db.sqlite.exec(`
    CREATE TABLE events (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, day TEXT NOT NULL,
      visitor TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, country TEXT NOT NULL, referrer TEXT NOT NULL);
    CREATE INDEX events_day ON events(day);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, expires REAL NOT NULL);
    CREATE TABLE login_attempts (visitor TEXT NOT NULL, attempted_at REAL NOT NULL);
    CREATE INDEX attempts_time ON login_attempts(attempted_at);
    INSERT INTO events VALUES ('legacy-event', '2026-01-01T00:00:00Z', '2026-01-01', 'legacy-visitor', 'pageview', '/', 'US', 'example.test');
    INSERT INTO sessions VALUES ('legacy-session', 1900000000);
    INSERT INTO login_attempts VALUES ('legacy-attempt', 1700000000);
  `);
  const oldTables = ["events", "sessions", "login_attempts"];
  const previous = oldTables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const previousSchema = db.sqlite.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  db.sqlite.exec(MIGRATION);
  db.sqlite.exec("INSERT INTO wa_meta (key, value) VALUES ('sentinel', 'preserve-worker-data')");
  db.sqlite.exec(MIGRATION);
  oldTables.forEach((table, index) => assert.deepEqual(db.sqlite.prepare(`SELECT * FROM ${table}`).all(), previous[index]));
  for (const item of previousSchema) assert.deepEqual(db.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE name = ?").get(item.name), item);
  assert.equal(db.sqlite.prepare("SELECT value FROM wa_meta WHERE key = 'sentinel'").get().value, "preserve-worker-data");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 7);
  assert.throws(
    () =>
      db.sqlite.exec(
        "INSERT INTO wa_events (event_id, created_at, day, visitor, kind, path) VALUES ('bad', 'now', 'today', 'visitor', 'injected', '/')"
      ),
    /CHECK/
  );
});

test("deployment bundle is self-contained and does not embed test credentials", () => {
  const source = readFileSync(new URL("../dist/private-worker.js", import.meta.url), "utf8");
  assert.match(source, /const ASSETS = /);
  assert.doesNotMatch(source, /^\s*import\s/m);
  for (const secret of [PASSWORD, PASSWORD_HASH, SECRET]) assert.equal(source.includes(secret), false);
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.scheduled, "function");
});

test("all routes fail closed with missing or malformed configuration", async (t) => {
  const cases = [
    ["DB", undefined],
    ["PUBLIC_ORIGIN", undefined],
    ["PUBLIC_ORIGIN", "http://analytics.example.test"],
    ["PUBLIC_ORIGIN", `${ADMIN}/`],
    ["PUBLIC_ORIGIN", `${ADMIN}/path`],
    ["PUBLIC_ORIGIN", "https://name:secret@analytics.example.test"],
    ["SITE_ORIGINS", ""],
    ["SITE_ORIGINS", "http://homepage.example.test"],
    ["SITE_ORIGINS", `${SITE},`],
    ["SITE_ORIGINS", `${SITE}/path`],
    ["SITE_ORIGINS", `${SITE},https://other.example.test/`],
    ["ANALYTICS_SECRET", undefined],
    ["ANALYTICS_SECRET", "short"],
    ["ANALYTICS_SECRET", "G".repeat(64)],
    ["ADMIN_PASSWORD_HASH", undefined],
    ["ADMIN_PASSWORD_HASH", PASSWORD],
    ["ADMIN_PASSWORD_HASH", `sha256$${"z".repeat(64)}`],
    ["ANALYTICS_TIMEZONE", "No/Such_Timezone"],
    ["MAX_EVENTS_PER_DAY", "0"],
    ["MAX_EVENTS_PER_DAY", "5001"],
    ["MAX_EVENTS_PER_DAY", "1.5"],
    ["MAX_EVENTS_PER_DAY", "NaN"],
  ];
  for (const [key, value] of cases) {
    const h = fixture(t, { [key]: value });
    for (const path of ["/", "/health", "/api/stats", "/static/dashboard.js"]) {
      const response = await h.fetch(path);
      assert.equal(response.status, 503, `${key}=${value} at ${path}`);
      assertPrivate(response);
      assert.doesNotMatch(await response.text(), /CREATE TABLE|SELECT .*FROM|Error:|stack|synthetic/i);
    }
    assert.equal(h.count("wa_events"), 0);
    assert.equal(h.count("wa_sessions"), 0);
  }
});

test("canonical host and exact methods and paths are enforced", async (t) => {
  const h = fixture(t);
  for (const url of ["https://attacker.example.test/", "http://analytics.example.test/", "https://analytics.example.test:8443/health"]) {
    assert.equal((await h.fetch(url)).status, 403);
  }
  for (const [method, path] of [
    ["GET", "/api/login"],
    ["GET", "/api/collect"],
    ["POST", "/api/stats"],
    ["DELETE", "/api/logout"],
    ["OPTIONS", "/api/stats"],
    ["GET", "/static/worker.js"],
    ["GET", "/static/%2e%2e%2fworker.js"],
    ["GET", "/.env"],
    ["GET", "/api/export/"],
    ["GET", "/unknown"],
  ]) {
    const response = await h.fetch(path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
    assertPrivate(response);
  }
  assert.deepEqual(await (await h.fetch("/health")).json(), { ok: true });
});

test("anonymous visitors see login only; stats, exports and maintenance stay private", async (t) => {
  const h = fixture(t);
  h.seed({ city: "PRIVATE-SYNTHETIC-CITY" });
  const root = await h.fetch("/");
  assert.equal(root.status, 200);
  assertPrivate(root);
  const html = await root.text();
  assert.match(html, /id="login-form"/);
  assert.doesNotMatch(html, /PRIVATE-SYNTHETIC-CITY|dashboard-shell|synthetic-visitor/);
  for (const cookie of ["", `${COOKIE}=garbage`, `${COOKIE}=${"a".repeat(64)}`, `wrong_name=${"b".repeat(64)}`, `${COOKIE}=${"A".repeat(64)}`]) {
    for (const path of ["/api/stats", "/api/export", "/api/export?group=geography"]) {
      const response = await h.fetch(path, { headers: { Cookie: cookie, Origin: SITE } });
      assert.equal(response.status, 401);
      assertPrivate(response);
      assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
      assert.doesNotMatch(await response.text(), /PRIVATE-SYNTHETIC-CITY/);
    }
  }
  assert.equal((await h.fetch("/api/maintenance", { method: "POST", headers: { Origin: ADMIN } })).status, 401);
  for (const [name, type] of [
    ["dashboard.js", "text/javascript"],
    ["login.js", "text/javascript"],
    ["dashboard.css", "text/css"],
  ]) {
    const response = await h.fetch(`/static/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), new RegExp(type));
    assertPrivate(response);
  }
});

test("login requires the exact admin Origin and Cloudflare client address", async (t) => {
  const h = fixture(t);
  for (const origin of ["", SITE, "null", `${ADMIN}.attacker.test`, `${ADMIN}/`]) {
    assert.equal((await h.login({ headers: { Origin: origin } })).status, 403);
  }
  const response = await h.login({ ip: "", headers: { "X-Forwarded-For": "192.0.2.30", "X-Real-IP": "192.0.2.30" } });
  assert.equal(response.status, 503);
  assert.equal(h.count("wa_sessions"), 0);
  assert.equal(h.count("wa_limits"), 0);
});

test("wrong and human-chosen passwords fail, even when their hash is configured", async (t) => {
  const h = fixture(t);
  for (const password of ["human password", "a".repeat(42), "a".repeat(44), "=".repeat(43), 123, null, { value: PASSWORD }]) {
    const response = await h.login({ password, ip: `192.0.2.${40 + h.count("wa_limits")}` });
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("Set-Cookie"), false);
  }
  assert.equal(h.count("wa_sessions"), 0);
  const { createHash } = await import("node:crypto");
  h.env.ADMIN_PASSWORD_HASH = `sha256$${createHash("sha256").update("ordinary-human-password").digest("hex")}`;
  assert.equal((await h.login({ password: "ordinary-human-password", ip: "192.0.2.80" })).status, 401);
});

test("successful login issues a secure hashed session and private authenticated dashboard", async (t) => {
  freeze(t);
  const h = fixture(t);
  const response = await h.login();
  assert.equal(response.status, 204);
  assertPrivate(response);
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, new RegExp(`^${COOKIE}=[a-f0-9]{64};`));
  assert.match(setCookie, /; Path=\/;/);
  assert.match(setCookie, /; Max-Age=43200;/);
  assert.match(setCookie, /; HttpOnly;/);
  assert.match(setCookie, /; Secure;/);
  assert.match(setCookie, /; SameSite=Strict$/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  const cookie = setCookie.split(";", 1)[0];
  const token = cookie.split("=")[1];
  assert.deepEqual(h.rows("SELECT * FROM wa_sessions"), [{ token: sign(`session|${token}`), expires: FROZEN_NOW / 1000 + 43200 }]);
  const dashboard = await h.fetch("/", { headers: { Cookie: `irrelevant=value; ${cookie}` } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /dashboard-shell/);
  assert.equal((await h.fetch("/api/stats", { headers: { Cookie: cookie } })).status, 200);
  assert.equal(
    h.db.sessions.every((constraint) => constraint === "first-primary"),
    true
  );
  const stored = JSON.stringify(h.rows("SELECT * FROM wa_sessions"));
  for (const sensitive of [token, PASSWORD, "192.0.2.10", SECRET]) assert.equal(stored.includes(sensitive), false);
});

test("re-login rotates the session and logout immediately revokes it", async (t) => {
  const h = fixture(t);
  const first = await h.session();
  const second = await h.session({ headers: { Cookie: first } });
  assert.notEqual(first, second);
  assert.equal(h.count("wa_sessions"), 1);
  assert.equal((await h.fetch("/api/stats", { headers: { Cookie: first } })).status, 401);
  assert.equal((await h.fetch("/api/logout", { method: "POST", headers: { Origin: SITE, Cookie: second } })).status, 403);
  assert.equal(h.count("wa_sessions"), 1);
  const logout = await h.fetch("/api/logout", { method: "POST", headers: { Origin: ADMIN, Cookie: second } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("Set-Cookie"), /Max-Age=0; HttpOnly; Secure; SameSite=Strict/);
  assert.equal(h.count("wa_sessions"), 0);
  assert.equal((await h.fetch("/api/stats", { headers: { Cookie: second } })).status, 401);
  assert.equal((await h.fetch("/api/logout", { method: "POST", headers: { Origin: ADMIN, Cookie: second } })).status, 204);
});

test("session expiration is enforced at the exact expiry boundary", async (t) => {
  freeze(t);
  const h = fixture(t);
  const cookie = await h.session();
  t.mock.timers.setTime(FROZEN_NOW + 43200 * 1000 - 1);
  assert.equal((await h.fetch("/api/stats", { headers: { Cookie: cookie } })).status, 200);
  t.mock.timers.setTime(FROZEN_NOW + 43200 * 1000);
  for (const path of ["/api/stats", "/api/export"]) assert.equal((await h.fetch(path, { headers: { Cookie: cookie } })).status, 401);
  assert.match(await (await h.fetch("/", { headers: { Cookie: cookie } })).text(), /id="login-form"/);
});

test("login throttles share atomic counters across fresh worker instances", async (t) => {
  freeze(t);
  const h = fixture(t);
  const fresh = (await import(`../dist/private-worker.js?login-isolate=${crypto.randomUUID()}`)).default;
  for (let i = 0; i < 5; i++) {
    assert.equal((await h.login({ password: "wrong", implementation: i % 2 ? fresh : worker })).status, 401);
  }
  const denied = await h.login({ implementation: fresh });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("Retry-After"), "900");
  assert.equal(h.count("wa_sessions"), 0);
  assert.equal((await h.login({ ip: "192.0.2.11" })).status, 204);
  t.mock.timers.setTime(FROZEN_NOW + 901000);
  assert.equal((await h.login()).status, 204);
});

test("global login cap survives distributed IPs and stops at 100 attempts", async (t) => {
  freeze(t);
  const h = fixture(t);
  for (let i = 0; i < 100; i++) {
    assert.equal((await h.login({ password: "wrong", ip: `198.51.100.${i + 1}` })).status, 401);
  }
  assert.equal((await h.login({ ip: "203.0.113.1" })).status, 429);
  assert.equal(h.count("wa_sessions"), 0);
  assert.equal(h.rows("SELECT MAX(hits) AS maximum FROM wa_limits")[0].maximum, 100);
});

test("collection accepts exact configured origins and only narrow CORS preflights", async (t) => {
  const second = "https://other.example.test";
  const h = fixture(t, { SITE_ORIGINS: ` ${SITE}, ${second} ` });
  for (const origin of [SITE, second]) {
    const response = await h.collect({}, { headers: { Origin: origin } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(response.headers.get("Vary"), "Origin");
    assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
    const preflight = await h.fetch("/api/collect", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type, DNT, Sec-GPC" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST");
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  }
  for (const origin of ["", "null", `${SITE}/`, `${SITE}.attacker.test`, "http://homepage.example.test", ADMIN]) {
    const response = await h.collect({}, { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
  }
  for (const headers of [
    { "Access-Control-Request-Method": "DELETE" },
    { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization" },
    { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "CF-Connecting-IP" },
  ]) {
    assert.equal((await h.fetch("/api/collect", { method: "OPTIONS", headers: { Origin: SITE, ...headers } })).status, 403);
  }
  assert.equal(h.count("wa_events"), 2);
});

test("DNT, GPC and known bots skip parsing, geography and all storage", async (t) => {
  const h = fixture(t);
  for (const headers of [
    { DNT: "1" },
    { "Sec-GPC": "1" },
    { "User-Agent": "ExampleCrawler" },
    { "User-Agent": "HeadlessChrome/100" },
    { "User-Agent": "curl/8.0" },
    { "User-Agent": "facebookexternalhit" },
  ]) {
    const response = await h.collect({}, { headers: { ...headers, "CF-Connecting-IP": "" }, body: "not valid JSON" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
  for (const table of ["wa_events", "wa_limits", "wa_meta", "wa_sessions"]) assert.equal(h.count(table), 0);
  assert.equal((await h.collect({}, { headers: { DNT: "0", "Sec-GPC": "0", "User-Agent": "Mozilla/5.0" } })).status, 204);
  assert.equal(h.count("wa_events"), 1);
});

test("missing Cloudflare IP fails closed without trusting forwarded addresses", async (t) => {
  const h = fixture(t);
  const response = await h.collect(
    {},
    { headers: { "CF-Connecting-IP": "", "X-Forwarded-For": "192.0.2.1", "X-Real-IP": "192.0.2.1", "True-Client-IP": "192.0.2.1" } }
  );
  assert.equal(response.status, 503);
  assert.equal(h.count("wa_events"), 0);
  assert.equal(h.count("wa_limits"), 0);
});

test("text/plain beacon payloads record only allowlisted pageviews and CV downloads", async (t) => {
  const h = fixture(t);
  for (const path of ["/", "/research/", "/publications/", "/teaching/", "/cv/", "/404.html"]) {
    assert.equal((await h.collect({ path })).status, 204);
  }
  assert.equal((await h.collect({ kind: "cv_download", path: CV_PATH })).status, 204);
  assert.equal(h.count("wa_events"), 7);
  assert.equal(h.rows("SELECT COUNT(*) AS n FROM wa_events WHERE kind = 'cv_download'")[0].n, 1);
});

test("geography comes exclusively from request.cf, never JSON or client headers", async (t) => {
  const h = fixture(t);
  const response = await h.collect(
    { country: "CN", region: "Forged Region", city: "Forged City", geo: { country: "CN" }, cf: { country: "CN" } },
    {
      headers: { "CF-IPCountry": "CN", "X-Country": "CN", "X-Region": "Forged Region", "X-City": "Forged City" },
      cf: US_NY,
    }
  );
  assert.equal(response.status, 204);
  assert.deepEqual(h.rows("SELECT country, region_code, region, city FROM wa_events"), [
    { country: "US", region_code: "NY", region: "New York", city: "New York" },
  ]);
});

test("missing and invalid geography is explicitly unknown without fallback fabrication", async (t) => {
  const h = fixture(t);
  for (const cf of [
    undefined,
    {},
    { country: "XX" },
    { country: "T1" },
    { country: "ZZ", city: "Do not retain" },
    { country: "us", city: "Do not retain" },
    { country: "USA", region: "Do not retain" },
  ]) {
    assert.equal((await h.collect({ country: "US", city: "Spoofed" }, { cf, headers: { "CF-IPCountry": "US" } })).status, 204);
  }
  assert.deepEqual(h.rows("SELECT DISTINCT country, region_code, region, city FROM wa_events"), [
    { country: "ZZ", region_code: "", region: "", city: "" },
  ]);
  assert.equal((await h.collect({}, { cf: { country: "US" } })).status, 204);
  const cookie = await h.session();
  const stats = await h.stats(cookie);
  assert.equal(stats.summary.countries, 1);
  assert.equal(stats.countries.find((row) => row.code === "ZZ").views, 7);
  assert.match(stats.meta.geography_note, /[Aa]pproximate/);
  assert.match(stats.meta.geography_note, /[Cc]ounty/);
});

test("provider geography is bounded and stripped of control characters", async (t) => {
  const h = fixture(t);
  assert.equal(
    (await h.collect({}, { cf: { country: "US", regionCode: " N\u0000Y ", region: ` \u0001${"R".repeat(120)}\u007f `, city: " New\nYork\t " } }))
      .status,
    204
  );
  assert.deepEqual(h.rows("SELECT country, region_code, region, city FROM wa_events"), [
    { country: "US", region_code: "NY", region: "R".repeat(100), city: "NewYork" },
  ]);
  assert.equal((await h.collect({}, { cf: { country: "CA", regionCode: "invalid!", region: 123, city: {} } })).status, 204);
  assert.deepEqual(h.rows("SELECT region_code, region, city FROM wa_events WHERE country = 'CA'"), [{ region_code: "", region: "", city: "" }]);
});

test("same-name cities remain distinct across states and countries", async (t) => {
  const h = fixture(t);
  const places = [
    { country: "US", regionCode: "IL", region: "Illinois", city: "Springfield" },
    { country: "US", regionCode: "MA", region: "Massachusetts", city: "Springfield" },
    { country: "CA", regionCode: "NS", region: "Nova Scotia", city: "Springfield" },
  ];
  for (const cf of [...places, places[0]]) assert.equal((await h.collect({}, { cf })).status, 204);
  const stats = await h.stats(await h.session());
  assert.deepEqual(
    stats.cities.map(({ country, region_code, city, views }) => ({ country, region_code, city, views })),
    [
      { country: "US", region_code: "IL", city: "Springfield", views: 2 },
      { country: "CA", region_code: "NS", city: "Springfield", views: 1 },
      { country: "US", region_code: "MA", city: "Springfield", views: 1 },
    ]
  );
  assert.deepEqual(stats.us_states, [
    { code: "IL", name: "Illinois", views: 2 },
    { code: "MA", name: "Massachusetts", views: 1 },
  ]);
});

test("storage contains no raw IP, user agent, URL query or full referrer", async (t) => {
  freeze(t);
  const h = fixture(t);
  const ip = "203.0.113.123",
    ua = "Mozilla/5.0 SyntheticUniqueAgent/1",
    url = "https://search.example.test/private?token=RAW-REFERRER-TOKEN";
  const response = await h.collect(
    { path: "/research/", referrer: "SEARCH.EXAMPLE.TEST.", ip: "198.51.100.66", user_agent: ua, query: "RAW-BODY-QUERY" },
    {
      headers: { "CF-Connecting-IP": ip, "User-Agent": ua, Referer: url },
      cf: US_NY,
    }
  );
  assert.equal(response.status, 204);
  const row = h.rows("SELECT * FROM wa_events")[0];
  assert.equal(row.visitor, sign(`visitor|2026-10-05|${ip}`));
  assert.match(row.visitor, /^[a-f0-9]{64}$/);
  assert.equal(row.referrer, "search.example.test");
  assert.equal(row.path, "/research/");
  const dump = JSON.stringify(["wa_events", "wa_limits", "wa_meta", "wa_sessions"].map((table) => h.rows(`SELECT * FROM ${table}`)));
  for (const forbidden of [ip, "198.51.100.66", ua, url, "RAW-REFERRER-TOKEN", "RAW-BODY-QUERY", SECRET, PASSWORD])
    assert.equal(dump.includes(forbidden), false, forbidden);
  const columns = h.rows("PRAGMA table_info(wa_events)").map((column) => column.name);
  assert.deepEqual(columns, ["event_id", "created_at", "day", "visitor", "kind", "path", "country", "region_code", "region", "city", "referrer"]);
  assert.equal((await h.collect({ referrer: "homepage.example.test" })).status, 204);
  assert.equal(h.rows("SELECT referrer FROM wa_events WHERE referrer = ''").length, 1);
});

test("injected SQL, query strings, arbitrary paths and malformed identifiers are rejected", async (t) => {
  const h = fixture(t);
  const cases = [
    { id: "' OR 1=1; DROP TABLE wa_events; --" },
    { id: "" },
    { id: 123 },
    { kind: "click" },
    { kind: "pageview", path: CV_PATH },
    { kind: "cv_download", path: "/cv/" },
    { path: "/research/?email=private@example.test" },
    { path: "/research/#private" },
    { path: "https://homepage.example.test/" },
    { path: "/research/../cv/" },
    { path: "/research/%2e%2e/" },
    { path: "/research/\u0000" },
    { path: "/admin/" },
    { path: "'; DELETE FROM wa_events; --" },
    { referrer: "https://search.example.test/query?secret=1" },
    { referrer: "search.example.test/path" },
    { referrer: "search.example.test?query=1" },
    { referrer: "x'); DROP TABLE wa_events; --" },
    { referrer: "user@example.test" },
    { referrer: "=HYPERLINK('test')" },
    { referrer: "a".repeat(254) },
    { referrer: {} },
  ];
  for (const value of cases) assert.equal((await h.collect(value)).status, 400, JSON.stringify(value));
  assert.equal(h.count("wa_events"), 0);
  assert.equal(h.count("wa_limits"), 0);
  assert.equal(h.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wa_%'").length, 4);
});

test("JSON input is object-only, UTF-8 valid and bounded even without Content-Length", async (t) => {
  const h = fixture(t);
  for (const body of ["", "not-json", "null", "[]", "123", '"string"', "{}{}", new Uint8Array([0xff, 0xfe, 0xff])]) {
    assert.equal((await h.collect({}, { body })).status, 400);
  }
  const oversized = JSON.stringify({ id: EVENT_ID, kind: "pageview", path: "/", ignored: "x".repeat(4096) });
  assert.equal((await h.collect({}, { body: oversized })).status, 413);
  assert.equal((await h.collect({}, { headers: { "Content-Length": "5000" } })).status, 413);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(3000)));
      controller.enqueue(new TextEncoder().encode("x".repeat(2000)));
      controller.close();
    },
  });
  assert.equal((await h.collect({}, { body: stream, duplex: "half" })).status, 413);
  assert.equal(h.count("wa_events"), 0);
  assert.equal(h.count("wa_limits"), 0);
});

test("event IDs deduplicate case-insensitively without changing original content", async (t) => {
  const h = fixture(t);
  assert.equal((await h.collect({ id: EVENT_ID }, { cf: US_NY })).status, 204);
  const first = h.rows("SELECT * FROM wa_events")[0];
  assert.equal(
    (
      await h.collect(
        { id: EVENT_ID.toUpperCase(), path: "/cv/" },
        { cf: { country: "CA", city: "Changed" }, headers: { "CF-Connecting-IP": "192.0.2.99" } }
      )
    ).status,
    204
  );
  assert.equal(h.count("wa_events"), 1);
  assert.deepEqual(h.rows("SELECT * FROM wa_events")[0], first);
});

test("daily visitor HMAC is IP-only, changes each analytics day and remains stable across user agents", async (t) => {
  freeze(t);
  const h = fixture(t);
  for (const ua of ["Mozilla/5.0 Desktop", "Mozilla/5.0 Mobile"]) assert.equal((await h.collect({}, { headers: { "User-Agent": ua } })).status, 204);
  assert.equal(h.rows("SELECT COUNT(DISTINCT visitor) AS n FROM wa_events")[0].n, 1);
  t.mock.timers.setTime(FROZEN_NOW + 86400000);
  assert.equal((await h.collect()).status, 204);
  assert.equal(h.rows("SELECT COUNT(DISTINCT visitor) AS n FROM wa_events")[0].n, 2);
  const stats = await h.stats(await h.session());
  assert.equal(stats.summary.visitors, 2);
  assert.equal(stats.timeline.filter((day) => day.visitors === 1).length, 2);
  assert.match(stats.meta.visitor_method, /daily/i);
});

test("distributed collection global cap uses shared atomic SQLite counters", async (t) => {
  freeze(t);
  const h = fixture(t, { MAX_EVENTS_PER_DAY: "3" });
  const fresh = (await import(`../dist/private-worker.js?collect-isolate=${crypto.randomUUID()}`)).default;
  // Exercise the supported older D1 interface, with no withSession method.
  h.db.withSession = undefined;
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      h.collect({}, { headers: { "CF-Connecting-IP": `192.0.2.${i + 1}` }, implementation: i % 2 ? fresh : worker })
    )
  );
  assert.equal(responses.filter((response) => response.status === 204).length, 3);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
  assert.equal(h.count("wa_events"), 3);
  assert.equal(h.rows("SELECT MAX(hits) AS maximum FROM wa_limits")[0].maximum, 3);
  for (const response of responses.filter((item) => item.status === 429)) assertPrivate(response);
});

test("per-address collection cap stops 61st event and resets next minute", async (t) => {
  freeze(t);
  const h = fixture(t);
  for (let i = 0; i < 60; i++) assert.equal((await h.collect()).status, 204);
  assert.equal((await h.collect()).status, 429);
  assert.equal((await h.collect({}, { headers: { "CF-Connecting-IP": "198.51.100.1" } })).status, 204);
  assert.equal(h.count("wa_events"), 61);
  t.mock.timers.setTime(FROZEN_NOW + 61000);
  assert.equal((await h.collect()).status, 204);
});

test("daily event cap follows UTC quota windows independently of analytics timezone", async (t) => {
  freeze(t, Date.parse("2026-10-05T23:59:30.000Z"));
  const h = fixture(t, { ANALYTICS_TIMEZONE: "America/New_York", MAX_EVENTS_PER_DAY: "1" });
  assert.equal((await h.collect()).status, 204);
  t.mock.timers.setTime(Date.parse("2026-10-06T00:00:30.000Z"));
  assert.equal((await h.collect()).status, 204, "UTC midnight resets the documented Cloudflare daily quota");
  t.mock.timers.setTime(Date.parse("2026-10-06T04:00:30.000Z"));
  assert.equal((await h.collect()).status, 429, "local analytics midnight must not reset the UTC quota");
  assert.deepEqual(h.rows("SELECT day, COUNT(*) AS n FROM wa_events GROUP BY day ORDER BY day"), [{ day: "2026-10-05", n: 2 }]);
});

test("statistics aggregate real SQL over exact current and previous date ranges", async (t) => {
  freeze(t);
  const h = fixture(t);
  h.seed({ day: "2026-10-05", visitor: "day5-a", path: "/research/", referrer: "search.example.test" });
  h.seed({ day: "2026-10-05", visitor: "day5-a", path: "/research/" });
  h.seed({ day: "2026-10-05", visitor: "day5-b", country: "CA", region_code: "ON", region: "Ontario", city: "Toronto" });
  h.seed({ day: "2026-10-05", visitor: "day5-a", kind: "cv_download", path: CV_PATH });
  h.seed({ day: "2026-10-04", visitor: "day4-a", country: "ZZ", region_code: "", region: "", city: "" });
  h.seed({ day: "2026-09-29", visitor: "day29-a" });
  h.seed({ day: "2026-09-28", visitor: "previous1" });
  h.seed({ day: "2026-09-22", visitor: "previous2" });
  h.seed({ day: "2026-09-21", visitor: "too-old" });
  h.seed({ day: "2026-10-06", visitor: "future" });
  const cookie = await h.session();
  const stats = await h.stats(cookie);
  assert.deepEqual(stats.summary, { views: 5, visitors: 4, countries: 2, downloads: 1, today: 3, previous_views: 2 });
  assert.equal(stats.meta.start, "2026-09-29");
  assert.equal(stats.meta.end, "2026-10-05");
  assert.equal(stats.meta.demo, false);
  assert.equal(stats.meta.timezone, "UTC");
  assert.equal(stats.meta.geo_source, "Cloudflare request.cf");
  assert.equal(stats.timeline.length, 7);
  assert.deepEqual(stats.timeline[1], { day: "2026-09-30", views: 0, visitors: 0, downloads: 0 });
  assert.deepEqual(stats.timeline.at(-1), { day: "2026-10-05", views: 3, visitors: 2, downloads: 1 });
  assert.deepEqual(stats.countries, [
    { code: "US", views: 3 },
    { code: "CA", views: 1 },
    { code: "ZZ", views: 1 },
  ]);
  assert.deepEqual(stats.pages, [
    { path: "/", views: 3, visitors: 3 },
    { path: "/research/", views: 2, visitors: 1 },
  ]);
  assert.deepEqual(stats.referrers, [
    { domain: "Direct", views: 4 },
    { domain: "search.example.test", views: 1 },
  ]);
  assert.equal(stats.recent.length, 6);
  for (const event of stats.recent)
    assert.deepEqual(Object.keys(event), ["created_at", "country", "region_code", "region", "city", "kind", "path", "referrer"]);
  assert.doesNotMatch(JSON.stringify(stats), /synthetic-visitor|day5-a|previous1|too-old|future|event_id/);
});

test("empty statistics zero-fill all supported ranges and reject untrusted range values", async (t) => {
  freeze(t);
  const h = fixture(t);
  const cookie = await h.session();
  for (const days of [7, 30, 90]) {
    const stats = await h.stats(cookie, `days=${days}`);
    assert.deepEqual(stats.summary, { views: 0, visitors: 0, countries: 0, downloads: 0, today: 0, previous_views: 0 });
    assert.equal(stats.timeline.length, days);
    assert.equal(
      stats.timeline.every((row) => row.views === 0 && row.visitors === 0 && row.downloads === 0),
      true
    );
    for (const key of ["countries", "pages", "referrers", "us_states", "cities", "recent"]) assert.deepEqual(stats[key], []);
  }
  for (const value of ["1", "365", "-7", "7.0", "07", "7 OR 1=1", "7; DROP TABLE wa_events"]) {
    for (const route of ["stats", "export"])
      assert.equal((await h.fetch(`/api/${route}?days=${encodeURIComponent(value)}`, { headers: { Cookie: cookie } })).status, 400);
  }
  assert.equal((await h.stats(cookie, "")).timeline.length, 30);
});

test("dates and current-day counts honor configured timezone near midnight and DST", async (t) => {
  freeze(t, Date.parse("2026-11-01T03:30:00.000Z"));
  const h = fixture(t, { ANALYTICS_TIMEZONE: "America/New_York" });
  assert.equal((await h.collect()).status, 204);
  assert.equal(h.rows("SELECT day FROM wa_events")[0].day, "2026-10-31");
  const cookie = await h.session();
  let stats = await h.stats(cookie);
  assert.equal(stats.meta.end, "2026-10-31");
  assert.equal(stats.meta.start, "2026-10-25");
  t.mock.timers.setTime(Date.parse("2026-11-01T06:30:00.000Z"));
  assert.equal((await h.collect()).status, 204);
  stats = await h.stats(cookie);
  assert.equal(stats.meta.end, "2026-11-01");
  assert.equal(stats.meta.start, "2026-10-26");
  assert.equal(stats.timeline.length, 7);
  assert.equal(stats.summary.today, 1);
  assert.equal(stats.summary.views, 2);
});

test("daily CSV has UTF-8 BOM, zero-filled calendar dates and only aggregated columns", async (t) => {
  freeze(t);
  const h = fixture(t);
  h.seed({ visitor: "SENSITIVE-ID-1" });
  h.seed({ visitor: "SENSITIVE-ID-1", path: "/research/" });
  h.seed({ visitor: "SENSITIVE-ID-1", kind: "cv_download", path: CV_PATH });
  const cookie = await h.session();
  const response = await h.fetch("/api/export?days=7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.match(response.headers.get("Content-Type"), /^text\/csv; charset=utf-8$/);
  assert.match(response.headers.get("Content-Disposition"), /attachment; filename="wei-ye-analytics-daily-2026-10-05.csv"/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  const rows = parseCsv(text);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], ["day", "pageviews", "daily_visits", "cv_downloads"]);
  assert.deepEqual(rows[1], ["2026-09-29", "0", "0", "0"]);
  assert.deepEqual(rows.at(-1), ["2026-10-05", "2", "1", "1"]);
  assert.doesNotMatch(text, /SENSITIVE-ID|visitor|event_id|192\.0\.2/);
});

test("geography CSV preserves state and country identities, unknown labels and CSV formula safety", async (t) => {
  freeze(t);
  const h = fixture(t);
  const dangerous = ['=HYPERLINK("https://example.test","bad")', "+SUM(1,1)", "-1+1", "@SUM(1,1)", "\t=1+1", "\r=1+1", "\n=1+1"];
  for (const city of dangerous) h.seed({ city, region: 'Quoted "Region", name', region_code: "NY" });
  h.seed({ country: "ZZ", region_code: "", region: "", city: "" });
  h.seed({ country: "US", region_code: "IL", region: "Illinois", city: "Springfield" });
  h.seed({ country: "US", region_code: "MA", region: "Massachusetts", city: "Springfield" });
  h.seed({ kind: "cv_download", path: CV_PATH, city: "DO-NOT-EXPORT-CV" });
  const cookie = await h.session();
  const response = await h.fetch("/api/export?group=geography&days=7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assertPrivate(response);
  const text = await response.text();
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ["start", "end", "country", "region_code", "region", "city", "pageviews", "location_accuracy"]);
  assert.equal(rows.length, 11);
  for (const city of dangerous)
    assert.equal(
      rows.some((row) => row[5] === `'${city}`),
      true,
      city
    );
  assert.equal(
    rows.some((row) => row[4] === 'Quoted "Region", name'),
    true
  );
  assert.equal(rows.filter((row) => row[5] === "Springfield").length, 2);
  const unknown = rows.find((row) => row[2] === "ZZ");
  assert.deepEqual(unknown.slice(3, 6), ["Unknown", "Unknown", "Unknown"]);
  assert.equal(
    rows.slice(1).every((row) => row[0] === "2026-09-29" && row[1] === "2026-10-05" && /county unavailable/.test(row[7])),
    true
  );
  assert.doesNotMatch(text, /DO-NOT-EXPORT-CV|visitor|event_id/);
  assert.equal((await h.fetch("/api/export?group=raw", { headers: { Cookie: cookie } })).status, 400);
});

test("geography detail is bounded and CSV refuses more than 10,000 groups", async (t) => {
  freeze(t);
  const h = fixture(t);
  h.db.sqlite.exec("BEGIN");
  for (let i = 0; i < 10001; i++) h.seed({ city: `Synthetic City ${String(i).padStart(5, "0")}` });
  h.db.sqlite.exec("COMMIT");
  const cookie = await h.session();
  const stats = await h.stats(cookie);
  assert.equal(stats.summary.views, 10001);
  assert.equal(stats.cities.length, 100);
  assert.equal(stats.recent.length, 12);
  const response = await h.fetch("/api/export?group=geography&days=7", { headers: { Cookie: cookie } });
  assert.equal(response.status, 413);
  assert.match((await response.json()).detail, /10,000/);
});

test("opportunistic cleanup keeps the full 365-day boundary and removes expired sessions and counters", async (t) => {
  freeze(t);
  const h = fixture(t);
  h.seed({ day: "2025-10-05", city: "delete-old" });
  h.seed({ day: "2025-10-06", city: "keep-boundary" });
  h.seed({ day: "2026-10-05", city: "keep-current" });
  h.db.sqlite.exec(
    `INSERT INTO wa_sessions VALUES ('expired', ${FROZEN_NOW / 1000}), ('active', ${FROZEN_NOW / 1000 + 1}); INSERT INTO wa_limits VALUES ('expired', 1, ${FROZEN_NOW / 1000}), ('active', 1, ${FROZEN_NOW / 1000 + 1})`
  );
  assert.equal((await h.collect()).status, 204);
  assert.deepEqual(h.rows("SELECT city FROM wa_events WHERE city != '' ORDER BY day"), [{ city: "keep-boundary" }, { city: "keep-current" }]);
  assert.deepEqual(h.rows("SELECT token FROM wa_sessions"), [{ token: "active" }]);
  assert.equal(h.rows("SELECT COUNT(*) AS n FROM wa_limits WHERE bucket = 'expired'")[0].n, 0);
  assert.equal(h.rows("SELECT value FROM wa_meta WHERE key = 'cleanup_day'")[0].value, "2026-10-05");
  h.seed({ day: "2025-10-05", city: "not-cleaned-twice" });
  assert.equal((await h.collect()).status, 204);
  assert.equal(h.rows("SELECT COUNT(*) AS n FROM wa_events WHERE city = 'not-cleaned-twice'")[0].n, 1);
});

test("authenticated maintenance and scheduled cleanup work even without site traffic", async (t) => {
  freeze(t);
  const h = fixture(t);
  const cookie = await h.session();
  h.seed({ day: "2020-01-01" });
  assert.equal((await h.fetch("/api/maintenance", { method: "POST", headers: { Origin: SITE, Cookie: cookie } })).status, 403);
  assert.equal(h.count("wa_events"), 1);
  const maintenance = await h.fetch("/api/maintenance", { method: "POST", headers: { Origin: ADMIN, Cookie: cookie } });
  assert.equal(maintenance.status, 200);
  assert.deepEqual(await maintenance.json(), { ok: true });
  assert.equal(h.count("wa_events"), 0);
  h.seed({ day: "2020-01-01" });
  const pending = [];
  await worker.scheduled({}, h.env, { waitUntil: (task) => pending.push(task) });
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(h.count("wa_events"), 0);
  assert.equal(h.count("wa_sessions"), 1);
});

test("cleanup bounds per-run deletes and can continue on another scheduled run", async (t) => {
  freeze(t);
  const h = fixture(t);
  h.db.sqlite.exec("BEGIN");
  for (let i = 0; i < 5001; i++) h.seed({ day: "2020-01-01" });
  h.db.sqlite.exec("COMMIT");
  const pending = [];
  await worker.scheduled({}, h.env, { waitUntil: (task) => pending.push(task) });
  await Promise.all(pending);
  assert.equal(h.count("wa_events"), 1);
  const next = [];
  await worker.scheduled({}, h.env, { waitUntil: (task) => next.push(task) });
  await Promise.all(next);
  assert.equal(h.count("wa_events"), 0);
});

test("database failures expose a generic error and never private SQL or parameters", async (t) => {
  const h = fixture(t);
  const cookie = await h.session();
  h.db.sqlite.exec("DROP TABLE wa_events");
  const response = await h.fetch("/api/stats", { headers: { Cookie: cookie } });
  assert.equal(response.status, 503);
  assertPrivate(response);
  assert.deepEqual(await response.json(), { detail: "Backend temporarily unavailable." });
});

test("simultaneous valid logins cannot race past the per-address limit", async (t) => {
  freeze(t);
  const h = fixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.login()));
  assert.equal(responses.filter((response) => response.status === 204).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 7);
  assert.equal(h.count("wa_sessions"), 5);
  const cookies = responses.filter((response) => response.status === 204).map((response) => response.headers.get("Set-Cookie").split(";", 1)[0]);
  assert.equal(new Set(cookies).size, 5);
  for (const cookie of cookies) assert.equal((await h.fetch("/api/stats", { headers: { Cookie: cookie } })).status, 200);
});

test("simultaneous duplicate events insert one row while consuming the request quota", async (t) => {
  freeze(t);
  const h = fixture(t, { MAX_EVENTS_PER_DAY: "8" });
  const fresh = (await import(`../dist/private-worker.js?dedup-isolate=${crypto.randomUUID()}`)).default;
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => h.collect({ id: EVENT_ID }, { implementation: i % 2 ? fresh : worker })));
  assert.equal(
    responses.every((response) => response.status === 204),
    true
  );
  assert.equal(h.count("wa_events"), 1);
  assert.equal((await h.collect()).status, 429);
  assert.equal(h.rows("SELECT MAX(hits) AS maximum FROM wa_limits")[0].maximum, 8);
});

test("rotating the signing secret immediately invalidates old sessions", async (t) => {
  freeze(t);
  const h = fixture(t);
  const cookie = await h.session();
  h.env.ANALYTICS_SECRET = "1".repeat(64); // Different, unmistakably synthetic key.
  assert.equal((await h.fetch("/api/stats", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await h.fetch("/api/export", { headers: { Cookie: cookie } })).status, 401);
  const replacement = await h.session();
  assert.notEqual(cookie, replacement);
  assert.equal((await h.fetch("/api/stats", { headers: { Cookie: replacement } })).status, 200);
});
