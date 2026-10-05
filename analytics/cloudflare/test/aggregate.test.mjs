import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../dist/worker.js";
import privateWorker from "../dist/private-worker.js";
import { validateSummary } from "../export-report.mjs";
import { ADMIN, SITE, MIGRATION, SqliteD1, fixture as privateFixture, freeze, assertPrivate } from "./helpers.mjs";

const MIGRATION_AGGREGATE = readFileSync(new URL("../migrations/0002_public_aggregates.sql", import.meta.url), "utf8");
const AGGREGATE_TABLES = ["wa_aggregate_budget", "wa_aggregate_hours", "wa_aggregate_geography"];
const PRIVATE_TABLES = ["wa_events", "wa_sessions", "wa_limits", "wa_meta"];
const NY = { country: "US", regionCode: "NY", region: "New York", city: "Synthetic City" };
const EVENT = { id: "00000000-0000-4000-8000-000000000123", kind: "pageview", path: "/", referrer: "private-referrer.example.test" };

function fixture(t, overrides = {}, { legacy = false } = {}) {
  const db = new SqliteD1();
  if (legacy) db.sqlite.exec(MIGRATION);
  db.sqlite.exec(MIGRATION_AGGREGATE);
  t.after(() => db.sqlite.close());
  const env = {
    DB: db,
    AGGREGATE_MODE: "true",
    PUBLIC_ORIGIN: ADMIN,
    SITE_ORIGINS: SITE,
    ANALYTICS_TIMEZONE: "UTC",
    MAX_EVENTS_PER_DAY: "2000",
    ...overrides,
  };
  const h = {
    db,
    env,
    rows(sql, ...params) {
      return db.sqlite
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row }));
    },
    snapshot(tables = AGGREGATE_TABLES) {
      return Object.fromEntries(tables.map((table) => [table, h.rows(`SELECT * FROM ${table} ORDER BY rowid`)]));
    },
    async fetch(path, { method = "GET", headers = {}, body, cf, ...options } = {}) {
      const request = new Request(new URL(path, ADMIN), { method, headers, ...(body === undefined ? {} : { body }), ...options });
      if (cf !== undefined) Object.defineProperty(request, "cf", { value: cf });
      const tasks = [];
      const response = await worker.fetch(request, env, { waitUntil: (task) => tasks.push(task) });
      await Promise.all(tasks);
      return response;
    },
    collect(value = {}, { headers = {}, ...options } = {}) {
      return h.fetch("/api/collect", {
        method: "POST",
        headers: {
          Origin: SITE,
          "Content-Type": "text/plain;charset=UTF-8",
          "User-Agent": "Synthetic-browser",
          "CF-Connecting-IP": "192.0.2.123",
          ...headers,
        },
        body: JSON.stringify({ ...EVENT, ...value }),
        cf: NY,
        ...options,
      });
    },
    async summary() {
      const response = await h.fetch("/api/public-summary");
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    hour(day, hour, count) {
      db.sqlite.prepare("INSERT INTO wa_aggregate_hours VALUES (?, ?, ?)").run(day, hour, count);
    },
    geo(day, country, regionCode, region, city, count) {
      db.sqlite.prepare("INSERT INTO wa_aggregate_geography VALUES (?, ?, ?, ?, ?, ?)").run(day, country, regionCode, region, city, count);
    },
  };
  return h;
}

function seedLegacy(db) {
  db.sqlite.exec(`
    INSERT INTO wa_events VALUES ('private-event-id', '2020-01-01T12:34:56Z', '2020-01-01', 'private-visitor-id', 'pageview', '/private-path', 'US', 'NY', 'New York', 'Private City', 'private-referrer');
    INSERT INTO wa_sessions VALUES ('private-session-token', 1);
    INSERT INTO wa_limits VALUES ('private-rate-limit', 12, 1);
    INSERT INTO wa_meta VALUES ('private-meta-key', 'private-meta-value');
  `);
}

