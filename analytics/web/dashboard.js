let days = 30;
let sequence = 0;
const number = new Intl.NumberFormat("zh-CN");
const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const pageNames = {
  "/": "个人主页",
  "/research/": "研究与论文",
  "/publications/": "研究与论文（旧链接）",
  "/cv/": "个人履历",
  "/teaching/": "教学与指导",
  "/404.html": "未找到页面",
};
const byId = (id) => document.getElementById(id);
const text = (id, value) => {
  byId(id).textContent = value;
};
const flag = (code) => (code === "ZZ" ? "◎" : String.fromCodePoint(...[...code].map((character) => character.charCodeAt(0) + 127397)));
const countryName = (code) => (code === "ZZ" ? "未知地区" : names.of(code));
const percent = (value, total) => (total ? `${((100 * value) / total).toFixed(1)}%` : "0%");
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
function svgElement(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function empty(container, message) {
  container.replaceChildren(element("p", "empty-state", message));
}
function bar(ratio) {
  const svg = svgElement("svg", { viewBox: "0 0 100 3", preserveAspectRatio: "none", "aria-hidden": "true" });
  svg.append(
    svgElement("rect", { width: 100, height: 3, rx: 1.5, class: "rank-track" }),
    svgElement("rect", { width: Math.max(1, ratio * 100), height: 3, rx: 1.5, class: "rank-fill" })
  );
  return svg;
}
function renderRanking(id, rows, total, countries) {
  const container = byId(id);
  container.replaceChildren();
  container.classList.toggle("source-list", !countries);
  if (!rows.length) return empty(container, "暂无数据");
  for (const row of rows.slice(0, 8)) {
    const name = countries ? countryName(row.code) : row.domain === "Direct" ? "直接访问 / 未知来源" : row.domain;
    const item = element("div", "rank-row");
    const icon = element(
      "span",
      countries ? "rank-icon" : "source-icon",
      countries ? flag(row.code) : row.domain === "Direct" ? "↗" : row.domain[0].toUpperCase()
    );
    icon.setAttribute("aria-hidden", "true");
    const label = element("div", "rank-name", name);
    label.title = name;
    label.append(bar(row.views / Math.max(...rows.map((value) => value.views))));
    item.append(
      icon,
      label,
      element("span", "rank-count numeric", number.format(row.views)),
      element("span", "rank-percent", percent(row.views, total))
    );
    container.append(item);
  }
}

const locationValue = (value) => (typeof value === "string" ? value.trim() : "");
const regionLabel = (name, code) => {
  const region = locationValue(name);
  const abbreviation = locationValue(code);
  return region && abbreviation && region !== abbreviation ? `${region} (${abbreviation})` : region || abbreviation;
};
const usesCloudflare = (stats) => stats.meta.geo_source === "Cloudflare request.cf";
const hasGeography = (stats) => usesCloudflare(stats) || Array.isArray(stats.us_states) || Array.isArray(stats.cities);

function renderGeographyRanking(id, rows, total, states) {
  const container = byId(id);
  container.replaceChildren();
  if (!rows.length) {
    return empty(container, states ? "此时段暂无美国州级访问记录" : "此时段暂无城市访问记录");
  }
  const highest = Math.max(1, ...rows.map((row) => row.views));
  for (const row of rows.slice(0, 8)) {
    const name = states ? regionLabel(row.name, row.code) : locationValue(row.city);
    const context = states ? "美国" : [countryName(row.country || "ZZ"), regionLabel(row.region, row.region_code)].filter(Boolean).join(" · ");
    const item = element("div", "rank-row geography-row");
    const label = element("div", "rank-name");
    const heading = element("span", "geography-name", name || "未知（Unknown）");
    heading.title = name || "未知（Unknown）";
    const detail = element("small", "geography-context", context);
    detail.title = context;
    label.append(heading, detail, bar(row.views / highest));
    item.append(label, element("span", "rank-count numeric", number.format(row.views)), element("span", "rank-percent", percent(row.views, total)));
    container.append(item);
  }
}

function renderGeography(stats) {
  const cloudflare = usesCloudflare(stats);
  const available = hasGeography(stats);
  byId("geography").hidden = !available;
  byId("export-geography").hidden = !cloudflare;
  text("activity-location-heading", available ? "近似位置" : "国家 / 地区");
  const credit = byId("geo-credit");
  if (cloudflare) {
    credit.textContent = "IP 地理位置 · Cloudflare";
    credit.title = stats.meta.geo_source;
  } else if (stats.meta.geo_source) {
    credit.textContent = `IP 地理位置 · ${stats.meta.geo_source}`;
    credit.removeAttribute("title");
  } else {
    const link = element("a", "", "IP Geolocation by DB-IP");
    link.href = "https://db-ip.com/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    credit.replaceChildren(link);
    credit.removeAttribute("title");
  }
  if (!available) return;
  byId("geography-note").title = stats.meta.geography_note || "";
  const states = Array.isArray(stats.us_states) ? stats.us_states : [];
  const cities = Array.isArray(stats.cities) ? stats.cities : [];
  const usViews = stats.countries.find((row) => row.code === "US")?.views || 0;
  text("state-total", `${number.format(usViews)} 次美国浏览`);
  renderGeographyRanking("state-list", states, usViews, true);
  renderGeographyRanking("city-list", cities, stats.summary.views, false);
}

function renderChart(timeline) {
  const svg = byId("trend-chart");
  const tooltip = byId("chart-tooltip");
  svg.replaceChildren();
  tooltip.hidden = true;
  const title = svgElement("title");
  title.textContent = `${timeline.length} 天访问趋势；酒红色代表浏览量，绿色代表每日去重访问次数。`;
  const defs = svgElement("defs");
  const gradient = svgElement("linearGradient", { id: "chart-fill", x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(
    svgElement("stop", { offset: "0%", "stop-color": "#7a283c", "stop-opacity": ".12" }),
    svgElement("stop", { offset: "100%", "stop-color": "#7a283c", "stop-opacity": ".01" })
  );
  defs.append(gradient);
  svg.append(title, defs);
  const left = 35,
    right = 984,
    top = 15,
    bottom = 204;
  const highest = Math.max(1, ...timeline.map((day) => day.views));
  const ceiling = Math.max(4, Math.ceil(highest / 4) * 4);
  const x = (index) => left + (index * (right - left)) / (timeline.length - 1);
  const y = (value) => bottom - (value * (bottom - top)) / ceiling;
  for (let n = 0; n <= 4; n++) {
    const value = (ceiling * n) / 4;
    svg.append(svgElement("line", { x1: left, x2: right, y1: y(value), y2: y(value), class: "chart-grid" }));
    const label = svgElement("text", { x: left - 12, y: y(value) + 4, "text-anchor": "end", class: "chart-label" });
    label.textContent = number.format(value);
    svg.append(label);
  }
  const viewPoints = timeline.map((day, index) => `${x(index)},${y(day.views)}`);
  const visitPoints = timeline.map((day, index) => `${x(index)},${y(day.visitors)}`);
  svg.append(
    svgElement("path", { d: `M${left},${bottom} L${viewPoints.join(" L")} L${right},${bottom} Z`, class: "chart-area" }),
    svgElement("polyline", { points: viewPoints.join(" "), class: "chart-view" }),
    svgElement("polyline", { points: visitPoints.join(" "), class: "chart-visit" })
  );
  for (let i = 0; i < timeline.length; i++) {
    if (i % Math.ceil(timeline.length / 6) === 0 || i === timeline.length - 1) {
      const label = svgElement("text", {
        x: x(i),
        y: 234,
        "text-anchor": i === 0 ? "start" : i === timeline.length - 1 ? "end" : "middle",
        class: "chart-label",
      });
      label.textContent = timeline[i].day.slice(5).replace("-", "/");
      svg.append(label);
    }
    const width = (right - left) / (timeline.length - 1);
    const hit = svgElement("rect", { x: Math.max(left, x(i) - width / 2), y: top, width, height: bottom - top, class: "chart-hover" });
    const label = `${timeline[i].day} · 浏览量 ${timeline[i].views} · 访问次数 ${timeline[i].visitors}`;
    const accessible = svgElement("title");
    accessible.textContent = label;
    hit.append(accessible);
    hit.addEventListener("pointermove", (event) => {
      tooltip.textContent = label;
      tooltip.hidden = false;
      const box = byId("trend-chart").parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.max(5, Math.min(event.clientX - box.left - 90, box.width - tooltip.offsetWidth - 5))}px`;
      tooltip.style.top = `${Math.max(5, event.clientY - box.top - 42)}px`;
    });
    hit.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
    svg.append(hit);
  }
  byId("chart-empty").hidden = timeline.some((day) => day.views > 0);
}

function renderTables(stats) {
  const pages = byId("page-table");
  pages.replaceChildren();
  if (!stats.pages.length) {
    const cell = element("td", "empty-state", "暂无页面访问记录");
    cell.colSpan = 4;
    const row = element("tr");
    row.append(cell);
    pages.append(row);
  }
  for (const page of stats.pages) {
    const row = element("tr");
    const name = element("td", "page-cell", pageNames[page.path] || page.path);
    name.append(element("small", "", page.path));
    row.append(
      name,
      element("td", "numeric", number.format(page.views)),
      element("td", "numeric", number.format(page.visitors)),
      element("td", "numeric muted", percent(page.views, stats.summary.views))
    );
    pages.append(row);
  }
  const activity = byId("activity-table");
  activity.replaceChildren();
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: stats.meta.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  text("activity-caption", `最近 12 条记录 · ${stats.meta.timezone}`);
  if (!stats.recent.length) {
    const cell = element("td", "empty-state", "暂无访问记录");
    cell.colSpan = 4;
    const row = element("tr");
    row.append(cell);
    activity.append(row);
  }
  for (const item of stats.recent) {
    const row = element("tr");
    const event = element("td");
    const location = element("td", "location-cell", `${flag(item.country)} ${countryName(item.country)}`);
    if (hasGeography(stats)) {
      const detail = [locationValue(item.city), regionLabel(item.region, item.region_code)].filter(Boolean).join(" · ");
      location.append(element("small", "", detail || "州 / 城市未知（Unknown）"));
    }
    if (item.kind === "cv_download") event.append(element("span", "event-tag", "↓ CV 下载点击"));
    else event.textContent = pageNames[item.path] || item.path;
    row.append(element("td", "numeric", time.format(new Date(item.created_at))), location, event, element("td", "", item.referrer || "直接访问"));
    activity.append(row);
  }
}

async function loadStats() {
  const currentSequence = ++sequence;
  byId("refresh").disabled = true;
  byId("export-geography").href = `/api/export?days=${days}&group=geography`;
  byId("dashboard-error").hidden = true;
  try {
    const response = await fetch(`/api/stats?days=${days}`);
    if (response.status === 401) {
      location.replace("/");
      return;
    }
    if (!response.ok) throw new Error();
    const stats = await response.json();
    if (currentSequence !== sequence) return;
    const total = stats.summary;
    for (const key of ["views", "visitors", "countries", "downloads"]) text(`metric-${key}`, number.format(total[key]));
    text("today-label", `今天 ${number.format(total.today)} 次浏览`);
    text(
      "updated-label",
      `更新于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: stats.meta.timezone }).format(new Date(stats.meta.updated_at))}`
    );
    text("range-label", `${stats.meta.start.replaceAll("-", ".")} — ${stats.meta.end.replaceAll("-", ".")}`);
    byId("demo-badge").hidden = !stats.meta.demo;
    byId("geo-notice").hidden = stats.meta.geoip_ready || stats.meta.demo;
    byId("exclude-browser").href = `${stats.meta.site}/#stats-exclude`;
    const difference = total.previous_views ? ((total.views - total.previous_views) * 100) / total.previous_views : null;
    text(
      "views-comparison",
      difference === null ? "从接入之日起累计真实访问" : `${difference >= 0 ? "↑" : "↓"} ${Math.abs(difference).toFixed(1)}% 较前 ${days} 天`
    );
    byId("views-comparison").classList.toggle("positive", difference !== null && difference >= 0);
    text("country-total", `${total.countries} 个国家 / 地区`);
    renderChart(stats.timeline);
    renderRanking("country-list", stats.countries, total.views, true);
    renderRanking("source-list", stats.referrers, total.views, false);
    renderGeography(stats);
    renderTables(stats);
  } catch {
    if (currentSequence !== sequence) return;
    text("dashboard-error", "数据暂时无法读取。请检查服务器连接后刷新；当前显示的数字可能尚未更新。");
    byId("dashboard-error").hidden = false;
  } finally {
    if (currentSequence === sequence) byId("refresh").disabled = false;
  }
}

document.querySelectorAll("[data-days]").forEach((button) =>
  button.addEventListener("click", () => {
    days = Number(button.dataset.days);
    document.querySelectorAll("[data-days]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    loadStats();
  })
);
document.querySelectorAll(".sidebar-link").forEach((link) =>
  link.addEventListener("click", () => {
    document.querySelectorAll(".sidebar-link").forEach((item) => item.classList.toggle("active", item === link));
  })
);
byId("refresh").addEventListener("click", loadStats);
byId("export").addEventListener("click", () => {
  location.assign(`/api/export?days=${days}`);
});
byId("logout").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    if (!response.ok) throw new Error();
    location.replace("/");
  } catch {
    text("dashboard-error", "退出失败，请重试。");
    byId("dashboard-error").hidden = false;
  }
});
loadStats();
