# 无密码访问统计：只在 GitHub 查看汇总

默认方案不再需要管理员密码，也不提供登录后台。主页继续放在 GitHub Pages；Worker 只累计浏览量和粗粒度地区统计，GitHub Actions 定时把经过筛选的汇总写到 [访问报表](../../reports/traffic/README.md)。主页不显示统计组件、图表或报表链接。

**当前接入默认关闭。** 推送代码不会自动部署 Cloudflare，也不会开启主页采集或定时报表。先完成下面的 Worker 部署和验收，再启用。没有历史流量可补录；尚未采集时不会编造访问数字。

## 从现在已有的 Cloudflare 设置继续

已有 Worker `twilight-morning-f73e`、D1 `weiye-analytics-db`、D1 绑定名 `DB`。已经创建的四张 `wa_` 表可以保留，不需要删除，也不用重新生成密码。

### 1. 添加三张汇总表

进入 D1 → `weiye-analytics-db` → Console，运行 [0002_public_aggregates.sql](migrations/0002_public_aggregates.sql) 全部内容。

它只新增三张表：小时浏览量、按天累计的地区数量、全站每日配额。可重复运行；不会修改原有四张表，也不会把旧的逐条记录转换成公开数据。新安装也可以直接运行这份迁移，不需要先运行旧迁移。

### 2. 添加普通变量，无需 Secrets

Worker → Settings → Variables and Secrets，添加以下三个**普通变量**，不需要设置 Secret：

| 名称             | 值                                                          |
| ---------------- | ----------------------------------------------------------- |
| `AGGREGATE_MODE` | `true`                                                      |
| `PUBLIC_ORIGIN`  | `https://twilight-morning-f73e.joinyerisktaker.workers.dev` |
| `SITE_ORIGINS`   | `https://weiyeecon.github.io`                               |

默认时区已是 `America/New_York`，每日采集上限已是 `2000`，所以这两个变量可以不填。如需显式配置，对应名称为 `ANALYTICS_TIMEZONE`、`MAX_EVENTS_PER_DAY`。开始采集后应保持时区不变；旧小时桶不会在更改配置时自动换算。

不用运行凭证生成器，不用设置 `ADMIN_PASSWORD_HASH` 或 `ANALYTICS_SECRET`，也不用提供 Cloudflare API Token。若之前已经设置过旧方案的 Secrets，新方案不会读取它们。

### 3. 粘贴 Worker 代码

Worker → Edit code，将 [dist/worker.js](dist/worker.js) 的**完整内容**替换原来的 Hello World，点击 Deploy。这个文件就是无密码汇总版，没有额外依赖或需要上传的网页文件。

Worker → Settings → Trigger Events，添加每日 Cron：`17 4 * * *`（UTC 每天 04:17），用于清理旧汇总。保持请求日志 / observability 关闭，不要另加记录请求正文、请求头或 IP 的日志代码。

### 4. 验证后端

打开正式 Worker 地址，而不是编辑器预览：

- `/health` 应返回 `ok: true`、`mode: public_aggregate`。
- `/api/public-summary` 应返回结构化的汇总 JSON；刚部署时是空地区列表和零浏览量。
- `/`、`/api/stats`、`/api/export`、`/api/login` 以及旧后台路径均应返回 404。新方案没有登录页、逐条访问查询或 CSV 明细导出。

缺少配置或没有建表时应返回 503，不能把该错误当作零流量。Cloudflare 的地区数据在编辑器预览中可能不存在；正式地址上的州 / 城市也可能缺失。

如需测试采集，可在自己的主页 `https://weiyeecon.github.io` 的浏览器开发工具 Console 发送一条明确的测试请求：

```js
fetch("https://twilight-morning-f73e.joinyerisktaker.workers.dev/api/collect", {
  method: "POST",
  credentials: "omit",
  headers: { "Content-Type": "text/plain" },
  body: JSON.stringify({ kind: "pageview", path: "/" }),
}).then((response) => console.log(response.status));
```

成功返回 204；测试会增加当前小时的汇总浏览量，不能当作自然流量。它没有逐条记录，因此也没有单条事件 ID 可供事后删除。启用 DNT / GPC 或被识别为机器人的浏览器会跳过统计。公开接口不显示进行中的小时，所以需到下一小时（并等待缓存更新）才能在报表里看到这次测试。

### 5. 开启 GitHub 报表

确认 `/api/public-summary` 工作正常后，在 GitHub 仓库 Settings → Secrets and variables → Actions → **Variables** 添加：

- 名称：`ANALYTICS_PUBLIC_REPORT_ENABLED`
- 值：`true`

随后进入 Actions → `Update aggregate traffic report` → Run workflow。成功后在 [reports/traffic/README.md](../../reports/traffic/README.md) 查看报表，机器可读版本为同目录的 `summary.json`。之后计划每小时更新；GitHub Actions 的调度可能延迟，页面会注明数据截至哪个小时。

工作流使用仓库已有的 `GITHUB_TOKEN`，只提交这两个报表文件，不需要创建 GitHub Token 或 Cloudflare Token。若仓库 / 组织规则不允许 Actions 写入默认分支，工作流会明确失败；不要强行绕过规则或改用个人令牌。