// All fixtures are synthetic. These tests execute real SQLite and the exact
// self-contained aggregate bundle that a user copies into Cloudflare.
test("aggregate migration works alone, repeats, and preserves all four private tables byte-for-byte", (t) => {
  const empty = fixture(t);
  assert.deepEqual(
    empty.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name),
    [...AGGREGATE_TABLES].sort()
  );
  const expectedColumns = {
    wa_aggregate_budget: ["day", "hits"],
    wa_aggregate_hours: ["day", "hour", "pageviews"],
    wa_aggregate_geography: ["day", "country", "region_code", "region", "city", "pageviews"],
  };
  for (const table of AGGREGATE_TABLES)
    assert.deepEqual(
      empty.rows(`PRAGMA table_info(${table})`).map((row) => row.name),
      expectedColumns[table]
    );
  empty.db.sqlite.exec(MIGRATION_AGGREGATE);
  assert.throws(() => empty.hour("2026-10-05", 24, 1), /CHECK/);
  assert.throws(() => empty.hour("2026-10-05", 1, -1), /CHECK/);
  const existing = fixture(t, {}, { legacy: true });
  seedLegacy(existing.db);
  const previous = existing.snapshot(PRIVATE_TABLES);
  const oldSchema = existing.rows("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'wa_aggregate_%' ORDER BY name");
  existing.db.sqlite.exec(MIGRATION_AGGREGATE);
  existing.db.sqlite.exec(MIGRATION_AGGREGATE);
  assert.deepEqual(existing.snapshot(PRIVATE_TABLES), previous);
  assert.deepEqual(existing.rows("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'wa_aggregate_%' ORDER BY name"), oldSchema);
});

