const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");

const root = path.resolve(__dirname, "../../web");
const html = fs.readFileSync(path.join(root, "dashboard.html"), "utf8");
const source = fs.readFileSync(path.join(root, "dashboard.js"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

// This dependency-free DOM seam checks rendering and event behavior, not browser layout.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this.classList = {
      toggle: (name, forced) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        if (forced ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  append(...children) {
    this.children.push(...children);
    children.forEach((child) => {
      child.parentElement = this;
    });
  }

  replaceChildren(...children) {
    this._text = "";
    this.children = [];
    this.append(...children);
  }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === "class") this.className = value;
  }

  removeAttribute(key) {
    delete this.attrs[key];
    delete this[key];
  }

  addEventListener(event, listener) {
    (this.listeners[event] ||= []).push(listener);
  }

  async click() {
    await Promise.all((this.listeners.click || []).map((listener) => listener()));
  }
}

const legacy = {
  meta: {
    timezone: "UTC",
    updated_at: "2026-10-05T15:00:00Z",
    start: "2026-09-06",
    end: "2026-10-05",
    demo: false,
    geoip_ready: true,
    site: "https://weiyeecon.github.io",
  },
  summary: { views: 20, visitors: 15, countries: 2, downloads: 1, today: 3, previous_views: 10 },
  timeline: Array.from({ length: 30 }, (_, index) => ({
    day: `2026-09-${String(index + 1).padStart(2, "0")}`,
    views: index % 4,
    visitors: index % 3,
  })),
  countries: [
    { code: "US", views: 12 },
    { code: "GB", views: 8 },
  ],
  referrers: [
    { domain: "Direct", views: 15 },
    { domain: "google.com", views: 5 },
  ],
  pages: [{ path: "/", views: 20, visitors: 15 }],
  recent: [{ created_at: "2026-10-05T15:00:00Z", country: "US", kind: "pageview", path: "/", referrer: "" }],
};
const cloudflare = structuredClone(legacy);
Object.assign(cloudflare.meta, {
  geo_source: "Cloudflare request.cf",
  geography_note: "Approximate IP-derived location; state/city may be unavailable. County is not collected.",
});
cloudflare.us_states = [
  { code: "NY", name: "New York", views: 10 },
  { code: "", name: "", views: 2 },
];
cloudflare.cities = [
  { country: "US", region_code: "NY", region: "New York", city: "New York", views: 10 },
  { country: "GB", region_code: "ENG", region: "England", city: "London", views: 8 },
  { country: "US", region_code: "", region: "", city: "", views: 2 },
];
Object.assign(cloudflare.recent[0], { region_code: "NY", region: "New York", city: "New York" });
cloudflare.recent.push({ created_at: "2026-10-05T14:00:00Z", country: "US", kind: "cv_download", path: "/cv/", referrer: "" });

const flush = () => new Promise((resolve) => setImmediate(resolve));
const descendants = (node, tag) => node.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...descendants(child, tag)]);
const response = (data, status = 200) => ({ status, ok: status === 200, json: async () => structuredClone(data) });

async function createDashboard(data = cloudflare) {
  const state = { data: structuredClone(data), status: 200, pending: null };
  const nodes = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const ranges = [7, 30, 90].map((days) => {
    const button = new Element("button");
    button.dataset.days = String(days);
    return button;
  });
  const links = Array.from({ length: 4 }, () => new Element("a"));
  const document = {
    getElementById: (id) => {
      assert.ok(nodes[id], `Missing HTML id ${id}`);
      return nodes[id];
    },
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    querySelectorAll: (selector) => (selector === "[data-days]" ? ranges : selector === ".sidebar-link" ? links : []),
  };
  const requests = [];
  const locations = [];
  const context = vm.createContext({
    document,
    Intl,
    Date,
    location: { assign: (url) => locations.push(url), replace: (url) => locations.push(url) },
    fetch: async (url) => {
      requests.push(url);
      if (state.pending) return new Promise((resolve) => state.pending.push(resolve));
      return response(state.data, state.status);
    },
  });
  vm.runInContext(source, context, { filename: "dashboard.js" });
  await flush();
  assert.equal(nodes["dashboard-error"].hidden, true);
  const refresh = async (nextData) => {
    if (nextData) state.data = structuredClone(nextData);
    await nodes.refresh.click();
    await flush();
  };
  return { state, nodes, ranges, requests, locations, refresh };
}

test("dashboard HTML has unique element ids and explains approximate geography", () => {
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /地理位置按访问 IP 近似推断/);
  assert.match(html, /不采集县（County）信息/);
});

