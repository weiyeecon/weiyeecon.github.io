# Cloudflare Workers + D1 私人统计

主页继续由 GitHub Pages 托管；Cloudflare Worker 接收访问事件并提供登录后台，D1 保存统计。保留了原来的米白 / 酒红界面、趋势图、国家分布、来源、热门页面与 CSV，并增加美国州和城市分布。原有 [Python + SQLite 部署](../README.md) 仍可独立使用。

**代码推送不等于 Cloudflare 已部署。网站的 `self_hosted_analytics_url` 仍为空，采集保持关闭。** 先完成以下部署和验收，再单独开启主页采集。不需要把 GitHub 写入令牌放进网站，也不需要外部 IP 定位服务。

## 已有资源

- Worker：`twilight-morning-f73e`
- 地址：`https://twilight-morning-f73e.joinyerisktaker.workers.dev`
- D1：`weiye-analytics-db`
- Worker D1 绑定名：`DB`

如果重命名或改用自己的域名，需要同步修改 `PUBLIC_ORIGIN`。它必须是精确的 HTTPS origin，不带结尾斜杠或路径。

## 最简单的部署方式：Cloudflare 控制台

### 1. 初始化 D1

打开 D1 → `weiye-analytics-db` → Console，把 [migrations/0001_worker_analytics.sql](migrations/0001_worker_analytics.sql) 的全部内容复制进去运行。全部是幂等的建表语句，可以重跑，不会删除已有数据。这里使用 `wa_` 前缀，避免覆盖原有 Python 的 `events` / `sessions` 表；旧 SQLite 数据不会自动导入，也不会虚构过去的州 / 城市。

确认 Worker → Bindings 中存在 D1 数据库绑定：名称 `DB`，数据库 `weiye-analytics-db`。

### 2. 私下生成管理员密码

在自己的可信电脑下载仓库，要求 Node.js 22.13 或更新版本，在仓库根目录运行：

```sh
node analytics/cloudflare/credentials.mjs
```

程序生成两个仅当前用户可读、已被 Git 忽略的文件：

- `credentials.private.txt`：随机管理员密码。将它保存在自己的密码管理器，用它登录统计后台。
- `.dev.vars`：`ADMIN_PASSWORD_HASH` 和 `ANALYTICS_SECRET` 的值，仅供服务器使用。

不要把文件、密码、密钥或摘要发到聊天或公开仓库。不要自行换成短密码。程序不会在终端打印凭证值，也不会覆盖旧凭证。

此版本使用 256 位随机密码，服务器仅保存 SHA-256 摘要。它不是针对人类自选密码的快速哈希方案。Python 版本的 PBKDF2 密码摘要不能直接复用。这样可以保持随机凭证的安全强度，同时避免在 Workers Free 的 10 ms CPU 限制下运行昂贵的密码推导。普通短密码会被拒绝。

### 3. 设置变量和 Secrets

进入 Worker → Settings → Variables and Secrets，添加以下普通变量：

| 名称                 | 值                                                          |
| -------------------- | ----------------------------------------------------------- |
| `PUBLIC_ORIGIN`      | `https://twilight-morning-f73e.joinyerisktaker.workers.dev` |
| `SITE_ORIGINS`       | `https://weiyeecon.github.io`                               |
| `ANALYTICS_TIMEZONE` | `America/New_York`                                          |
| `MAX_EVENTS_PER_DAY` | `2000`                                                      |

再添加两个 **Secret 类型**的绑定：`ADMIN_PASSWORD_HASH` 和 `ANALYTICS_SECRET`，分别复制自己电脑上 `.dev.vars` 对应的值，去掉外围双引号。不要将管理员明文密码填到 Cloudflare。Secret 不应放在普通变量或公开代码中。

如果主页以后增加自定义域名，`SITE_ORIGINS` 可以是逗号分隔的完整 HTTPS origin 列表，禁止通配符。后台登录必须使用 `PUBLIC_ORIGIN` 指定的正式地址，控制台预览地址会被拒绝。

### 4. 部署完整 Worker

