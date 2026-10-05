import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This exporter has no configurable destination URL, authentication, or raw-event mode.
export const PUBLIC_SUMMARY_URL = "https://twilight-morning-f73e.joinyerisktaker.workers.dev/api/public-summary";
export const REPORT_DIRECTORY = fileURLToPath(new URL("../../reports/traffic/", import.meta.url));
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COUNT = 1_000_000_000_000;
const DAY_MS = 86_400_000;
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
const US_REGIONS = new Map(
  Object.entries({
    AL: "Alabama",
    AK: "Alaska",
    AZ: "Arizona",
    AR: "Arkansas",
    CA: "California",
    CO: "Colorado",
    CT: "Connecticut",
    DE: "Delaware",
    DC: "District of Columbia",
    FL: "Florida",
    GA: "Georgia",
    HI: "Hawaii",
    ID: "Idaho",
    IL: "Illinois",
    IN: "Indiana",
    IA: "Iowa",
    KS: "Kansas",
    KY: "Kentucky",
    LA: "Louisiana",
    ME: "Maine",
    MD: "Maryland",
    MA: "Massachusetts",
    MI: "Michigan",
    MN: "Minnesota",
    MS: "Mississippi",
    MO: "Missouri",
    MT: "Montana",
    NE: "Nebraska",
    NV: "Nevada",
    NH: "New Hampshire",
    NJ: "New Jersey",
    NM: "New Mexico",
    NY: "New York",
    NC: "North Carolina",
    ND: "North Dakota",
    OH: "Ohio",
    OK: "Oklahoma",
    OR: "Oregon",
    PA: "Pennsylvania",
    RI: "Rhode Island",
    SC: "South Carolina",
    SD: "South Dakota",
    TN: "Tennessee",
    TX: "Texas",
    UT: "Utah",
    VT: "Vermont",
    VA: "Virginia",
    WA: "Washington",
    WV: "West Virginia",
    WI: "Wisconsin",
    WY: "Wyoming",
    AS: "American Samoa",
    GU: "Guam",
    MP: "Northern Mariana Islands",
    PR: "Puerto Rico",
    VI: "U.S. Virgin Islands",
    UM: "United States Minor Outlying Islands",
  })
);

class ExportError extends Error {
  constructor(code) {
    // Never include a field name, response body, URL supplied by a response, or original error message.
    super(code);
    this.code = code;
  }
}

function requireValue(condition) {
  if (!condition) throw new ExportError("schema");
}

function exactObject(value, fields) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value);
  requireValue(keys.length === fields.length && keys.every((key) => fields.includes(key)));
}

function count(value) {
  requireValue(Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT);
  return value;
}

function date(value) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  requireValue(Number.isFinite(ms) && value >= "2000-01-01" && new Date(ms).toISOString().slice(0, 10) === value);
  return value;
}

