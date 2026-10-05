import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { validateSummary } from "../export-report.mjs";

const ORIGIN = "https://analytics.example.test";
const SITE = "https://homepage.example.test";
const NOW = Date.parse("2026-10-05T16:37:42Z");
const TABLES = ["wa_aggregate_budget", "wa_aggregate_hours", "wa_aggregate_geography"];
const PRIVATE_TABLES = ["wa_events", "wa_sessions", "wa_limits", "wa_meta"];
const GEO = { country: "US", regionCode: "NY", region: "New York", city: "Synthetic City" };
const EVENT = { id: "00000000-0000-4000-8000-000000000123", kind: "pageview", path: "/", referrer: "synthetic-private-referrer.example.test" };
const compact = (sql) => sql.replace(/--[^\n]*\n/g, "").replace(/\n/g, " ");

async function runtime(t, { legacy = false, maximum = "2000" } = {}) {
  // Execute the exact production bundle, with only the clock made deterministic
  // in this test isolate. No production request hook or testing route is added.
  const source = await readFile(new URL("../dist/worker.js", import.meta.url), "utf8");
  const clock = `const RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [${NOW}])); }
      static now() { return ${NOW}; }
    };\n`;
  const mf = new Miniflare({
    modules: true,
    script: clock + source,
    compatibilityDate: "2026-08-01",
    cf: false,
    d1Databases: ["DB"],
    bindings: { AGGREGATE_MODE: "true", PUBLIC_ORIGIN: ORIGIN, SITE_ORIGINS: SITE, ANALYTICS_TIMEZONE: "UTC", MAX_EVENTS_PER_DAY: maximum },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  if (legacy) await db.exec(compact(await readFile(new URL("../migrations/0001_worker_analytics.sql", import.meta.url), "utf8")));
  const migration = compact(await readFile(new URL("../migrations/0002_public_aggregates.sql", import.meta.url), "utf8"));
  await db.exec(migration);
  const h = {
    mf,
    db,
    migration,
    async rows(sql, ...params) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all()
      ).results;
    },
    async snapshot(tables = TABLES) {
      return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await h.rows(`SELECT * FROM ${table} ORDER BY rowid`)])));
    },
    fetch(path, options = {}) {
      return mf.dispatchFetch(new URL(path, ORIGIN), options);
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
        cf: GEO,
        ...options,
      });
    },
  };
  return h;
}

const EMPTY = Object.fromEntries(TABLES.map((table) => [table, []]));

test("real workerd + D1: aggregate migration, public-only routes, trusted geography and no private-table writes", async (t) => {
  const h = await runtime(t, { legacy: true });
  await h.db.exec(
    "INSERT INTO wa_events VALUES ('private-event-id', '2020-01-01T12:34:56Z', '2020-01-01', 'private-visitor-id', 'pageview', '/private-path', 'US', 'NY', 'New York', 'Private City', 'private-referrer'); INSERT INTO wa_sessions VALUES ('private-session-token', 1); INSERT INTO wa_limits VALUES ('private-rate-limit', 12, 1); INSERT INTO wa_meta VALUES ('private-meta-key', 'private-meta-value');"
  );
  const before = await h.snapshot(PRIVATE_TABLES);
  await h.db.exec(h.migration);
  assert.deepEqual(await h.snapshot(PRIVATE_TABLES), before);
  assert.equal((await h.fetch("/health")).status, 200);
  for (const path of [
    "/",
    "/dashboard",
    "/login",
    "/api/login",
    "/api/logout",
    "/api/stats",
    "/api/export",
    "/api/maintenance",
    "/static/dashboard.js",
    "/static/dashboard.css",
  ]) {
    const response = await h.fetch(path, { headers: { Cookie: "__Host-wei_analytics_session=private-session-token" } });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Set-Cookie"), null);
    await response.arrayBuffer();
  }
  for (const path of ["/api/public-summary?days=1", "/api/public-summary?hour=16&city=Private%20City", "/api/collect?debug=true"])
    assert.equal((await h.fetch(path)).status, 400, path);
  assert.equal((await h.collect({}, { headers: { Origin: "https://homepage.example.test.attacker.test" } })).status, 403);
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }, { "User-Agent": "SyntheticBot" }])
    assert.equal((await h.collect({}, { headers })).status, 204);
  assert.equal((await h.collect({ kind: "cv_download", path: "/assets/pdf/CV_academic.pdf" })).status, 204);
  assert.deepEqual(await h.snapshot(), EMPTY);
  assert.equal((await h.collect({ unused: "x".repeat(5000) })).status, 413);
  const collected = await h.collect({ city: "Untrusted City", visitor: "untrusted-visitor", ip: "203.0.113.42" });
  assert.equal(collected.status, 204);
  assert.equal(collected.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(collected.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(collected.headers.get("Set-Cookie"), null);
  assert.deepEqual(await h.snapshot(), {
    wa_aggregate_budget: [{ day: "2026-10-05", hits: 1 }],
    wa_aggregate_hours: [{ day: "2026-10-05", hour: 16, pageviews: 1 }],
    wa_aggregate_geography: [{ day: "2026-10-05", country: "US", region_code: "NY", region: "New York", city: "Synthetic City", pageviews: 1 }],
  });
  assert.deepEqual(await h.snapshot(PRIVATE_TABLES), before);
  assert.doesNotMatch(JSON.stringify(await h.snapshot()), /event_id|visitor|referrer|192\.0\.2|203\.0\.113|Untrusted|16:37:42|private-|user_agent/);
});