test("default bundle is aggregate-only, has no imported assets or credential requirement", async (t) => {
  const source = readFileSync(new URL("../dist/worker.js", import.meta.url), "utf8");
  assert.equal(source, readFileSync(new URL("../src/aggregate-worker.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /^(?:import|const ASSETS)\b/m);
  assert.doesNotMatch(source, /ADMIN_PASSWORD_HASH|ANALYTICS_SECRET|wa_events|wa_sessions|wa_limits|wa_meta/);
  const h = fixture(t);
  assert.equal((await h.fetch("/health")).status, 200);
  assert.equal((await h.collect()).status, 204);
  assert.equal((await h.summary()).mode, "public_aggregate");
  assert.deepEqual(h.db.sessions, ["first-primary", "first-primary", "first-primary"]);
});

test("aggregate mode and HTTPS configuration fail closed without any secrets", async (t) => {
  const cases = [
    ["DB", undefined],
    ["AGGREGATE_MODE", undefined],
    ["AGGREGATE_MODE", true],
    ["AGGREGATE_MODE", "false"],
    ["AGGREGATE_MODE", "TRUE"],
    ["PUBLIC_ORIGIN", undefined],
    ["PUBLIC_ORIGIN", "http://analytics.example.test"],
    ["PUBLIC_ORIGIN", `${ADMIN}/`],
    ["PUBLIC_ORIGIN", `${ADMIN}/path`],
    ["PUBLIC_ORIGIN", "https://user:pass@analytics.example.test"],
    ["SITE_ORIGINS", undefined],
    ["SITE_ORIGINS", ""],
    ["SITE_ORIGINS", "http://homepage.example.test"],
    ["SITE_ORIGINS", `${SITE},`],
    ["SITE_ORIGINS", `${SITE}/path`],
    ["ANALYTICS_TIMEZONE", "Invalid/Timezone"],
    ["MAX_EVENTS_PER_DAY", "0"],
    ["MAX_EVENTS_PER_DAY", "5001"],
    ["MAX_EVENTS_PER_DAY", "1.5"],
    ["MAX_EVENTS_PER_DAY", "NaN"],
  ];
  for (const [key, value] of cases) {
    const h = fixture(t, { [key]: value });
    for (const path of ["/health", "/api/public-summary", "/", "/api/login"]) {
      const response = await h.fetch(path);
      assert.equal(response.status, 503, `${key}=${value}: ${path}`);
      assertPrivate(response);
      assert.doesNotMatch(await response.text(), /CREATE TABLE|SELECT .*FROM|Error:|stack/);
    }
    assert.equal((await h.collect()).status, 503);
    assert.deepEqual(h.snapshot(), Object.fromEntries(AGGREGATE_TABLES.map((table) => [table, []])));
  }
});

test("only explicit aggregate routes are reachable, even with a valid private-mode session", async (t) => {
  freeze(t);
  const prior = privateFixture(t);
  const cookie = await prior.session();
  assert.equal((await prior.fetch("/api/stats", { headers: { Cookie: cookie }, implementation: privateWorker })).status, 200);
  prior.db.sqlite.exec(MIGRATION_AGGREGATE);
  const env = { ...prior.env, AGGREGATE_MODE: "true" };
  const unavailable = [
    "/",
    "/dashboard",
    "/login",
    "/api/login",
    "/api/logout",
    "/api/stats",
    "/api/export",
    "/api/maintenance",
    "/api/events",
    "/static/dashboard.js",
    "/static/dashboard.css",
    "/static/login.js",
    "/favicon.ico",
  ];
  for (const path of unavailable)
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(ADMIN + path, { method, headers: { Cookie: cookie, Origin: ADMIN } }), env);
      assert.equal(response.status, 404, `${method} ${path}`);
      assertPrivate(response);
      assert.equal(response.headers.get("Set-Cookie"), null);
      assert.equal(await response.text(), JSON.stringify({ detail: "Not found." }));
    }
  const h = fixture(t);
  for (const [path, method] of [
    ["/health", "POST"],
    ["/api/public-summary", "POST"],
    ["/api/collect", "GET"],
    ["/api/collect", "PUT"],
    ["/api/public-summary", "OPTIONS"],
  ]) {
    assert.equal((await h.fetch(path, { method })).status, 404);
  }
  for (const path of [
    "/api/public-summary?days=1",
    "/api/public-summary?start=2020-01-01&end=2030-01-01",
    "/api/public-summary?group=city&hour=1",
    "/api/collect?debug=true",
    "/health?x=1",
  ]) {
    assert.equal((await h.fetch(path, { method: path.startsWith("/api/collect") ? "POST" : "GET" })).status, 400, path);
  }
  assert.equal((await h.fetch("https://wrong.example.test/health")).status, 403);
});

test("collection accepts the existing text/plain interface and stores only aggregate bucket counts", async (t) => {
  freeze(t, Date.parse("2026-10-05T16:45:31Z"));
  const h = fixture(t, {}, { legacy: true });
  seedLegacy(h.db);
  const privateBefore = h.snapshot(PRIVATE_TABLES);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await h.collect({
          visitor: "untrusted-visitor",
          ip: "203.0.113.99",
          country: "CA",
          city: "Untrusted City",
          created_at: "2020-01-01T01:02:03Z",
        })
      ).status,
      204
    );
  assert.deepEqual(h.snapshot(), {
    wa_aggregate_budget: [{ day: "2026-10-05", hits: 2 }],
    wa_aggregate_hours: [{ day: "2026-10-05", hour: 16, pageviews: 2 }],
    wa_aggregate_geography: [{ day: "2026-10-05", country: "US", region_code: "NY", region: "New York", city: "Synthetic City", pageviews: 2 }],
  });
  assert.deepEqual(h.snapshot(PRIVATE_TABLES), privateBefore);
  assert.doesNotMatch(
    JSON.stringify(h.snapshot()),
    /00000000-0000|192\.0\.2|203\.0\.113|untrusted|Untrusted|referrer|visitor|created_at|16:45:31|event_id|\/research|Synthetic-browser/
  );
  for (const path of ["/", "/research/", "/publications/", "/teaching/", "/cv/", "/404.html"]) assert.equal((await h.collect({ path })).status, 204);
  for (const value of [
    { kind: "login" },
    { path: "/secret" },
    { path: "/?private=1" },
    { path: "/research" },
    { kind: "cv_download", path: "/unexpected.pdf" },
  ])
    assert.equal((await h.collect(value)).status, 400);
});

test("DNT, GPC, bots and CV clicks consume no daily budget and persist no rows", async (t) => {
  const h = fixture(t);
  for (const headers of [
    { DNT: "1" },
    { "Sec-GPC": "1" },
    ...["Googlebot", "HeadlessChrome", "preview", "curl/8", "Wget", "facebookexternalhit"].map((ua) => ({ "User-Agent": ua })),
  ]) {
    assert.equal((await h.collect({}, { headers })).status, 204);
  }
  assert.equal((await h.collect({ kind: "cv_download", path: "/assets/pdf/CV_academic.pdf" })).status, 204);
  assert.deepEqual(h.snapshot(), Object.fromEntries(AGGREGATE_TABLES.map((table) => [table, []])));
});

