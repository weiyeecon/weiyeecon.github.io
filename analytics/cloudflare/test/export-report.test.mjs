import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_RESPONSE_BYTES, PUBLIC_SUMMARY_URL, exportReport, fetchSummary, renderMarkdown, runCli, validateSummary } from "../export-report.mjs";

const MARKER = "PRIVATE_VISITOR_SENTINEL_NEVER_PUBLISH";
const exporter = fileURLToPath(new URL("../export-report.mjs", import.meta.url));

function dayOffset(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function fixture(asOf = "2026-10-05T12") {
  const end = asOf.slice(0, 10);
  const daily = Array.from({ length: 30 }, (_, index) => ({ day: dayOffset(end, index - 29), pageviews: 24 }));
  daily.at(-1).pageviews = Number(asOf.slice(11));
  const hourly = Array.from({ length: 144 + Number(asOf.slice(11)) }, (_, index) => ({
    day: dayOffset(end, -6 + Math.floor(index / 24)),
    hour: index % 24,
    pageviews: 1,
  }));
  return {
    schema_version: 1,
    mode: "public_aggregate",
    timezone: "America/New_York",
    as_of_hour: asOf,
    period: { start: dayOffset(end, -29), end },
    metric: "pageviews",
    total_pageviews: daily.reduce((sum, row) => sum + row.pageviews, 0),
    daily,
    hourly,
    geography: {
      period: { start: dayOffset(end, -30), end: dayOffset(end, -1) },
      minimum_count: 5,
      rounding: 5,
      countries: [{ country: "US", pageviews: 25 }],
      us_states: [{ region_code: "NY", region: "New York", pageviews: 15 }],
      cities: [{ country: "US", region_code: "NY", region: "New York", city: "New York", pageviews: 10 }],
    },
  };
}

function response(data = fixture(), init = {}) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8" }, ...init });
}

async function directory(t) {
  const result = await mkdtemp(path.join(os.tmpdir(), "aggregate-report-test-"));
  t.after(() => rm(result, { recursive: true, force: true }));
  return result;
}

test("fixture validates and is reconstructed without retaining input references", () => {
  const source = fixture();
  const clean = validateSummary(source);
  assert.deepEqual(clean, source);
  source.daily[0].pageviews = 999;
  source.geography.cities[0].city = MARKER;
  assert.equal(clean.daily[0].pageviews, 24);
  assert.equal(clean.geography.cities[0].city, "New York");
});

test("all missing or unknown fields fail closed, including private fields at every level", () => {
  const paths = [
    [],
    ["period"],
    ["daily", 0],
    ["hourly", 0],
    ["geography"],
    ["geography", "period"],
    ["geography", "countries", 0],
    ["geography", "us_states", 0],
    ["geography", "cities", 0],
  ];
  for (const keys of paths) {
    const source = fixture();
    const node = keys.reduce((value, key) => value[key], source);
    for (const name of ["visitor_id", "timestamp", "ip", "raw_events", "county", "day", MARKER]) {
      if (Object.hasOwn(node, name)) continue;
      node[name] = MARKER;
      assert.throws(() => validateSummary(source), /^Error: schema$/);
      delete node[name];
    }
    const key = Object.keys(node)[0];
    delete node[key];
    assert.throws(() => validateSummary(source), /^Error: schema$/);
  }
});

test("legacy/private reports, different metrics, invalid timezones/dates and incomplete periods are rejected", () => {
  const changes = [
    (x) => (x.mode = "private"),
    (x) => (x.schema_version = 2),
    (x) => (x.metric = "unique_visitors"),
    (x) => (x.timezone = "Invalid/Zone"),
    (x) => (x.as_of_hour = "2026-10-05T12:00:01Z"),
    (x) => (x.as_of_hour = "2026-10-05T24"),
    (x) => (x.as_of_hour = "2026-02-30T12"),
    (x) => (x.period.start = "2026-09-31"),
    (x) => (x.period.end = "2026-10-06"),
    (x) => x.daily.pop(),
    (x) => (x.daily[0].day = x.daily[1].day),
    (x) => x.daily.reverse(),
    (x) => x.hourly.pop(),
    (x) => (x.hourly[0].hour = 24),
    (x) => (x.hourly[0].hour = 0.5),
    (x) => (x.hourly[0].day = "2026-09-28"),
    (x) => (x.hourly.at(-1).hour = 12),
    (x) => (x.geography.period.end = "2026-10-05"),
  ];
  for (const change of changes) {
    const source = fixture();
    change(source);
    assert.throws(() => validateSummary(source), /^Error: schema$/);
  }
});

test("count bounds and arithmetic must agree", () => {
  for (const value of [-1, 0.1, "1", null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 1_000_000_000_001]) {
    for (const key of ["daily", "hourly"]) {
      const source = fixture();
      source[key][0].pageviews = value;
      assert.throws(() => validateSummary(source), /^Error: schema$/);
    }
  }
  const mismatchedTotal = fixture();
  mismatchedTotal.total_pageviews++;
  assert.throws(() => validateSummary(mismatchedTotal), /^Error: schema$/);
  const excessiveHour = fixture();
  excessiveHour.hourly[0].pageviews = 100;
  assert.throws(() => validateSummary(excessiveHour), /^Error: schema$/);
});

