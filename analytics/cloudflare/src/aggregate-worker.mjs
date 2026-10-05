// Public aggregate-only Worker. No login, visitor IDs, raw-event storage or secrets.
const PAGE_PATHS = new Set(["/", "/research/", "/publications/", "/teaching/", "/cv/", "/404.html"]);
const BOT = /bot|spider|crawler|headless|preview|facebookexternalhit|curl|wget/i;
const COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" ")
);
const US_REGION_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "AS",
  "GU",
  "MP",
  "PR",
  "VI",
  "UM",
]);
const GEO_MINIMUM = 5;
const GEO_ROUNDING = 5;
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
function settings(env) {
  const publicOrigin = env.PUBLIC_ORIGIN;
  const siteOrigins = (env.SITE_ORIGINS || "").split(",").map((value) => value.trim());
  if (
    !env.DB ||
    env.AGGREGATE_MODE !== "true" ||
    !validOrigin(publicOrigin) ||
    !siteOrigins.length ||
    siteOrigins.some((value) => !validOrigin(value))
  ) {
    fail(503, "Aggregate backend is not configured.");
  }
  const timezone = env.ANALYTICS_TIMEZONE || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    fail(503, "Invalid analytics timezone.");
  }
  const maximum = Number(env.MAX_EVENTS_PER_DAY || 2000);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5000) fail(503, "Invalid daily limit.");
  return { publicOrigin, siteOrigins, timezone, maximum, db: env.DB.withSession ? env.DB.withSession("first-primary") : env.DB };
}
function calendar(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((value) => value.type === type).value;
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}
function shift(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
async function bodyJson(request) {
  if (Number(request.headers.get("Content-Length")) > 4096) fail(413, "Request too large.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Invalid JSON.");
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) {
      await reader.cancel();
      fail(413, "Request too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fail(400, "Invalid JSON.");
  }
}
function location(cf = {}) {
  const clean = (value) =>
    typeof value === "string"
      ? value
          .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
          .trim()
          .slice(0, 100)
          .trim()
      : "";
  const country = COUNTRIES.has(cf.country) ? cf.country : "ZZ";
  if (country === "ZZ") return { country, region_code: "", region: "", city: "" };
  const code =
    typeof cf.regionCode === "string" &&
    /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(cf.regionCode) &&
    cf.regionCode.length <= 12 &&
    !["XX", "ZZ", "UNKNOWN", "NA"].includes(cf.regionCode) &&
    (country !== "US" || US_REGION_CODES.has(cf.regionCode))
      ? cf.regionCode
      : "";
  const known = (value) => (/^(?:unknown|n\/?a|none|null|undefined|not set|\(not set\)|[?-]+)$/i.test(value) ? "" : value);
  return { country, region_code: code, region: known(clean(cf.region)), city: known(clean(cf.city)) };
}
async function collect(request, cfg) {
  if (!cfg.siteOrigins.includes(request.headers.get("Origin"))) fail(403, "Origin not allowed.");
  if (request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1" || BOT.test(request.headers.get("User-Agent") || ""))
    return new Response(null, { status: 204 });
  const value = await bodyJson(request);
  // Existing front-end contract is accepted, but ID, referrer and path are never saved.
  if (value.kind === "cv_download" && value.path === "/assets/pdf/CV_academic.pdf") return new Response(null, { status: 204 });
  if (value.kind !== "pageview" || !PAGE_PATHS.has(value.path)) fail(400, "Unknown event or path.");
  const now = new Date(),
    local = calendar(now, cfg.timezone),
    utcDay = now.toISOString().slice(0, 10),
    geo = location(request.cf);
  // D1 batch transactions serialize this chain. changes() gates every subsequent
  // aggregate update on the prior successful write; capped requests update nothing.
  const result = await cfg.db.batch([
    cfg.db
      .prepare(
        `INSERT INTO wa_aggregate_budget (day, hits) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET hits = hits + 1 WHERE hits < ? RETURNING hits`
      )
      .bind(utcDay, cfg.maximum),
    cfg.db
      .prepare(
        `INSERT INTO wa_aggregate_hours (day, hour, pageviews)
      SELECT ?, ?, 1 WHERE changes() = 1
      ON CONFLICT(day, hour) DO UPDATE SET pageviews = pageviews + 1`
      )
      .bind(local.day, local.hour),
    cfg.db
      .prepare(
        `INSERT INTO wa_aggregate_geography (day, country, region_code, region, city, pageviews)
      SELECT ?, ?, ?, ?, ?, 1 WHERE changes() = 1
      ON CONFLICT(day, country, region_code, region, city) DO UPDATE SET pageviews = pageviews + 1`
      )
      .bind(local.day, geo.country, geo.region_code, geo.region, geo.city),
  ]);
  if (!result[0].results.length) fail(429, "Daily aggregate collection limit reached.");
  return new Response(null, { status: 204 });
}
async function publicSummary(cfg) {
  const now = new Date(),
    local = calendar(now, cfg.timezone);
  const start = shift(local.day, -29),
    hourlyStart = shift(local.day, -6),
    geoEnd = shift(local.day, -1),
    geoStart = shift(geoEnd, -29);
  const q = (sql, ...params) => cfg.db.prepare(sql).bind(...params);
  // Completed local hours only. Geography uses a separate window of completed days,
  // never a geography-by-hour cross-tab, and never reads the private-mode tables.
  const results = await cfg.db.batch([
    q(
      `SELECT day, SUM(pageviews) AS pageviews FROM wa_aggregate_hours
      WHERE day >= ? AND (day < ? OR (day = ? AND hour < ?)) GROUP BY day ORDER BY day`,
      start,
      local.day,
      local.day,
      local.hour
    ),
    q(
      `SELECT day, hour, pageviews FROM wa_aggregate_hours
      WHERE day >= ? AND (day < ? OR (day = ? AND hour < ?)) ORDER BY day, hour`,
      hourlyStart,
      local.day,
      local.day,
      local.hour
    ),
    q(
      `SELECT country, CAST(SUM(pageviews) / ? AS INTEGER) * ? AS pageviews FROM wa_aggregate_geography
      WHERE day BETWEEN ? AND ? AND country != 'ZZ' GROUP BY country HAVING SUM(pageviews) >= ? ORDER BY pageviews DESC, country LIMIT 100`,
      GEO_ROUNDING,
      GEO_ROUNDING,
      geoStart,
      geoEnd,
      GEO_MINIMUM
    ),
    q(
      `SELECT region_code, MAX(region) AS region, CAST(SUM(pageviews) / ? AS INTEGER) * ? AS pageviews FROM wa_aggregate_geography
      WHERE day BETWEEN ? AND ? AND country = 'US' AND region_code != '' GROUP BY region_code HAVING SUM(pageviews) >= ? ORDER BY pageviews DESC, region_code LIMIT 100`,
      GEO_ROUNDING,
      GEO_ROUNDING,
      geoStart,
      geoEnd,
      GEO_MINIMUM
    ),
    q(
      `SELECT country, region_code, MAX(region) AS region, city, CAST(SUM(pageviews) / ? AS INTEGER) * ? AS pageviews FROM wa_aggregate_geography
      WHERE day BETWEEN ? AND ? AND country != 'ZZ' AND city != '' GROUP BY country, region_code, city HAVING SUM(pageviews) >= ? ORDER BY pageviews DESC, country, region_code, city LIMIT 100`,
      GEO_ROUNDING,
      GEO_ROUNDING,
      geoStart,
      geoEnd,
      GEO_MINIMUM
    ),
  ]);
  const [dailyRows, hourlyRows, countries, usStates, cities] = results.map((result) => result.results);
  const days = new Map(dailyRows.map((row) => [row.day, row.pageviews]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const day = shift(start, i);
    return { day, pageviews: days.get(day) || 0 };
  });
  const hours = new Map(hourlyRows.map((row) => [`${row.day}|${row.hour}`, row.pageviews]));
  const hourly = [];
  for (let i = 0; i < 7; i++) {
    const day = shift(hourlyStart, i),
      end = day === local.day ? local.hour : 24;
    for (let hour = 0; hour < end; hour++) hourly.push({ day, hour, pageviews: hours.get(`${day}|${hour}`) || 0 });
  }
  return {
    schema_version: 1,
    mode: "public_aggregate",
    timezone: cfg.timezone,
    as_of_hour: `${local.day}T${String(local.hour).padStart(2, "0")}`,
    period: { start, end: local.day },
    metric: "pageviews",
    total_pageviews: daily.reduce((sum, row) => sum + row.pageviews, 0),
    daily,
    hourly,
    geography: {
      period: { start: geoStart, end: geoEnd },
      minimum_count: GEO_MINIMUM,
      rounding: GEO_ROUNDING,
      countries,
      us_states: usStates,
      cities,
    },
  };
}
async function cleanup(cfg) {
  const day = calendar(new Date(), cfg.timezone).day;
  await cfg.db.batch([
    cfg.db.prepare("DELETE FROM wa_aggregate_hours WHERE day < ?").bind(shift(day, -89)),
    cfg.db
      .prepare("DELETE FROM wa_aggregate_geography WHERE rowid IN (SELECT rowid FROM wa_aggregate_geography WHERE day < ? LIMIT 5000)")
      .bind(shift(day, -34)),
    cfg.db.prepare("DELETE FROM wa_aggregate_budget WHERE day < ?").bind(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)),
  ]);
}
async function route(request, env, ctx) {
  const cfg = settings(env),
    url = new URL(request.url);
  if (url.origin !== cfg.publicOrigin) fail(403, "Host not allowed.");
  if (url.search) fail(400, "Query parameters are not supported.");
  if (request.method === "OPTIONS" && url.pathname === "/api/collect") {
    if (!cfg.siteOrigins.includes(request.headers.get("Origin")) || request.headers.get("Access-Control-Request-Method") !== "POST")
      fail(403, "Origin not allowed.");
    const headers = (request.headers.get("Access-Control-Request-Headers") || "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (headers.some((header) => !["content-type", "dnt", "sec-gpc"].includes(header))) fail(403, "Header not allowed.");
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, DNT, Sec-GPC" },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/collect") return collect(request, cfg);
  if (request.method === "GET" && url.pathname === "/health") {
    await cfg.db.prepare("SELECT day FROM wa_aggregate_hours LIMIT 1").first();
    return json({ ok: true, mode: "public_aggregate" });
  }
  if (request.method === "GET" && url.pathname === "/api/public-summary") {
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(`${cfg.publicOrigin}/api/public-summary`, { method: "GET" });
    const cached = cache ? await cache.match(key) : null;
    if (cached) return cached;
    const response = json(await publicSummary(cfg));
    // Stop at the next local-hour boundary, including fractional-offset timezones.
    // No query-string cache bypass or arbitrary date ranges.
    const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, minute: "2-digit" }).format(new Date()));
    const ttl = Math.max(1, 3600 - minute * 60 - new Date().getUTCSeconds());
    response.headers.set("Cache-Control", `public, max-age=${ttl}`);
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, response.clone()));
    return response;
  }
  // No dashboard, raw data, CSV, login, sessions, maintenance, or legacy export routes.
  fail(404, "Not found.");
}
export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      response = json(
        { detail: error instanceof HttpError ? error.message : "Aggregate backend temporarily unavailable." },
        error instanceof HttpError ? error.status : 503
      );
    }
    const headers = new Headers(response.headers);
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
    for (const [key, value] of Object.entries({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Strict-Transport-Security": "max-age=31536000",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    }))
      headers.set(key, value);
    if (new URL(request.url).pathname === "/api/collect") {
      headers.set("Vary", "Origin");
      const origin = request.headers.get("Origin");
      if (
        origin &&
        (env.SITE_ORIGINS || "")
          .split(",")
          .map((s) => s.trim())
          .includes(origin)
      )
        headers.set("Access-Control-Allow-Origin", origin);
    }
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(settings(env)));
  },
};