test("real workerd + D1: changes() gates concurrent collection at a global cap with all counters equal", async (t) => {
  const h = await runtime(t, { maximum: "7" });
  assert.deepEqual(
    (await h.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wa_%' ORDER BY name")).map((row) => row.name),
    [...TABLES].sort()
  );
  const responses = await Promise.all(
    Array.from({ length: 45 }, (_, i) =>
      h.collect({}, { headers: { "CF-Connecting-IP": `192.0.2.${i + 1}` }, cf: { ...GEO, city: `Synthetic City ${i % 3}` } })
    )
  );
  const statuses = responses.map((response) => response.status);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  assert.equal(statuses.filter((status) => status === 204).length, 7, JSON.stringify(statuses));
  assert.equal(statuses.filter((status) => status === 429).length, 38, JSON.stringify(statuses));
  assert.equal((await h.rows("SELECT SUM(hits) AS n FROM wa_aggregate_budget"))[0].n, 7);
  assert.equal((await h.rows("SELECT SUM(pageviews) AS n FROM wa_aggregate_hours"))[0].n, 7);
  assert.equal((await h.rows("SELECT SUM(pageviews) AS n FROM wa_aggregate_geography"))[0].n, 7);
  const before = await h.snapshot();
  assert.equal((await h.collect()).status, 429);
  assert.deepEqual(await h.snapshot(), before);
});

test("real workerd + D1: failure of the third write rolls back both the budget and hour counter", async (t) => {
  const h = await runtime(t, { maximum: "1" });
  await h.db.exec(
    "CREATE TRIGGER synthetic_failure BEFORE INSERT ON wa_aggregate_geography BEGIN SELECT RAISE(ABORT, 'synthetic rollback test'); END;"
  );
  const failed = await h.collect();
  assert.equal(failed.status, 503);
  assert.equal(await failed.text(), JSON.stringify({ detail: "Aggregate backend temporarily unavailable." }));
  assert.deepEqual(await h.snapshot(), EMPTY);
  await h.db.exec("DROP TRIGGER synthetic_failure");
  assert.equal((await h.collect()).status, 204);
  assert.equal((await h.rows("SELECT hits FROM wa_aggregate_budget"))[0].hits, 1);
  assert.equal((await h.rows("SELECT pageviews FROM wa_aggregate_hours"))[0].pageviews, 1);
  assert.equal((await h.rows("SELECT pageviews FROM wa_aggregate_geography"))[0].pageviews, 1);
});

test("real workerd + D1: cached public summary is hourly delayed and compatible with the strict public exporter", async (t) => {
  const h = await runtime(t);
  await h.db.exec(
    "INSERT INTO wa_aggregate_hours VALUES ('2026-09-06', 0, 10), ('2026-10-04', 23, 25), ('2026-10-05', 15, 5), ('2026-10-05', 16, 999); INSERT INTO wa_aggregate_geography VALUES ('2026-10-04', 'US', 'NY', '', 'Same City', 9), ('2026-10-04', 'US', 'CA', 'California', 'Same City', 14), ('2026-10-04', 'FR', '', '', 'Rare City', 4), ('2026-10-04', 'ZZ', '', '', '', 999), ('2026-10-05', 'DE', 'BE', 'Berlin', 'Current Day', 999);"
  );
  const response = await h.fetch("/api/public-summary");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=1338");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(response.headers.get("Set-Cookie"), null);
  const data = await response.json();
  assert.equal(data.total_pageviews, 40);
  assert.equal(data.daily.length, 30);
  assert.equal(data.hourly.length, 160);
  assert.deepEqual(data.hourly.at(-1), { day: "2026-10-05", hour: 15, pageviews: 5 });
  assert.deepEqual(data.geography.countries, [{ country: "US", pageviews: 20 }]);
  assert.deepEqual(data.geography.cities, [
    { country: "US", region_code: "CA", region: "California", city: "Same City", pageviews: 10 },
    { country: "US", region_code: "NY", region: "", city: "Same City", pageviews: 5 },
  ]);
  assert.doesNotThrow(() => validateSummary(data));
  assert.doesNotMatch(JSON.stringify(data), /Rare City|Current Day|"ZZ"|999|event_id|visitor|referrer|created_at/);
  assert.deepEqual(await (await h.fetch("/api/public-summary")).json(), data);
  assert.equal((await h.fetch("/api/public-summary?cache-bypass=true")).status, 400);
});