test("collection and preflight require exact origins and never allow credentialed CORS", async (t) => {
  const h = fixture(t, { SITE_ORIGINS: `${SITE}, https://second.example.test` });
  for (const origin of ["https://homepage.example.test.evil.test", "http://homepage.example.test", `${SITE}/`, "null", "", ADMIN]) {
    const response = await h.collect({}, { headers: { Origin: origin } });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  for (const origin of [SITE, "https://second.example.test"]) {
    const response = await h.collect({}, { headers: { Origin: origin } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(response.headers.get("Vary"), "Origin");
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
    assert.equal(response.headers.get("Set-Cookie"), null);
    const preflight = await h.fetch("/api/collect", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,dnt,sec-gpc" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST");
    assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null);
  }
  for (const headers of [
    { Origin: SITE, "Access-Control-Request-Method": "GET" },
    { Origin: SITE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
    { Origin: ADMIN, "Access-Control-Request-Method": "POST" },
  ]) {
    assert.equal((await h.fetch("/api/collect", { method: "OPTIONS", headers })).status, 403);
  }
  const summary = await h.fetch("/api/public-summary", { headers: { Origin: SITE, Cookie: "unused-cookie" } });
  assert.equal(summary.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(summary.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(summary.headers.get("Set-Cookie"), null);
});

test("request bodies are bounded by actual streamed UTF-8 bytes and malformed input is rejected", async (t) => {
  const h = fixture(t);
  const headers = { Origin: SITE, "Content-Type": "text/plain" };
  for (const body of ["", "{", "null", "[]", "true", '"text"'])
    assert.equal((await h.fetch("/api/collect", { method: "POST", headers, body })).status, 400, body);
  assert.equal((await h.fetch("/api/collect", { method: "POST", headers, body: new Uint8Array([0xc3, 0x28]) })).status, 400);
  for (const extraHeaders of [{}, { "Content-Length": "1" }, { "Content-Length": "4097" }]) {
    const response = await h.fetch("/api/collect", {
      method: "POST",
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify({ ...EVENT, unused: "界".repeat(1600) }),
    });
    assert.equal(response.status, 413);
  }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2048).fill(32));
      controller.enqueue(new Uint8Array(2049).fill(32));
      controller.close();
    },
  });
  assert.equal((await h.fetch("/api/collect", { method: "POST", headers, body: stream, duplex: "half" })).status, 413);
  assert.deepEqual(h.snapshot(), Object.fromEntries(AGGREGATE_TABLES.map((table) => [table, []])));
});

test("real SQLite enforces the global atomic daily budget under concurrent requests and recovers the next UTC day", async (t) => {
  freeze(t, Date.parse("2026-10-05T23:59:59Z"));
  const h = fixture(t, { MAX_EVENTS_PER_DAY: "7", ANALYTICS_TIMEZONE: "America/New_York" });
  const responses = await Promise.all(
    Array.from({ length: 45 }, (_, i) =>
      h.collect({}, { cf: { ...NY, city: `Synthetic City ${i % 3}` }, headers: { "CF-Connecting-IP": `192.0.2.${i + 1}` } })
    )
  );
  assert.equal(responses.filter((r) => r.status === 204).length, 7);
  assert.equal(responses.filter((r) => r.status === 429).length, 38);
  assert.equal(h.rows("SELECT SUM(hits) AS n FROM wa_aggregate_budget")[0].n, 7);
  assert.equal(h.rows("SELECT SUM(pageviews) AS n FROM wa_aggregate_hours")[0].n, 7);
  assert.equal(h.rows("SELECT SUM(pageviews) AS n FROM wa_aggregate_geography")[0].n, 7);
  const before = h.snapshot();
  assert.equal((await h.collect()).status, 429);
  assert.deepEqual(h.snapshot(), before);
  t.mock.timers.setTime(Date.parse("2026-10-06T00:00:01Z"));
  assert.equal((await h.collect()).status, 204);
  assert.deepEqual(h.rows("SELECT * FROM wa_aggregate_budget ORDER BY day"), [
    { day: "2026-10-05", hits: 7 },
    { day: "2026-10-06", hits: 1 },
  ]);
  assert.deepEqual(h.rows("SELECT * FROM wa_aggregate_hours ORDER BY day, hour"), [
    { day: "2026-10-05", hour: 19, pageviews: 7 },
    { day: "2026-10-05", hour: 20, pageviews: 1 },
  ]);
});

