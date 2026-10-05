import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../dist/worker.js";

// These deterministic fixtures are deliberately synthetic. Never deploy them.
export const PASSWORD = createHash("sha256").update("TEST FIXTURE ONLY: synthetic analytics password").digest("base64url");
export const SECRET = createHash("sha256").update("TEST FIXTURE ONLY: synthetic analytics signing key").digest("hex");
export const PASSWORD_HASH = `sha256$${createHash("sha256").update(PASSWORD).digest("hex")}`;
export const ADMIN = "https://analytics.example.test";
export const SITE = "https://homepage.example.test";
export const COOKIE = "__Host-wei_analytics_session";
export const MIGRATION = readFileSync(new URL("../migrations/0001_worker_analytics.sql", import.meta.url), "utf8");
export const FROZEN_NOW = Date.parse("2026-10-05T16:00:00.000Z");

// D1's statement interface over an actual in-memory SQLite database. No query
// answers are canned: constraints, GROUP BY, RETURNING and SQL all execute.
export class SqliteD1 {
  constructor(sqlite = new DatabaseSync(":memory:")) {
    this.sqlite = sqlite;
    this.sessions = [];
  }

  prepare(sql) {
    const database = this.sqlite;
    const statement = database.prepare(sql);
    const bound = (values = []) => ({
      bind(...args) {
        return bound(args);
      },
      async first(column) {
        const result = statement.get(...values);
        if (!result) return null;
        return column === undefined ? { ...result } : result[column];
      },
      async all() {
        return { success: true, results: statement.all(...values).map((row) => ({ ...row })) };
      },
      async run() {
        const result = statement.run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      // Execute synchronously so a batch's transaction cannot interleave with
      // another request, matching D1's transactional batch contract.
      executeForBatch() {
        return { success: true, results: statement.all(...values).map((row) => ({ ...row })) };
      },
    });
    return bound();
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map((statement) => statement.executeForBatch());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  withSession(constraint) {
    this.sessions.push(constraint);
    return this;
  }
}

export function fixture(t, overrides = {}) {
  const db = new SqliteD1();
  db.sqlite.exec(MIGRATION);
  t.after(() => db.sqlite.close());
  const env = {
    DB: db,
    PUBLIC_ORIGIN: ADMIN,
    SITE_ORIGINS: SITE,
    ANALYTICS_SECRET: SECRET,
    ADMIN_PASSWORD_HASH: PASSWORD_HASH,
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
    count(table) {
      assert.match(table, /^wa_(?:events|sessions|limits|meta)$/);
      return Number(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    },
    async fetch(path = "/", { method = "GET", headers = {}, body, cf, implementation = worker, ...options } = {}) {
      const request = new Request(new URL(path, ADMIN), { method, headers, ...(body === undefined ? {} : { body }), ...options });
      if (cf !== undefined) Object.defineProperty(request, "cf", { value: cf });
      const tasks = [];
      const response = await implementation.fetch(request, env, { waitUntil: (task) => tasks.push(task) });
      await Promise.all(tasks);
      return response;
    },
    async login({ password = PASSWORD, ip = "192.0.2.10", headers = {}, ...options } = {}) {
      return h.fetch("/api/login", {
        method: "POST",
        headers: { Origin: ADMIN, "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
        body: JSON.stringify({ password }),
        ...options,
      });
    },
    async session(options) {
      const response = await h.login(options);
      assert.equal(response.status, 204, await response.text());
      return response.headers.get("Set-Cookie").split(";", 1)[0];
    },
    async collect(value = {}, { headers = {}, ...options } = {}) {
      return h.fetch("/api/collect", {
        method: "POST",
        headers: { Origin: SITE, "Content-Type": "text/plain;charset=UTF-8", "CF-Connecting-IP": "192.0.2.20", ...headers },
        body: JSON.stringify({ id: crypto.randomUUID(), kind: "pageview", path: "/", ...value }),
        ...options,
      });
    },
    async stats(cookie, query = "days=7") {
      const response = await h.fetch(`/api/stats?${query}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
      return response.json();
    },
    seed(overrides = {}) {
      const event = {
        event_id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        day: new Date().toISOString().slice(0, 10),
        visitor: "synthetic-visitor",
        kind: "pageview",
        path: "/",
        country: "US",
        region_code: "NY",
        region: "New York",
        city: "New York",
        referrer: "",
        ...overrides,
      };
      db.sqlite
        .prepare(
          `INSERT INTO wa_events (${Object.keys(event).join(",")}) VALUES (${Object.keys(event)
            .map(() => "?")
            .join(",")})`
        )
        .run(...Object.values(event));
      return event;
    },
  };
  return h;
}

export function freeze(t, now = FROZEN_NOW) {
  t.mock.timers.enable({ apis: ["Date"], now });
}

export function sign(value) {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

export function assertPrivate(response) {
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(response.headers.get("X-Robots-Tag"), /noindex/);
  assert.match(response.headers.get("Strict-Transport-Security"), /max-age=/);
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /unsafe-inline|unsafe-eval|https?:/);
}

// Small strict CSV reader: checks quoting/escaping instead of splitting commas,
// because geography may legitimately contain quotes, commas, or newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (char === "\r" && text[i + 1] === "\n" && !quoted) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += char;
  }
  assert.equal(quoted, false, "CSV must close every quoted field");
  assert.equal(field, "", "CSV must end in CRLF");
  assert.deepEqual(row, [], "CSV must end in CRLF");
  return rows;
}