test("current-day daily counts exactly match completed hours, including zero at midnight", () => {
  for (const asOf of ["2026-10-05T00", "2026-10-05T12", "2026-10-05T23"]) {
    const source = fixture(asOf);
    assert.deepEqual(validateSummary(source), source);
    source.daily.at(-1).pageviews++;
    source.total_pageviews++;
    assert.throws(() => validateSummary(source), /^Error: schema$/);
  }
  const source = fixture();
  source.daily.at(-1).pageviews--;
  source.total_pageviews--;
  assert.throws(() => validateSummary(source), /^Error: schema$/);
});

test("geography only accepts coarse non-small non-unknown bounded unique cells", () => {
  const changes = [
    (x) => (x.geography.minimum_count = 1),
    (x) => (x.geography.rounding = 1),
    (x) => (x.geography.countries[0].pageviews = 4),
    (x) => (x.geography.countries[0].pageviews = 6),
    (x) => (x.geography.countries[0].country = "ZZ"),
    (x) => (x.geography.countries[0].country = "T1"),
    (x) => (x.geography.countries[0].country = "AA"),
    (x) => (x.geography.countries[0].country = "<script>"),
    (x) => (x.geography.us_states[0].region_code = "ZZ"),
    (x) => (x.geography.us_states[0].region_code = ""),
    (x) => (x.geography.cities[0].region = "Unknown"),
    (x) => (x.geography.cities[0].city = ""),
    (x) => (x.geography.cities[0].city = "Unknown"),
    (x) => (x.geography.cities[0].city = " New York"),
    (x) => (x.geography.cities[0].city = "X".repeat(101)),
    (x) => (x.geography.cities[0].city = "New\nYork"),
    (x) => (x.geography.cities[0].city = "New\u0000York"),
    (x) => (x.geography.cities[0].city = "New\u202eYork"),
    (x) => (x.geography.cities[0].city = "New\u2028York"),
    (x) => x.geography.countries.push({ ...x.geography.countries[0] }),
    (x) => x.geography.us_states.push({ ...x.geography.us_states[0] }),
    (x) => x.geography.cities.push({ ...x.geography.cities[0] }),
    (x) => (x.geography.cities = Array.from({ length: 101 }, (_, i) => ({ ...x.geography.cities[0], city: `City ${i}` }))),
    (x) => (x.geography.countries = null),
  ];
  for (const change of changes) {
    const source = fixture();
    change(source);
    assert.throws(() => validateSummary(source), /^Error: schema$/);
  }
});

test("valid zero data, empty geography, Unicode city names and DST dates are supported", () => {
  for (const asOf of ["2026-03-08T00", "2026-03-08T03", "2026-11-01T01", "2026-11-01T23", "2028-02-29T12"]) {
    const source = fixture(asOf);
    source.total_pageviews = 0;
    source.daily.forEach((row) => (row.pageviews = 0));
    source.hourly.forEach((row) => (row.pageviews = 0));
    source.geography.countries = [];
    source.geography.us_states = [];
    source.geography.cities = [];
    assert.deepEqual(validateSummary(source), source);
    const markdown = renderMarkdown(source);
    assert.equal((markdown.match(/目前没有满足公开条件的地区单元/g) || []).length, 3);
    assert.match(markdown, /未列出不代表访问量为零/);
  }
  const source = fixture();
  source.geography.cities = [{ country: "CN", region_code: "11", region: "北京市", city: "北京市", pageviews: 10 }];
  assert.match(renderMarkdown(source), /北京市/);
});

test("valid configured timezones and missing region details do not invent geography", () => {
  for (const timezone of ["UTC", "America/New_York", "Asia/Shanghai", "Europe/London"]) {
    const source = fixture();
    source.timezone = timezone;
    source.geography.us_states[0].region = "";
    source.geography.cities[0].region_code = "";
    source.geography.cities[0].region = "";
    assert.deepEqual(validateSummary(source), source);
    assert.match(renderMarkdown(source), /- NY：15 次/);
    assert.match(renderMarkdown(source), /- New York，US：10 次/);
  }
  const source = fixture();
  source.geography.us_states[0].region = "纽约州";
  source.geography.cities[0].region = "纽约州";
  assert.match(renderMarkdown(source), /纽约州/);
});