test("real SQLite rolls back the budget and both counters on failures at every downstream write", async (t) => {
  freeze(t);
  for (const table of ["wa_aggregate_hours", "wa_aggregate_geography"]) {
    const h = fixture(t, { MAX_EVENTS_PER_DAY: "1" });
    h.db.sqlite.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic rollback test'); END;`);
    assert.equal((await h.collect()).status, 503);
    assert.deepEqual(h.snapshot(), Object.fromEntries(AGGREGATE_TABLES.map((table) => [table, []])));
    h.db.sqlite.exec("DROP TRIGGER synthetic_failure");
    assert.equal((await h.collect()).status, 204);
    assert.equal(h.rows("SELECT hits FROM wa_aggregate_budget")[0].hits, 1);
    assert.equal(h.rows("SELECT pageviews FROM wa_aggregate_hours")[0].pageviews, 1);
    assert.equal(h.rows("SELECT pageviews FROM wa_aggregate_geography")[0].pageviews, 1);
  }
});

test("public daily and hourly pageviews are zero-filled, range-limited and exclude the current hour", async (t) => {
  freeze(t, Date.parse("2026-10-05T16:37:42Z"));
  const h = fixture(t, {}, { legacy: true });
  seedLegacy(h.db);
  for (const row of [
    ["2026-09-05", 0, 999],
    ["2026-09-06", 23, 10],
    ["2026-09-28", 23, 20],
    ["2026-09-29", 0, 30],
    ["2026-10-04", 23, 40],
    ["2026-10-05", 0, 50],
    ["2026-10-05", 15, 60],
    ["2026-10-05", 16, 700],
    ["2026-10-05", 17, 800],
    ["2026-10-06", 0, 900],
  ])
    h.hour(...row);
  const response = await h.fetch("/api/public-summary");
  const data = await response.json();
  assert.deepEqual(data.period, { start: "2026-09-06", end: "2026-10-05" });
  assert.equal(data.as_of_hour, "2026-10-05T16");
  assert.equal(data.daily.length, 30);
  assert.equal(data.hourly.length, 6 * 24 + 16);
  assert.equal(data.total_pageviews, 210);
  assert.deepEqual(data.daily.at(-1), { day: "2026-10-05", pageviews: 110 });
  assert.deepEqual(data.daily[1], { day: "2026-09-07", pageviews: 0 });
  assert.deepEqual(data.hourly[0], { day: "2026-09-29", hour: 0, pageviews: 30 });
  assert.deepEqual(data.hourly.at(-1), { day: "2026-10-05", hour: 15, pageviews: 60 });
  assert.ok(data.hourly.every((row) => row.day < "2026-10-05" || row.hour < 16));
  assert.equal(
    data.hourly.reduce((sum, row) => sum + row.pageviews, 0),
    180
  );
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=1338");
  assert.doesNotMatch(JSON.stringify(data), /private-|visitor|event_id|created_at|referrer|ip_address|user_agent|session|16:37:42/);
  assert.deepEqual(Object.keys(data), [
    "schema_version",
    "mode",
    "timezone",
    "as_of_hour",
    "period",
    "metric",
    "total_pageviews",
    "daily",
    "hourly",
    "geography",
  ]);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("geography is independent completed-30-day totals, thresholded and rounded down without time intersections", async (t) => {
  freeze(t, Date.parse("2026-10-05T16:00:00Z"));
  const h = fixture(t);
  h.geo("2026-09-04", "GB", "ENG", "England", "Too Old", 500);
  h.geo("2026-09-05", "US", "NY", "New York", "Same City", 6);
  h.geo("2026-10-04", "US", "NY", "New York", "Same City", 3);
  h.geo("2026-10-04", "US", "CA", "California", "Same City", 14);
  h.geo("2026-10-04", "US", "TX", "Texas", "Rare City", 4);
  h.geo("2026-10-04", "US", "", "", "", 5);
  h.geo("2026-10-04", "CA", "ON", "Ontario", "Toronto", 5);
  h.geo("2026-10-04", "FR", "IDF", "Paris", "Paris", 4);
  h.geo("2026-10-04", "ZZ", "", "", "", 100);
  h.geo("2026-10-05", "DE", "BE", "Berlin", "Current Day", 500);
  h.geo("2026-10-06", "JP", "13", "Tokyo", "Future Day", 500);
  const data = await h.summary();
  assert.equal(data.total_pageviews, 0, "geography never depends on hourly rows or exposes their intersections");
  assert.deepEqual(data.geography.period, { start: "2026-09-05", end: "2026-10-04" });
  assert.equal(data.geography.minimum_count, 5);
  assert.equal(data.geography.rounding, 5);
  assert.deepEqual(data.geography.countries, [
    { country: "US", pageviews: 30 },
    { country: "CA", pageviews: 5 },
  ]);
  assert.deepEqual(data.geography.us_states, [
    { region_code: "CA", region: "California", pageviews: 10 },
    { region_code: "NY", region: "New York", pageviews: 5 },
  ]);
  assert.deepEqual(data.geography.cities, [
    { country: "US", region_code: "CA", region: "California", city: "Same City", pageviews: 10 },
    { country: "CA", region_code: "ON", region: "Ontario", city: "Toronto", pageviews: 5 },
    { country: "US", region_code: "NY", region: "New York", city: "Same City", pageviews: 5 },
  ]);
  for (const group of ["countries", "us_states", "cities"])
    for (const row of data.geography[group]) {
      assert.equal(row.pageviews % 5, 0);
      assert.ok(row.pageviews >= 5);
      assert.ok(!Object.hasOwn(row, "day") && !Object.hasOwn(row, "hour") && !Object.hasOwn(row, "timestamp"));
    }
});

test("missing and unknown Cloudflare geography never accepts client body geography", async (t) => {
  freeze(t);
  const h = fixture(t);
  for (const cf of [
    undefined,
    {},
    { country: "XX", city: "Unknown City", regionCode: "NY" },
    { country: "ZZ", city: "Unknown City" },
    { country: "us", city: "Unknown City" },
  ]) {
    assert.equal((await h.collect({ country: "US", regionCode: "NY", city: "Spoofed City" }, { cf })).status, 204);
  }
  assert.deepEqual(h.rows("SELECT * FROM wa_aggregate_geography"), [
    { day: "2026-10-05", country: "ZZ", region_code: "", region: "", city: "", pageviews: 5 },
  ]);
  t.mock.timers.setTime(Date.parse("2026-10-06T16:00:00Z"));
  const data = await h.summary();
  assert.deepEqual(data.geography.countries, []);
  assert.deepEqual(data.geography.us_states, []);
  assert.deepEqual(data.geography.cities, []);
});

test("New York midnight and repeated DST hours retain completed-hour semantics", async (t) => {
  freeze(t, Date.parse("2026-11-01T05:30:00Z"));
  const h = fixture(t, { ANALYTICS_TIMEZONE: "America/New_York" });
  assert.equal((await h.collect()).status, 204);
  t.mock.timers.setTime(Date.parse("2026-11-01T06:30:00Z"));
  assert.equal((await h.collect()).status, 204);
  assert.deepEqual(h.rows("SELECT * FROM wa_aggregate_hours"), [{ day: "2026-11-01", hour: 1, pageviews: 2 }]);
  let data = await h.summary();
  assert.equal(data.as_of_hour, "2026-11-01T01");
  assert.equal(data.total_pageviews, 0);
  assert.equal(data.hourly.at(-1).hour, 0);
  t.mock.timers.setTime(Date.parse("2026-11-01T07:00:00Z"));
  data = await h.summary();
  assert.equal(data.total_pageviews, 2);
  assert.deepEqual(data.hourly.at(-1), { day: "2026-11-01", hour: 1, pageviews: 2 });
  t.mock.timers.setTime(Date.parse("2026-11-02T05:00:00Z"));
  data = await h.summary();
  assert.equal(data.as_of_hour, "2026-11-02T00");
  assert.equal(data.daily.at(-1).pageviews, 0);
  assert.equal(data.hourly.length, 144);
});

test("scheduled retention deletes only old rows in aggregate-owned tables", async (t) => {
  freeze(t, Date.parse("2026-10-05T16:00:00Z"));
  const h = fixture(t, {}, { legacy: true });
  seedLegacy(h.db);
  const privateBefore = h.snapshot(PRIVATE_TABLES);
  for (const row of [
    ["2026-07-07", 0, 1],
    ["2026-07-08", 0, 2],
    ["2026-10-05", 16, 3],
  ])
    h.hour(...row);
  for (const day of ["2026-08-31", "2026-09-01", "2026-10-05"]) h.geo(day, "US", "NY", "New York", "Synthetic City", 5);
  for (const day of ["2026-10-01", "2026-10-02", "2026-10-05"]) h.db.sqlite.prepare("INSERT INTO wa_aggregate_budget VALUES (?, 1)").run(day);
  const tasks = [];
  await worker.scheduled({}, h.env, {
    waitUntil(task) {
      tasks.push(task);
    },
  });
  await Promise.all(tasks);
  assert.deepEqual(h.snapshot(PRIVATE_TABLES), privateBefore);
  assert.deepEqual(
    h.rows("SELECT day FROM wa_aggregate_hours ORDER BY day").map((row) => row.day),
    ["2026-07-08", "2026-10-05"]
  );
  assert.deepEqual(
    h.rows("SELECT day FROM wa_aggregate_geography ORDER BY day").map((row) => row.day),
    ["2026-09-01", "2026-10-05"]
  );
  assert.deepEqual(
    h.rows("SELECT day FROM wa_aggregate_budget ORDER BY day").map((row) => row.day),
    ["2026-10-02", "2026-10-05"]
  );
});

test("fractional-offset timezones expire public summaries at their own local-hour boundary", async (t) => {
  freeze(t, Date.parse("2026-10-05T16:37:42Z"));
  const h = fixture(t, { ANALYTICS_TIMEZONE: "Asia/Kathmandu" });
  const response = await h.fetch("/api/public-summary");
  const data = await response.json();
  assert.equal(data.as_of_hour, "2026-10-05T22");
  assert.equal(data.hourly.length, 6 * 24 + 22);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=2238");
  assert.doesNotThrow(() => validateSummary(data));
});

test("provider geography normalization stays compatible with strict exports after complete-day aggregation", async (t) => {
  freeze(t, Date.parse("2026-10-04T16:37:42Z"));
  const h = fixture(t);
  const locations = [
    { country: "US", regionCode: "NY", region: "", city: "Synthetic City" },
    { country: "US", regionCode: "CA", region: "California", city: "Synthetic City" },
    { country: "US", regionCode: "XX", region: "unknown", city: "N/A" },
    { country: "US", regionCode: "QQ", region: "(not set)", city: "?" },
    { country: "AA", regionCode: "AA", region: "Invalid Country", city: "Invalid City" },
    { country: "CA", regionCode: "ON", region: "Ont\u202eario", city: "Tor\u200bonto\u0085\u2028" },
    { country: "FR", regionCode: "IDF", region: "A".repeat(99) + " more", city: "B".repeat(99) + " more" },
  ];
  for (const cf of locations) for (let i = 0; i < 5; i++) assert.equal((await h.collect({}, { cf })).status, 204);
  t.mock.timers.setTime(Date.parse("2026-10-05T16:37:42Z"));
  const data = await h.summary();
  assert.equal(data.total_pageviews, 35);
  assert.equal(data.geography.us_states.length, 2);
  assert.equal(data.geography.cities.length, 4);
  assert.doesNotMatch(JSON.stringify(data.geography), /unknown|N\/A|not set|Invalid Country|Invalid City|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.ok(data.geography.cities.some((row) => row.city === "Toronto" && row.region === "Ontario"));
  assert.doesNotThrow(() => validateSummary(data));
  assert.deepEqual(validateSummary(data), data);
});

test("public geography limits each list to 100 cells and deterministically orders ties", async (t) => {
  freeze(t);
  const h = fixture(t);
  for (let i = 104; i >= 0; i--) h.geo("2026-10-04", "US", "NY", "New York", `Synthetic City ${String(i).padStart(3, "0")}`, 5);
  const data = await h.summary();
  assert.equal(data.geography.cities.length, 100);
  assert.equal(data.geography.cities[0].city, "Synthetic City 000");
  assert.equal(data.geography.cities.at(-1).city, "Synthetic City 099");
  assert.equal(data.geography.countries[0].pageviews, 525);
  assert.equal(data.geography.us_states[0].pageviews, 525);
  assert.doesNotThrow(() => validateSummary(data));
});