function shiftDay(value, offset) {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function period(value) {
  exactObject(value, ["start", "end"]);
  const start = date(value.start);
  const end = date(value.end);
  requireValue(start <= end && shiftDay(start, 29) === end);
  return { start, end };
}

function label(value, maxLength = 100, allowEmpty = false) {
  if (allowEmpty && value === "") return "";
  requireValue(typeof value === "string" && value.length > 0 && value.length <= maxLength && value === value.trim());
  requireValue(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
  requireValue(!/^(?:unknown|n\/?a|none|null|undefined|not set|\(not set\)|[?-]+)$/i.test(value));
  return value;
}

function country(value) {
  requireValue(COUNTRIES.has(value));
  return value;
}

function regionCode(value, allowEmpty = false) {
  if (allowEmpty && value === "") return "";
  requireValue(typeof value === "string" && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value) && value.length <= 12);
  requireValue(!["XX", "ZZ", "UNKNOWN", "NA"].includes(value));
  return value;
}

function list(value, maximum) {
  requireValue(Array.isArray(value) && value.length <= maximum);
}

function geographyCount(value) {
  const result = count(value);
  requireValue(result >= 5 && result % 5 === 0);
  return result;
}

function unique(rows, key) {
  const seen = new Set();
  for (const row of rows) {
    const id = key(row);
    requireValue(!seen.has(id));
    seen.add(id);
  }
}

// Reject unknown keys at every level and construct a fresh, whitelisted object.
// A future API adding private fields therefore fails closed until intentionally reviewed.
export function validateSummary(input) {
  exactObject(input, ["schema_version", "mode", "timezone", "as_of_hour", "period", "metric", "total_pageviews", "daily", "hourly", "geography"]);
  requireValue(input.schema_version === 1 && input.mode === "public_aggregate" && input.metric === "pageviews");
  const timezone = label(input.timezone, 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ExportError("schema");
  }
  requireValue(typeof input.as_of_hour === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(input.as_of_hour));
  const asOfDay = date(input.as_of_hour.slice(0, 10));
  const asOfHour = Number(input.as_of_hour.slice(11));
  const reportPeriod = period(input.period);
  requireValue(reportPeriod.end === asOfDay);
  const total = count(input.total_pageviews);

  list(input.daily, 30);
  requireValue(input.daily.length === 30);
  const daily = input.daily.map((row, index) => {
    exactObject(row, ["day", "pageviews"]);
    const day = date(row.day);
    requireValue(day === shiftDay(reportPeriod.start, index));
    return { day, pageviews: count(row.pageviews) };
  });
  requireValue(daily.reduce((sum, row) => sum + row.pageviews, 0) === total);
  const dailyCounts = new Map(daily.map((row) => [row.day, row.pageviews]));

  list(input.hourly, 168);
  const hourlyStart = shiftDay(asOfDay, -6);
  requireValue(input.hourly.length === 6 * 24 + asOfHour);
  const hourly = input.hourly.map((row, index) => {
    exactObject(row, ["day", "hour", "pageviews"]);
    const day = date(row.day);
    const hour = row.hour;
    requireValue(Number.isInteger(hour) && hour >= 0 && hour <= 23);
    requireValue(day === shiftDay(hourlyStart, Math.floor(index / 24)) && hour === index % 24);
    requireValue(`${day}T${String(hour).padStart(2, "0")}` < input.as_of_hour);
    return { day, hour, pageviews: count(row.pageviews) };
  });
  const hourlyTotals = new Map();
  for (const row of hourly) hourlyTotals.set(row.day, (hourlyTotals.get(row.day) || 0) + row.pageviews);
  for (const [day, value] of hourlyTotals) requireValue(value === dailyCounts.get(day));
  // At midnight there are no current-day hourly rows; the daily value must still be zero.
  requireValue((hourlyTotals.get(asOfDay) || 0) === dailyCounts.get(asOfDay));

  exactObject(input.geography, ["period", "minimum_count", "rounding", "countries", "us_states", "cities"]);
  const geoPeriod = period(input.geography.period);
  requireValue(geoPeriod.end === shiftDay(asOfDay, -1));
  requireValue(input.geography.minimum_count === 5 && input.geography.rounding === 5);
  for (const kind of ["countries", "us_states", "cities"]) list(input.geography[kind], 100);

  const countries = input.geography.countries.map((row) => {
    exactObject(row, ["country", "pageviews"]);
    return { country: country(row.country), pageviews: geographyCount(row.pageviews) };
  });
  const usStates = input.geography.us_states.map((row) => {
    exactObject(row, ["region_code", "region", "pageviews"]);
    const code = regionCode(row.region_code);
    const region = label(row.region, 100, true);
    requireValue(US_REGIONS.has(code));
    return { region_code: code, region, pageviews: geographyCount(row.pageviews) };
  });
  const cities = input.geography.cities.map((row) => {
    exactObject(row, ["country", "region_code", "region", "city", "pageviews"]);
    const countryCode = country(row.country);
    const code = regionCode(row.region_code, true);
    const region = label(row.region, 100, true);
    if (countryCode === "US" && code) requireValue(US_REGIONS.has(code));
    return { country: countryCode, region_code: code, region, city: label(row.city), pageviews: geographyCount(row.pageviews) };
  });
  unique(countries, (row) => row.country);
  unique(usStates, (row) => row.region_code);
  unique(cities, (row) => JSON.stringify([row.country, row.region_code, row.city]));

  return {
    schema_version: 1,
    mode: "public_aggregate",
    timezone,
    as_of_hour: input.as_of_hour,
    period: reportPeriod,
    metric: "pageviews",
    total_pageviews: total,
    daily,
    hourly,
    geography: { period: geoPeriod, minimum_count: 5, rounding: 5, countries, us_states: usStates, cities },
  };
}

function markdown(value) {
  // Escape Markdown/HTML metacharacters; strings cannot introduce lines, links, or HTML.
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

function rowsOrEmpty(rows, render) {
  return rows.length ? rows.map(render).join("\n") : "目前没有满足公开条件的地区单元。未列出不代表访问量为零。";
}

export function renderMarkdown(summary) {
  // Validate even direct callers; never render a partially trusted object.
  const data = validateSummary(summary);
  return `# 网站访问汇总（公开）

时区：${markdown(data.timezone)}。数据截至 ${data.as_of_hour.replace("T", " ")}:00，小时明细只包含已结束的小时。

这里统计页面浏览次数（pageviews），不是独立访客人数。重复打开或刷新可能重复计数，拦截器和网络问题也可能漏计。

每日/小时汇总不含个人访问时间、访问明细、访客标识或 IP 地址。IP 地理定位仅为近似位置，不代表个人实际所在地；不提供县级数据，也不提供地区与日期/小时的交叉表。

## 最近 30 天的每日浏览量

统计范围：${data.period.start} 至 ${data.period.end}，合计 ${data.total_pageviews} 次。当天数据可能尚未完整。

0 表示没有记录到页面浏览，包括尚未开始采集的日期，不证明当时没有实际访客。开始采集之前的历史流量无法恢复。

| 日期 | 页面浏览次数 |
| --- | ---: |
${data.daily.map((row) => `| ${row.day} | ${row.pageviews} |`).join("\n")}

## 最近 7 个日历日的已结束小时

日期和小时均为上述时区。夏令时切换时，同一当地小时可能合并；不存在的当地小时可能显示为 0。

| 日期 | 小时 | 页面浏览次数 |
| --- | --- | ---: |
${data.hourly.map((row) => `| ${row.day} | ${String(row.hour).padStart(2, "0")}:00 | ${row.pageviews} |`).join("\n")}

## 地理分布（30 个完整日历日）

统计范围：${data.geography.period.start} 至 ${data.geography.period.end}。只展示至少 5 次的地区单元，数量向下取整至 5 的倍数，每类最多 100 项。未知位置和小样本单元不公开。各层级独立汇总，不能相加；未列出的地区与取整差额不能用于推断个人或补齐计数。

### 国家或地区

${rowsOrEmpty(data.geography.countries, (row) => `- ${markdown(row.country)}：${row.pageviews} 次`)}

### 美国州或地区

${rowsOrEmpty(data.geography.us_states, (row) => `- ${markdown(row.region || row.region_code)}${row.region ? `（${markdown(row.region_code)}）` : ""}：${row.pageviews} 次`)}

### 城市（近似）

${rowsOrEmpty(data.geography.cities, (row) => `- ${[row.city, row.region || row.region_code, row.country].filter(Boolean).map(markdown).join("，")}：${row.pageviews} 次`)}

本文件与 [summary.json](summary.json) 由公开汇总接口生成。抓取失败或格式不完整时会保留上一次成功报告；请以上方数据截止小时判断新旧。
`;
}

async function readResponse(fetchImpl, signal) {
  const response = await fetchImpl(PUBLIC_SUMMARY_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (response.status !== 200 || response.redirected) throw new ExportError("http");
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new ExportError("format");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new ExportError("size");
  if (!response.body || typeof response.body.getReader !== "function") throw new ExportError("format");
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ExportError("size");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (size > MAX_RESPONSE_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (length !== null && size !== Number(length)) throw new ExportError("format");
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    parsed = JSON.parse(text);
  } catch {
    throw new ExportError("format");
  }
  return validateSummary(parsed);
}

export async function fetchSummary({ fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      readResponse(fetchImpl, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ExportError("timeout"));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError("network");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function exportReport({ fetchImpl = globalThis.fetch, directory = REPORT_DIRECTORY, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  // Do not even create the output directory until the whole response has passed validation.
  const data = await fetchSummary({ fetchImpl, timeoutMs });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const report = renderMarkdown(data);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, ".export-"));
  try {
    await writeFile(path.join(staging, "summary.json"), json, { encoding: "utf8", mode: 0o644 });
    await writeFile(path.join(staging, "README.md"), report, { encoding: "utf8", mode: 0o644 });
    await rename(path.join(staging, "summary.json"), path.join(directory, "summary.json"));
    await rename(path.join(staging, "README.md"), path.join(directory, "README.md"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runCli({ args = process.argv.slice(2), stderr = process.stderr, stdout = process.stdout, ...options } = {}) {
  try {
    if (args.length) throw new ExportError("arguments");
    await exportReport(options);
    stdout.write("Public aggregate analytics report updated.\n");
    return 0;
  } catch (error) {
    const code = error instanceof ExportError ? error.code : "write";
    stderr.write(`Public analytics export failed (${code}). No response details were logged.\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli();