test("Markdown escapes arbitrary geography text and explains the privacy and metric limits", () => {
  const source = fixture();
  source.geography.cities[0].city = "[City](https://example.test) <img> **bold** | `code` & test";
  const rendered = renderMarkdown(source);
  assert.match(rendered, /\\\[City\\\]\\\(https:\/\/example\\\.test\\\)/);
  assert.match(rendered, /&lt;img&gt;/);
  assert.match(rendered, /\\\*\\\*bold\\\*\\\*/);
  assert.match(rendered, /\\\|/);
  assert.match(rendered, /&amp; test/);
  assert.match(rendered, /不是独立访客人数/);
  assert.match(rendered, /近似位置/);
  assert.match(rendered, /不提供县级数据/);
  assert.match(rendered, /不提供地区与日期\/小时的交叉表/);
  assert.match(rendered, /0 表示没有记录到页面浏览/);
  assert.match(rendered, /历史流量无法恢复/);
});

test("fetch uses the hard-coded public endpoint with bounded read and no authentication or redirects", async () => {
  const clean = await fetchSummary({
    fetchImpl: async (url, options) => {
      assert.equal(url, PUBLIC_SUMMARY_URL);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(options.cache, "no-store");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      assert.ok(options.signal instanceof AbortSignal);
      return response();
    },
  });
  assert.deepEqual(clean, fixture());
});

test("non-200, HTML, invalid JSON/UTF-8 and oversized bodies are rejected without exposing data", async () => {
  const cases = [
    () => response({ private: MARKER }, { status: 500 }),
    () => response({ private: MARKER }, { status: 302, headers: { location: "https://example.test" } }),
    () => new Response(MARKER, { headers: { "content-type": "text/html" } }),
    () => new Response(MARKER, { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } }),
    () => response(fixture(), { headers: { "content-type": "application/json", "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    () => response(fixture(), { headers: { "content-type": "application/json", "content-length": "1" } }),
    () => response(fixture(), { headers: { "content-type": "application/json", "content-length": "invalid" } }),
    () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "application/json" } }),
    () => {
      throw new Error(MARKER);
    },
  ];
  for (const makeResponse of cases) {
    await assert.rejects(fetchSummary({ fetchImpl: async () => makeResponse() }), (error) => {
      assert.doesNotMatch(error.message, new RegExp(MARKER));
      assert.match(error.message, /^(http|format|size|network)$/);
      return true;
    });
  }
});

test("deadline covers both a stalled fetch and a stalled body", async () => {
  let requestSignal;
  await assert.rejects(
    fetchSummary({
      timeoutMs: 20,
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return new Promise(() => {});
      },
    }),
    /^Error: timeout$/
  );
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(
    fetchSummary({
      timeoutMs: 20,
      fetchImpl: async () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        }),
    }),
    /^Error: timeout$/
  );
});

test("successful export writes only sanitized summary JSON and Chinese Markdown", async (t) => {
  const output = await directory(t);
  await exportReport({ directory: output, fetchImpl: async () => response() });
  assert.deepEqual((await readdir(output)).sort(), ["README.md", "summary.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "summary.json"), "utf8")), fixture());
  assert.match(await readFile(path.join(output, "README.md"), "utf8"), /网站访问汇总（公开）/);
});

test("invalid/incomplete/raw/unreachable reports leave both previous files byte-for-byte unchanged", async (t) => {
  const output = await directory(t);
  const previousJson = "previous validated report\n";
  const previousMarkdown = "previous report Markdown\n";
  await writeFile(path.join(output, "summary.json"), previousJson);
  await writeFile(path.join(output, "README.md"), previousMarkdown);
  const raw = fixture();
  raw.visitors = [{ timestamp: MARKER, visitor_id: MARKER }];
  const incomplete = fixture();
  incomplete.daily.pop();
  const cases = [
    async () => response(raw),
    async () => response(incomplete),
    async () => response({ error: MARKER }, { status: 503 }),
    async () => {
      throw new Error(MARKER);
    },
    async () => new Promise(() => {}),
  ];
  for (const fetchImpl of cases) {
    let stderr = "";
    let stdout = "";
    assert.equal(
      await runCli({
        args: [],
        directory: output,
        fetchImpl,
        timeoutMs: 20,
        stderr: { write: (value) => (stderr += value) },
        stdout: { write: (value) => (stdout += value) },
      }),
      1
    );
    assert.doesNotMatch(stderr, new RegExp(MARKER));
    assert.equal(stdout, "");
    assert.equal(await readFile(path.join(output, "summary.json"), "utf8"), previousJson);
    assert.equal(await readFile(path.join(output, "README.md"), "utf8"), previousMarkdown);
    assert.deepEqual((await readdir(output)).sort(), ["README.md", "summary.json"]);
  }
});

test("CLI rejects overrides without network access and gives a nonzero process exit", () => {
  const result = spawnSync(process.execPath, [exporter, "--url", MARKER], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /failed \(arguments\)/);
  assert.doesNotMatch(result.stderr, new RegExp(MARKER));
});

test("injected-fetch CLI fixture harness reports success without contacting production", async (t) => {
  const output = await directory(t);
  let stdout = "";
  let stderr = "";
  const code = await runCli({
    args: [],
    directory: output,
    fetchImpl: async () => response(),
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /report updated/);
});
