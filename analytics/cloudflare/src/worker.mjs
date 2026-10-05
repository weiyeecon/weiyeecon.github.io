/* ASSETS is embedded by build.mjs. No visitor identifiers or secrets enter the UI. */
const COOKIE = "__Host-wei_analytics_session";
const SESSION_SECONDS = 43_200;
const PATHS = new Set(["/", "/research/", "/publications/", "/teaching/", "/cv/", "/404.html"]);
const CV_PATH = "/assets/pdf/CV_academic.pdf";
const BOT = /bot|spider|crawler|headless|preview|facebookexternalhit|curl|wget/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const encoder = new TextEncoder();
const hex = (value) => [...new Uint8Array(value)].map((v) => v.toString(16).padStart(2, "0")).join("");
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
function origin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}
function config(env) {
  const publicOrigin = origin(env.PUBLIC_ORIGIN);
  const sites = (env.SITE_ORIGINS || "").split(",").map((s) => s.trim());
  if (
    !publicOrigin ||
    !sites.length ||
    sites.some((s) => !origin(s)) ||
    !/^[a-f0-9]{64}$/.test(env.ANALYTICS_SECRET || "") ||
    !/^sha256\$[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_HASH || "") ||
    !env.DB
  ) {
    fail(503, "Backend setup incomplete. Check DB, origins, and secret bindings.");
  }
  const timezone = env.ANALYTICS_TIMEZONE || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    fail(503, "Invalid analytics timezone.");
  }
  const maximum = Number(env.MAX_EVENTS_PER_DAY || 2000);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5000) fail(503, "Invalid daily event limit (1–5000).");
  // first-primary also preserves immediate logout if read replication is enabled later.
  const db = env.DB.withSession ? env.DB.withSession("first-primary") : env.DB;
  return { publicOrigin, sites, timezone, secret: env.ANALYTICS_SECRET, passwordHash: env.ADMIN_PASSWORD_HASH.slice(7), maximum, db };
}
function dayAt(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function range(url, cfg) {
  const value = url.searchParams.get("days") || "30";
  if (!["7", "30", "90"].includes(value)) fail(400, "Choose 7, 30, or 90 days.");
  const days = Number(value),
    end = dayAt(new Date(), cfg.timezone);
  return { days, start: shiftDay(end, 1 - days), end };
}
async function bodyJson(request) {
  if (Number(request.headers.get("Content-Length")) > 4096) fail(413, "Request too large.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Invalid JSON.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      fail(413, "Request too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fail(400, "Invalid JSON.");
  }
}
function adminOrigin(request, cfg) {
  if (request.headers.get("Origin") !== cfg.publicOrigin) fail(403, "Origin not allowed.");
}
function cookieToken(request) {
  const part = (request.headers.get("Cookie") || "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`));
  const token = part?.slice(COOKIE.length + 1) || "";
  return /^[a-f0-9]{64}$/.test(token) ? token : "";
}
async function requireLogin(request, cfg) {
  const token = cookieToken(request);
  if (!token) fail(401, "Please sign in.");
  const stored = await hmac(cfg.secret, `session|${token}`);
  const row = await cfg.db.prepare("SELECT expires FROM wa_sessions WHERE token = ?").bind(stored).first();
  if (!row || row.expires <= Date.now() / 1000) fail(401, "Please sign in.");
  return stored;
}
async function limit(cfg, key, maximum, seconds) {
  const now = Math.floor(Date.now() / 1000),
    bucket = Math.floor(now / seconds);
  const id = await hmac(cfg.secret, `limit|${key}|${bucket}`);
  // Atomic in D1, shared across isolates/regions. Denied attempts do not update the row.
  const row = await cfg.db
    .prepare(
      `INSERT INTO wa_limits (bucket, hits, expires) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1 WHERE hits < ? RETURNING hits`
    )
    .bind(id, (bucket + 1) * seconds, maximum)
    .first();
  if (!row) fail(429, "Request limit reached. Please try again later.");
}
async function cleanup(cfg, forced = false) {
  const now = Math.floor(Date.now() / 1000),
    today = dayAt(new Date(), cfg.timezone);
  if (!forced) {
    const row = await cfg.db
      .prepare(
        `INSERT INTO wa_meta (key, value) VALUES ('cleanup_day', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value != excluded.value RETURNING value`
      )
      .bind(today)
      .first();
    if (!row) return;
  }
  // Bound each cleanup operation; scheduled daily plus opportunistic accepted writes.
  await cfg.db.batch([
    cfg.db.prepare("DELETE FROM wa_events WHERE rowid IN (SELECT rowid FROM wa_events WHERE day < ? LIMIT 5000)").bind(shiftDay(today, -364)),
    cfg.db.prepare("DELETE FROM wa_sessions WHERE token IN (SELECT token FROM wa_sessions WHERE expires <= ? LIMIT 5000)").bind(now),
    cfg.db.prepare("DELETE FROM wa_limits WHERE bucket IN (SELECT bucket FROM wa_limits WHERE expires <= ? LIMIT 20000)").bind(now),
  ]);
}
function backgroundCleanup(cfg, ctx) {
  // Never log request bodies, headers, IPs, passwords, or D1 rows on errors.
  const task = cleanup(cfg).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
  return task;
}
async function login(request, cfg, ctx) {
  adminOrigin(request, cfg);
  const { password } = await bodyJson(request);
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) fail(503, "Cloudflare client address unavailable.");
  await limit(cfg, "login-global", 100, 900);
  await limit(cfg, `login-ip|${ip}`, 5, 900);
  // SHA-256 is appropriate ONLY for the generated 256-bit random password.
  // Deliberately reject ordinary human-chosen passwords; never lower a PBKDF2 work factor.
  const validFormat = typeof password === "string" && /^[A-Za-z0-9_-]{43}$/.test(password);
  const actual = await digest(validFormat ? password : "invalid-input");
  if (!validFormat || !equal(actual, cfg.passwordHash)) fail(401, "Incorrect password.");
  const token = hex(crypto.getRandomValues(new Uint8Array(32))),
    now = Math.floor(Date.now() / 1000);
  const statements = [
    cfg.db.prepare("INSERT INTO wa_sessions (token, expires) VALUES (?, ?)").bind(await hmac(cfg.secret, `session|${token}`), now + SESSION_SECONDS),
  ];
  const old = cookieToken(request);
  if (old) statements.push(cfg.db.prepare("DELETE FROM wa_sessions WHERE token = ?").bind(await hmac(cfg.secret, `session|${old}`)));
  await cfg.db.batch(statements);
  backgroundCleanup(cfg, ctx);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` },
  });
}
async function logout(request, cfg) {
  adminOrigin(request, cfg);
  const token = cookieToken(request);
  if (token)
    await cfg.db
      .prepare("DELETE FROM wa_sessions WHERE token = ?")
      .bind(await hmac(cfg.secret, `session|${token}`))
      .run();
  return new Response(null, { status: 204, headers: { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` } });
}
function geography(cf = {}) {
  const clean = (value, size) =>
    typeof value === "string"
      ? value
          .replace(/[\x00-\x1f\x7f]/g, "")
          .trim()
          .slice(0, size)
      : "";
  const country = /^[A-Z]{2}$/.test(cf.country || "") && cf.country !== "XX" && cf.country !== "T1" ? cf.country : "ZZ";
  if (country === "ZZ") return { country, region_code: "", region: "", city: "" };
  const regionCode = clean(cf.regionCode, 12);
  return { country, region_code: /^[A-Z0-9-]+$/.test(regionCode) ? regionCode : "", region: clean(cf.region, 100), city: clean(cf.city, 100) };
}
function eventValue(value, cfg) {
  const { id, kind, path } = value;
  if (typeof id !== "string" || !UUID.test(id)) fail(400, "Invalid event ID.");
  if (!((kind === "pageview" && PATHS.has(path)) || (kind === "cv_download" && path === CV_PATH))) fail(400, "Unknown event or path.");
  let referrer = value.referrer ?? "";
  if (typeof referrer !== "string" || referrer.length > 253) fail(400, "Invalid referrer.");
  referrer = referrer.toLowerCase().trim().replace(/\.$/, "");
  if (referrer && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(referrer))
    fail(400, "Invalid referrer domain.");
  if (cfg.sites.some((site) => new URL(site).hostname === referrer)) referrer = "";
  return { id: id.toLowerCase(), kind, path, referrer };
}
async function collect(request, cfg, ctx) {
  if (!cfg.sites.includes(request.headers.get("Origin"))) fail(403, "Origin not allowed.");
  if (request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1" || BOT.test(request.headers.get("User-Agent") || ""))
    return new Response(null, { status: 204 });
  const value = eventValue(await bodyJson(request), cfg);
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) fail(503, "Cloudflare client address unavailable.");
  const now = new Date(),
    day = dayAt(now, cfg.timezone);
  // IP-only daily identifier: shared IPs undercount; IP changes can overcount.
  // Never read a visitor-supplied country/city, X-Forwarded-For, or geolocation header.
  const visitor = await hmac(cfg.secret, `visitor|${day}|${ip}`);
  await limit(cfg, "collect-global", cfg.maximum, 86400);
  await limit(cfg, `collect-ip|${day}|${ip}`, 60, 60);
  const geo = geography(request.cf);
  await cfg.db
    .prepare(
      `INSERT OR IGNORE INTO wa_events
    (event_id, created_at, day, visitor, kind, path, country, region_code, region, city, referrer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(value.id, now.toISOString(), day, visitor, value.kind, value.path, geo.country, geo.region_code, geo.region, geo.city, value.referrer)
    .run();
  backgroundCleanup(cfg, ctx);
  return new Response(null, { status: 204 });
}
async function stats(url, cfg) {
  const { days, start, end } = range(url, cfg);
  const q = (sql, ...args) => cfg.db.prepare(sql).bind(...args);
  const current = (sql) => q(sql, start, end);
  const results = await cfg.db.batch([
    current(`SELECT SUM(kind = 'pageview') AS views, COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN visitor END) AS visitors,
      COUNT(DISTINCT CASE WHEN kind = 'pageview' AND country != 'ZZ' THEN country END) AS countries,
      SUM(kind = 'cv_download') AS downloads FROM wa_events WHERE day BETWEEN ? AND ?`),
    q("SELECT COUNT(*) AS views FROM wa_events WHERE day BETWEEN ? AND ? AND kind = 'pageview'", shiftDay(start, -days), shiftDay(start, -1)),
    current(`SELECT day, SUM(kind = 'pageview') AS views, COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN visitor END) AS visitors,
      SUM(kind = 'cv_download') AS downloads FROM wa_events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`),
    current(
      "SELECT country AS code, COUNT(*) AS views FROM wa_events WHERE day BETWEEN ? AND ? AND kind = 'pageview' GROUP BY country ORDER BY views DESC, country"
    ),
    current(
      "SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM wa_events WHERE day BETWEEN ? AND ? AND kind = 'pageview' GROUP BY path ORDER BY views DESC, path"
    ),
    current(
      "SELECT CASE WHEN referrer = '' THEN 'Direct' ELSE referrer END AS domain, COUNT(*) AS views FROM wa_events WHERE day BETWEEN ? AND ? AND kind = 'pageview' GROUP BY referrer ORDER BY views DESC, referrer LIMIT 50"
    ),
    current(
      "SELECT region_code AS code, region AS name, COUNT(*) AS views FROM wa_events WHERE day BETWEEN ? AND ? AND kind = 'pageview' AND country = 'US' GROUP BY region_code, region ORDER BY views DESC, region_code LIMIT 100"
    ),
    current(
      "SELECT country, region_code, region, city, COUNT(*) AS views FROM wa_events WHERE day BETWEEN ? AND ? AND kind = 'pageview' GROUP BY country, region_code, region, city ORDER BY views DESC, country, region_code, city LIMIT 100"
    ),
    current(
      "SELECT created_at, country, region_code, region, city, kind, path, referrer FROM wa_events WHERE day BETWEEN ? AND ? ORDER BY created_at DESC, event_id DESC LIMIT 12"
    ),
  ]);
  const rows = results.map((r) => r.results),
    summary = rows[0][0];
  for (const key of Object.keys(summary)) summary[key] = Number(summary[key] || 0);
  const daily = new Map(rows[2].map((r) => [r.day, r]));
  const timeline = Array.from({ length: days }, (_, i) => {
    const day = shiftDay(start, i);
    return daily.get(day) || { day, views: 0, visitors: 0, downloads: 0 };
  });
  return {
    meta: {
      demo: false,
      timezone: cfg.timezone,
      geoip_ready: true,
      geo_source: "Cloudflare request.cf",
      site: cfg.sites[0],
      updated_at: new Date().toISOString(),
      start,
      end,
      geography_note: "Approximate IP-derived location; state/city may be unavailable. County is not collected.",
      geography_limit: 100,
      visitor_method: "Daily IP-only HMAC; approximate daily visits, not unique people.",
    },
    summary: { ...summary, today: daily.get(end)?.views || 0, previous_views: rows[1][0].views },
    timeline,
    countries: rows[3],
    pages: rows[4],
    referrers: rows[5],
    us_states: rows[6],
    cities: rows[7],
    recent: rows[8],
  };
}
function csvCell(value) {
  let text = String(value ?? "");
  // Spreadsheet formula injection protection applies even to provider geography text.
  if (/^[=+@\-\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
async function exportCsv(url, cfg) {
  const { days, start, end } = range(url, cfg),
    group = url.searchParams.get("group") || "daily";
  let output;
  if (group === "daily") {
    const result = await cfg.db
      .prepare(
        `SELECT day, SUM(kind = 'pageview') AS views,
      COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN visitor END) AS visitors, SUM(kind = 'cv_download') AS downloads
      FROM wa_events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`
      )
      .bind(start, end)
      .all();
    const daily = new Map(result.results.map((row) => [row.day, row]));
    output = [["day", "pageviews", "daily_visits", "cv_downloads"]];
    for (let i = 0; i < days; i++) {
      const day = shiftDay(start, i),
        row = daily.get(day);
      output.push([day, row?.views || 0, row?.visitors || 0, row?.downloads || 0]);
    }
  } else if (group === "geography") {
    const result = await cfg.db
      .prepare(
        `SELECT country, region_code, region, city, COUNT(*) AS views FROM wa_events
      WHERE day BETWEEN ? AND ? AND kind = 'pageview' GROUP BY country, region_code, region, city
      ORDER BY views DESC, country, region_code, city LIMIT 10001`
      )
      .bind(start, end)
      .all();
    if (result.results.length > 10000) fail(413, "Export exceeds 10,000 groups. Choose a shorter range.");
    output = [["start", "end", "country", "region_code", "region", "city", "pageviews", "location_accuracy"]];
    for (const row of result.results)
      output.push([
        start,
        end,
        row.country,
        row.region_code || "Unknown",
        row.region || "Unknown",
        row.city || "Unknown",
        row.views,
        "Approximate IP-derived; county unavailable",
      ]);
  } else fail(400, "Choose daily or geography export.");
  return new Response("\ufeff" + output.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wei-ye-analytics-${group}-${end}.csv"`,
    },
  });
}
function asset(name) {
  const type = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
  return new Response(ASSETS[name], { headers: { "Content-Type": `${type}; charset=utf-8` } });
}
async function route(request, env, ctx) {
  const url = new URL(request.url),
    cfg = config(env);
  if (url.origin !== cfg.publicOrigin) fail(403, "Host not allowed. Use the configured HTTPS origin.");
  if (request.method === "OPTIONS" && url.pathname === "/api/collect") {
    if (!cfg.sites.includes(request.headers.get("Origin")) || request.headers.get("Access-Control-Request-Method") !== "POST")
      fail(403, "Origin not allowed.");
    const headers = (request.headers.get("Access-Control-Request-Headers") || "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (headers.some((h) => !["content-type", "dnt", "sec-gpc"].includes(h))) fail(403, "Header not allowed.");
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, DNT, Sec-GPC" },
    });
  }
  if (request.method === "POST") {
    if (url.pathname === "/api/collect") return collect(request, cfg, ctx);
    if (url.pathname === "/api/login") return login(request, cfg, ctx);
    if (url.pathname === "/api/logout") return logout(request, cfg);
    if (url.pathname === "/api/maintenance") {
      adminOrigin(request, cfg);
      await requireLogin(request, cfg);
      await cleanup(cfg, true);
      return json({ ok: true });
    }
  } else if (request.method === "GET") {
    if (url.pathname === "/health") {
      await cfg.db.prepare("SELECT value FROM wa_meta WHERE key = 'cleanup_day'").first();
      return json({ ok: true });
    }
    if (url.pathname === "/") {
      try {
        await requireLogin(request, cfg);
      } catch (error) {
        if (error.status === 401) return asset("login.html");
        throw error;
      }
      return asset("dashboard.html");
    }
    if (url.pathname === "/api/stats") {
      await requireLogin(request, cfg);
      return json(await stats(url, cfg));
    }
    if (url.pathname === "/api/export") {
      await requireLogin(request, cfg);
      return exportCsv(url, cfg);
    }
    const name = url.pathname.slice("/static/".length);
    if (url.pathname.startsWith("/static/") && ["dashboard.css", "dashboard.js", "login.js"].includes(name)) return asset(name);
  }
  fail(404, "Not found.");
}
export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      response = json(
        { detail: error instanceof HttpError ? error.message : "Backend temporarily unavailable." },
        error instanceof HttpError ? error.status : 503
      );
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Strict-Transport-Security": "max-age=31536000",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }))
      headers.set(name, value);
    if (new URL(request.url).pathname === "/api/collect") {
      headers.set("Vary", "Origin");
      const incoming = request.headers.get("Origin");
      if (
        incoming &&
        (env.SITE_ORIGINS || "")
          .split(",")
          .map((s) => s.trim())
          .includes(incoming)
      )
        headers.set("Access-Control-Allow-Origin", incoming);
    }
    if (response.status === 429) headers.set("Retry-After", "900");
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event, env, ctx) {
    // A daily Cron Trigger is recommended even when the website has no visitors.
    ctx.waitUntil(cleanup(config(env), true));
  },
};