**公开接口说明：** 不设密码且让 GitHub 自动读取，就需要一个公开、只读的汇总接口。知道 Worker 地址的人也能读取相同的粗粒度汇总 JSON。GitHub 是人查看报表的入口；主页不会展示或链接统计。这里的公开数据并不只对 GitHub 登录用户可见。

### 6. 最后才开启主页采集

后端和报表都验证通过后，再将仓库根目录 `_config.yml` 中的配置改为以下值并推送，等待网站构建成功：

```yaml
self_hosted_analytics_url: "https://twilight-morning-f73e.joinyerisktaker.workers.dev"
```

当前提交仍保持空值。暂停采集时将其恢复为空并重新构建。暂停报表任务时移除或关闭仓库变量 `ANALYTICS_PUBLIC_REPORT_ENABLED`。旧报表会留在 GitHub 中，并保留原来的截止小时。

## 公开什么，不保存什么

- 指标是**页面浏览量**，不是独立访客数。没有访客 ID、Cookie 指纹或 IP 去重。重复请求会重复计数，不能声称识别了多少个人。
- 保留原有前端的可见页面、DNT / GPC、机器人及本地浏览器排除逻辑。新后端只接受已知页面的 pageview；CV 点击忽略，不纳入公开报表。
- 公开最近 30 个当地日期的按天浏览量、最近 7 个当地日期的已结束小时浏览量。当前小时不公开，分钟和秒从不进入报表。夏令时回拨时，同一个当地小时的两段时间合并在该小时桶中；没有按分钟或单次访问时间记录。
- 地区另用**此前 30 个完整当地日期**的累计值，不提供地区与小时 / 日期的交叉表。国家、美国州、城市的每组真实数量至少 5 次才会出现，并向下取整到 5 的倍数。每类最多公开前 100 组；未知地区和未达到门槛的组不公开，不能把这些缺项解释为零访问。地区数值与日 / 小时总数不要求加总一致。
- 州和城市来自 Cloudflare 的 IP 近似归属；VPN、代理、移动网络和数据库覆盖会影响结果。同名城市按国家和州 / 省区分。**county 不提供**，不猜县，也不调用额外定位商。不索取浏览器定位权限，不存经纬度或邮编。
- 新表只存小时总数、按天地区总数和全站日配额；不存事件 ID、原始 IP、User-Agent、访客 ID、页面路径、来源域名、查询参数、登录会话或密码。旧方案的私密表不会被读取或发布。
- 小分组隐藏降低了定位单个访客的风险，但不代表数学意义的匿名保证。公开仓库的历史提交可能长期保留过去的汇总报表；后续改为私密不能保证别人删除已下载的数据。
- Cloudflare 处理网络请求并托管 D1；GitHub 托管公开汇总。应用不打印请求数据，但平台自身的网络日志 / 保留政策不由这份代码控制。

## 免费额度、防滥用和失败处理

- 无访客标识意味着没有持久化的按 IP 限速。这里用 D1 原子事务限制全站每日合格采集请求，默认每 UTC 日 2,000 次（最多可配置 5,000）。恶意请求可能耗尽当天限额；精确 Origin 校验可以限制浏览器跨站提交，但非浏览器客户端仍可伪造 Origin，不能保证全部流量都是真人。
- 汇总 JSON 至多缓存到下一当地整点，不支持任意查询范围或 query 参数。每次请求读取有限聚合，仍会消耗 D1 配额；大量跨地区访问或滥用可能影响免费额度。
- Cron 保留 90 个当地日期的小时总数、35 个当地日期的内部地区总数，清理过期全站配额。内部地区表从不直接导出。每天最多删除 5,000 条过期地区分组，避免一次清理失控。
- Workers Free 当前每日 100,000 次请求、每次 10 ms CPU；D1 Free 每日 100,000 行写入、5,000,000 行读取、总存储 5 GB。索引、配额计数、清理和公开查询都有额外开销，不能把写入额度等同访问量。超过额度时可能停止采集 / 报表，部署后仍需检查使用量。
- GitHub 抓取遇到网络错误、503、错误模式、缺失字段或额外字段（例如意外返回的逐条数据）会使任务失败，保留旧报表，不清零也不提交错误响应。只有验证通过的白名单汇总字段才会写入仓库。

## 本地修改和测试

```sh
cd analytics/cloudflare
npm ci
npm test
node build.mjs
```

默认构建只产生无密码 `dist/worker.js`。无需在本地创建任何凭证。可选 Wrangler 配置为 `wrangler.example.toml`；手动控制台部署不需要 Wrangler 或本地 Node.js。

旧的密码保护方案仍保留在 [README-private.md](README-private.md)，只能主动选择后使用 `node build.mjs --private` 构建 `dist/private-worker.js`，不要与默认方案混用。Python 部署也保留不变。

官方资料：[请求地理信息](https://developers.cloudflare.com/workers/runtime-apis/request/)、[D1 batch 原子事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 额度](https://developers.cloudflare.com/d1/platform/pricing/)、[GitHub 定时任务](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。