打开 Worker → Edit code，将 [dist/worker.js](dist/worker.js) 全部内容替换编辑器里的示例程序，然后 Deploy。这个文件已内嵌后台 HTML、CSS 和 JS，不需要上传额外静态文件，也没有运行时依赖。不要把 Python 的 `app.py` 粘贴进去。

在 Settings → Trigger Events 添加每日 Cron：`17 4 * * *`（每天 UTC 04:17）。它清理过期事件、登录会话和限速记录；即使主页没有访问，也应保留这个定时清理。成功采集和登录也会尝试每日清理。一次最多清理 5,000 条过期事件，正常每日上限不超过该值。

不要开启请求正文/请求头日志或把凭证写入自定义日志。示例 Wrangler 配置关闭 Workers observability；通过控制台部署时请自行检查日志设置。应用不会打印访问者 IP、Cookie、密码、事件正文或数据库内容。Cloudflare 平台仍处理网络请求，平台级日志/保留政策不由本应用控制。

### 5. 验收后再开启网站

用正式地址检查以下项目：

1. `/health` 返回 `{"ok":true}`。配置缺失或没有建表会返回 503，不会跳过认证。
2. 无登录状态打开 `/api/stats` 和 `/api/export`，都应返回 401；首页只显示登录页。
3. 用本地生成的密码登录，检查空数据后台、7 / 30 / 90 天切换和两种 CSV。
4. 退出后再次访问数据接口，旧会话应失效。
5. 在主页 `https://weiyeecon.github.io` 打开浏览器开发工具，在 Console 手动发送下方一条测试事件。只有该主页 origin 被允许。它会创建一条**真实保留的测试记录**，不要当作自然流量；如需要，可在 D1 Console 按事件 ID 删除它。

```js
const testId = crypto.randomUUID();
console.log("测试记录 ID（仅用于确认或删除这条测试事件）：", testId);
fetch("https://twilight-morning-f73e.joinyerisktaker.workers.dev/api/collect", {
  method: "POST",
  mode: "cors",
  credentials: "omit",
  headers: { "Content-Type": "text/plain" },
  body: JSON.stringify({ id: testId, kind: "pageview", path: "/", referrer: "" }),
}).then((response) => console.log(response.status));
```

返回 204 后登录后台确认计数和地理字段。启用 DNT / GPC 的浏览器会忽略事件，机器人 User-Agent 也会跳过。`request.cf` 地理信息在 Cloudflare 编辑器预览中不可用，必须在正式部署地址测试；即使部署正确，部分真实请求也可能没有州 / 城市。

以上都通过后，另行把网站根目录 `_config.yml` 改为：

```yaml
self_hosted_analytics_url: "https://twilight-morning-f73e.joinyerisktaker.workers.dev"
```

等待 GitHub Pages 构建完成，再验证真实浏览、CV 点击和匿名访问后台的 401。需要暂停采集时把该配置恢复为空并重新构建。后台认证未通过时不要开启采集。

## 可选：Wrangler 部署

如已使用官方 Wrangler 并自行完成 Cloudflare 登录，可在 `analytics/cloudflare/` 中把 `wrangler.example.toml` 复制为 `wrangler.toml`，填入控制台显示的真实 D1 ID。不要新建重复数据库或将凭证写入该文件。

```sh
node build.mjs
npx wrangler d1 migrations apply weiye-analytics-db --remote
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put ANALYTICS_SECRET
npx wrangler deploy
```

上述 Secret 命令让你在自己的终端安全输入对应值。`.dev.vars` 仅用于本地运行，Wrangler 不会自动把它上传成生产 Secrets。生产代码严格要求 HTTPS 正式 origin；测试套件以合成请求覆盖本地行为，不依赖本地 HTTP 开放例外。

## 地理信息与隐私