test("Cloudflare renders states, cities, unknowns, correct denominators, and recent location", async () => {
  const { nodes } = await createDashboard();
  assert.equal(nodes.geography.hidden, false);
  assert.equal(nodes["state-list"].children.length, 2);
  assert.equal(nodes["city-list"].children.length, 3);
  assert.match(nodes["state-list"].textContent, /New York \(NY\)/);
  assert.match(nodes["state-list"].textContent, /未知（Unknown）/);
  assert.equal(nodes["state-list"].children[0].children[2].textContent, "83.3%");
  assert.equal(nodes["city-list"].children[0].children[2].textContent, "50.0%");
  assert.match(nodes["city-list"].textContent, /美国 · New York \(NY\)/);
  assert.equal(nodes["geo-credit"].textContent, "IP 地理位置 · Cloudflare");
  assert.equal(nodes["geo-notice"].hidden, true);
  assert.equal(nodes["activity-location-heading"].textContent, "近似位置");
  assert.match(nodes["activity-table"].textContent, /New York · New York \(NY\)/);
  assert.match(nodes["activity-table"].textContent, /州 \/ 城市未知（Unknown）/);
  assert.equal(nodes["export-geography"].href, "/api/export?days=30&group=geography");
  assert.equal(nodes["geography-note"].title, cloudflare.meta.geography_note);
});

test("repeated range changes update geography and existing export paths", async () => {
  const { nodes, ranges, requests, locations } = await createDashboard();
  for (const days of [7, 90, 30]) {
    await ranges.find((button) => Number(button.dataset.days) === days).click();
    await flush();
    assert.equal(requests.at(-1), `/api/stats?days=${days}`);
    assert.equal(nodes["export-geography"].href, `/api/export?days=${days}&group=geography`);
  }
  await nodes.export.click();
  assert.equal(locations.at(-1), "/api/export?days=30");
});

test("a legacy Python response restores country-only UI and DB-IP attribution", async () => {
  const { nodes, refresh } = await createDashboard();
  const data = structuredClone(legacy);
  data.meta.geoip_ready = false;
  await refresh(data);
  assert.equal(nodes.geography.hidden, true);
  assert.equal(nodes["export-geography"].hidden, true);
  assert.equal(nodes["geo-credit"].children[0].href, "https://db-ip.com/");
  assert.equal(nodes["geo-notice"].hidden, false);
  assert.equal(nodes["activity-location-heading"].textContent, "国家 / 地区");
  assert.equal(descendants(nodes["activity-table"], "SMALL").length, 0);
  assert.equal(nodes["dashboard-error"].hidden, true);
});

test("missing optional Cloudflare arrays show empty states without stale rows or credit", async () => {
  const { nodes, refresh } = await createDashboard(legacy);
  const data = structuredClone(cloudflare);
  delete data.us_states;
  delete data.cities;
  await refresh(data);
  assert.equal(nodes.geography.hidden, false);
  assert.equal(nodes["state-list"].children[0].className, "empty-state");
  assert.equal(nodes["city-list"].children[0].className, "empty-state");
  assert.equal(nodes["geo-notice"].hidden, true);
  assert.equal(nodes["geo-credit"].children.length, 0);
});

test("location values remain inert text, blank names are unknown, and rankings show at most eight rows", async () => {
  const data = structuredClone(cloudflare);
  data.us_states[0].name = '<img src=x onerror="alert(1)">';
  data.cities[0].city = "<script>alert(1)</script>";
  data.us_states[1].code = "   ";
  data.us_states[1].name = "  ";
  data.us_states.push(...Array.from({ length: 8 }, (_, index) => ({ code: `X${index}`, name: `Test ${index}`, views: 1 })));
  const { nodes } = await createDashboard(data);
  assert.equal(nodes["state-list"].children.length, 8);
  assert.equal(descendants(nodes["state-list"], "IMG").length, 0);
  assert.equal(descendants(nodes["city-list"], "SCRIPT").length, 0);
  assert.match(nodes["state-list"].textContent, /<img src=x onerror="alert\(1\)">/);
  assert.match(nodes["state-list"].textContent, /未知（Unknown）/);
  assert.match(nodes["city-list"].textContent, /<script>alert\(1\)<\/script>/);
});

test("an empty geography response shows empty states and zero US views", async () => {
  const data = structuredClone(cloudflare);
  data.us_states = [];
  data.cities = [];
  data.countries = [];
  data.summary.views = 0;
  const { nodes } = await createDashboard(data);
  assert.equal(nodes["state-total"].textContent, "0 次美国浏览");
  assert.equal(nodes["state-list"].children[0].className, "empty-state");
  assert.equal(nodes["city-list"].children[0].className, "empty-state");
});

test("rapid range changes reject stale responses and immediately update the export range", async () => {
  const { nodes, ranges, state } = await createDashboard();
  state.pending = [];
  await ranges[0].click();
  await ranges[2].click();
  assert.equal(nodes["export-geography"].href, "/api/export?days=90&group=geography");
  assert.equal(state.pending.length, 2);
  state.pending[1](response(cloudflare));
  await flush();
  state.pending[0](response(legacy));
  await flush();
  assert.equal(nodes.geography.hidden, false);
  assert.equal(nodes["export-geography"].href, "/api/export?days=90&group=geography");
  assert.equal(nodes.refresh.disabled, false);
});

test("fetch failures show the existing error and expired sessions redirect to login", async () => {
  const { nodes, state, locations, refresh } = await createDashboard();
  state.status = 500;
  await refresh();
  assert.equal(nodes["dashboard-error"].hidden, false);
  assert.equal(nodes.refresh.disabled, false);
  state.status = 401;
  await refresh();
  assert.equal(locations.at(-1), "/");
});
