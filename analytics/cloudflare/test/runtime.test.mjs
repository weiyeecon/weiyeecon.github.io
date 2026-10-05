import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

// Clearly synthetic test credentials. Never use these values for a deployment.
const password = "TEST_ONLY_DO_NOT_DEPLOY_".padEnd(43, "x");
const origin = "https://analytics.example";
test("real workerd + D1: authenticated analytics, trusted geography, CORS and revocation", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/private-worker.js", import.meta.url)),
    compatibilityDate: "2026-08-01",
    cf: false,
    d1Databases: ["DB"],
    bindings: {
      PUBLIC_ORIGIN: origin,
      SITE_ORIGINS: "https://weiyeecon.github.io",
      ANALYTICS_SECRET: "0".repeat(64),
      ADMIN_PASSWORD_HASH: `sha256$${createHash("sha256").update(password).digest("hex")}`,
    },
  });
  try {
    const db = await mf.getD1Database("DB");
    const sql = await readFile(new URL("../migrations/0001_worker_analytics.sql", import.meta.url), "utf8");
    await db.exec(sql.replace(/--[^\n]*\n/g, "").replace(/\n/g, " "));
    assert.equal((await mf.dispatchFetch(`${origin}/health`)).status, 200);
    for (const path of ["/api/stats", "/api/export?group=geography"]) assert.equal((await mf.dispatchFetch(origin + path)).status, 401);
    assert.match(await (await mf.dispatchFetch(origin)).text(), /login-form/);
    const collect = () =>
      mf.dispatchFetch(`${origin}/api/collect`, {
        method: "POST",
        headers: {
          Origin: "https://weiyeecon.github.io",
          "CF-Connecting-IP": "192.0.2.8",
          "User-Agent": "Synthetic-browser",
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000008", kind: "pageview", path: "/", referrer: "example.org", city: "untrusted" }),
        cf: { country: "US", regionCode: "NY", region: "New York", city: "New York" },
      });
    const collected = await collect();
    assert.equal(collected.status, 204);
    assert.equal(collected.headers.get("Access-Control-Allow-Origin"), "https://weiyeecon.github.io");
    assert.equal(collected.headers.get("Access-Control-Allow-Credentials"), null);
    assert.equal((await collect()).status, 204);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM wa_events").first()).n, 1);
    const login = await mf.dispatchFetch(`${origin}/api/login`, {
      method: "POST",
      headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.9", "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("Set-Cookie").split(";")[0];
    const stats = await mf.dispatchFetch(`${origin}/api/stats?days=7`, { headers: { Cookie: cookie } });
    assert.equal(stats.status, 200);
    const result = await stats.json();
    assert.equal(result.summary.views, 1);
    assert.equal(result.summary.visitors, 1);
    assert.equal(result.timeline.length, 7);
    assert.deepEqual(result.us_states, [{ code: "NY", name: "New York", views: 1 }]);
    assert.equal(result.cities[0].city, "New York");
    assert.match(await (await mf.dispatchFetch(`${origin}/`, { headers: { Cookie: cookie } })).text(), /state-list/);
    const exported = await mf.dispatchFetch(`${origin}/api/export?group=geography`, { headers: { Cookie: cookie } });
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /"US","NY","New York","New York","1"/);
    assert.equal((await mf.dispatchFetch(`${origin}/api/maintenance`, { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 200);
    const logout = await mf.dispatchFetch(`${origin}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin } });
    assert.equal(logout.status, 204);
    assert.equal((await mf.dispatchFetch(`${origin}/api/stats`, { headers: { Cookie: cookie } })).status, 401);
    const saved = JSON.stringify((await db.prepare("SELECT * FROM wa_events").all()).results);
    assert.doesNotMatch(saved, /192\.0\.2|Synthetic-browser|untrusted|latitude|longitude/);
  } finally {
    await mf.dispose();
  }
});