- Cloudflare 根据 IP 给出 `request.cf.country`、`regionCode`、`region`、`city`。州和城市都是近似定位，VPN、代理、移动网络和数据库覆盖会影响结果。
- **美国州**按 US 请求的 region 字段汇总；包含未知州时明确显示未知。城市按国家、州/省和城市组合分组，避免把不同地方的同名城市合并。界面最多展示前 100 组（各面板展示其中前几名），地理 CSV 最多 10,000 组；超过时提示缩短日期范围，不悄悄截断 CSV。
- **县 / county 不采集**：Cloudflare 的该接口没有县字段，不从城市名称猜县，也不调用额外 IP 定位商。不能据这些信息识别人、精确住址、机构或招聘单位。
- 不索取浏览器定位权限，不保存经纬度、邮编、原始 IP、User-Agent、完整 referrer 或查询字符串。referrer 只允许域名；页面路径采用白名单。
- 使用独立 secret 和当地日期对 IP 做 HMAC。日期变化后标识变化；不使用 User-Agent 做指纹，不在访客端写追踪 Cookie。共享 IP 会低估访问人数，切换 IP 会高估；指标是每日近似访问数之和，并非跨日独立人数。它仍是用于统计的假名化标识，不应宣称完全匿名。
- 服务器也尊重 DNT / GPC；前端已有相同检查和本地浏览器排除功能。没有历史数据补录。
- 明细保留 365 个当地日期，清理依靠每日 Cron 和成功请求的机会性清理。管理员 Cookie 为 12 小时、HttpOnly、Secure、SameSite=Strict；数据库只存会话令牌的 HMAC，登出立即撤销。
- 密钥和统计数据保存在自己的 Cloudflare 账户中。Cloudflare 处理请求并托管数据；这不是数据只在个人电脑保存的方案。

## 防滥用、免费额度与边界

- D1 原子计数器跨 Worker 实例生效。每个 IP 每分钟最多 60 个合格采集请求，全站每日默认 2,000 个合格采集请求（UTC 计数窗口，可配置 1–5,000）。重复事件也消耗限额。固定窗口边界允许短时双倍突发。
- 登录每个 IP 每 15 分钟最多 5 次，全站每 15 分钟最多 100 次；成功登录不清空窗口。Origin 检查、4 KB 请求限制、路径白名单、去重、参数化 SQL 和只读导出共同限制攻击面。
- Origin 可以被非浏览器客户端伪造，IP 地理信息不是身份证明；公共采集端无法保证全是真人。攻击者仍可能占用限额造成拒绝服务，或消耗读取/请求额度。这里的 D1 控制不是网络层 DDoS 防护；如流量异常，先暂停采集并检查 Cloudflare 控制台，不要直接提高限额。
- Workers Free 当前每天 100,000 次请求、每次 10 ms CPU；D1 Free 每天 100,000 行写入、5,000,000 行读取、总存储 5 GB。索引、限速计数器、删除和后台查询都会消耗额度，不能把 100,000 行写入等同 100,000 次访问。默认采集上限为这些额外开销留出余量，但不是配额保证。D1 达到免费额度时会拒绝查询；前台失败不会阻塞网页加载。
- 后台在 D1 内聚合并返回有限排名和最近 12 条，避免把全部访问明细拉到 Worker 中计算。对真实账户的 CPU 时间和额度仍需部署后检查；本地单元测试不能证明实际免费额度充足。

官方资料：[请求地理信息](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 费用和额度](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 更新、备份与验证

修改 `src/worker.mjs` 或共用的 `../web/` 文件后先运行 `npm ci` 安装测试依赖，再运行 `npm test`，然后重新部署新生成的 `dist/worker.js`。生成文件不包含真实数据或凭证。测试包括 Node / SQLite 安全回归、后台 DOM 交互，以及 Miniflare 中真实 workerd + D1 的完整登录 / 采集 / 汇总 / 导出 / 退出流程；Miniflare 是开发测试依赖，不会打包进生产 Worker。`npm run test:unit` 可以在不安装第三方依赖的情况下执行 Node / SQLite 和 DOM 测试。

```sh
cd analytics/cloudflare
npm ci
npm test
node --check dist/worker.js
# 备份包含私人统计，应只保存到自己的安全位置：
npx wrangler d1 export weiye-analytics-db --remote --output private-backup.sql
```

备份文件不要提交到仓库。修改管理员凭证时，在自己的电脑安全备份旧私密文件后重新运行生成器，并一起更新两个 Cloudflare Secrets；更换 `ANALYTICS_SECRET` 会立即使旧会话失效，也会改变当天后续访问的去重标识。只换密码摘要不会撤销已登录会话，因此应同时换密钥。
