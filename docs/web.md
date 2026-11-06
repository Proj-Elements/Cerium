# Cerium 网站与同步桥

## 架构

```text
浏览器                         Node / HeroUI Pro               Go 同步器
GET /api/sites  <------------>  公开快照 / 管理 API
随机管理路由 + 会话              SQLite 站点、配置、任务  ------> POST /v1/sync
                               POST /api/webhooks/sync <------ SQLite 凭据、AT、RT、Cookies
```

Node 运行时只用内置 `node:http` / `node:sqlite` / `node:crypto`，不需要 ORM、Redis 或进程管理器。
React / HeroUI Pro / Tailwind 仅用于构建静态文件；字体与 Gravity 图标随构建自托管，不依赖远程 CDN。
Node 和 Go 不共享 SQLite 文件、源码挂载或进程。保留原有 `Provider` / `Registry` / `Sink` 扩展接口。

## Docker

按 README 创建 `.env` 并提供构建凭据后：

```sh
docker compose up -d --build
docker compose ps
docker compose logs web
docker compose logs sync
```

| 容器 | 卷 | 内容 |
| --- | --- | --- |
| web | web-data -> /app/data | 站点与登录凭据、随机路由、公开快照、持久化任务 |
| sync | sync-data -> /data | 凭据、AT/RT/Cookies、快照、任务结果与站点映射 |
| solver（可选） | 无持久卷 | 独立 Chromium / Xvfb，Turnstile 临时任务与结果仅驻留内存 |

`sync` 共享 `web` 的网络命名空间，但文件系统和用户独立。Node 向
`http://127.0.0.1:8091/v1/sync` 发送任务，Go 向
`http://127.0.0.1:3000/api/webhooks/sync` 回传结果。
这不是在同一容器中运行两种服务，也不需要 Docker Desktop 开启 host networking。
若重建 web，请使用 `docker compose up -d` 一起协调两个服务，不要单独移除网络命名空间拥有者。
启用本地 solver 的部署还须在 `.env` 设置 `COMPOSE_PROFILES=solver`，让每次部署都协调第三个容器。
仅首次使用 `--profile solver` 不会自动为后续命令启用该 profile；遗漏时 solver 的自身健康检查
仍可能通过，但它留在旧 web 的网络中，当前 sync 访问 127.0.0.1:8092 会被拒绝。

| 环境变量 | 默认/说明 |
| --- | --- |
| CERIUM_WEBHOOK_SECRET | 必填，两边一致，至少 32 字符；推荐 `openssl rand -hex 32` |
| HEROUI_SETUP_TOKEN | 构建时从 shell 环境传入 BuildKit secret；运行时不需要 |
| PUBLIC_ORIGIN | 默认留空，按请求 Host 校验；反向代理时设置外部 origin |
| WEB_PORT | 宿主机端口，默认 3000；若显式配置了 PUBLIC_ORIGIN，需同步修改其中端口 |
| COOKIE_SECURE | 默认 false；HTTPS 部署设为 true |
| SYNC_INTERVAL_SECONDS | 首次初始化默认 900，范围 60 秒至 365 天；之后以后台保存的周期为准，重启保留。小规模站点串行同步，不承诺精确秒级刷新 |
| CERIUM_TURNSTILE_SOLVER_URL | Compose 默认 `http://127.0.0.1:8092`；兼容 Theyka 的 `/turnstile`、`/result` 协议 |
| CERIUM_MODEL_PROBES_PER_RUN | 默认 4，范围 1-20；每轮允许新建 Key 探测的分组数，不是重复探测次数 |
| CERIUM_OUTBOUND_PROXY_URL | 可选 HTTP(S) 出口代理，供 Go 上游请求和 Node 图标发现使用；本地桥接、回调与 solver 不走此代理。宿主机代理示例：`http://host.docker.internal:7890`，需监听 Docker 可达地址 |
| CERIUM_ICON_ALLOW_FAKE_IP | 默认 false；仅在可信 TUN 代理确实路由 `198.18.0.0/15` DNS Fake-IP 时设为 true。仅放行域名的该 DNS 结果，不放行字面量私网 IP、元数据或其他私网范围 |
| CERIUM_BACKEND_URL | Node 使用；原生默认 `http://127.0.0.1:8091` |
| CERIUM_WEBHOOK_URL | Go 使用；包含 `/api/webhooks/sync` 的完整地址 |
| DATA_DIR / PORT / HOST | Node 默认 web/data、3000、0.0.0.0；Docker DATA_DIR=/app/data |

图标代理须允许对已验证 IP 的 HTTP CONNECT（HTTP 图标使用 80 端口，HTTPS 图标使用 443），不会把目标域名交给代理重新解析；Host、TLS SNI 与证书验证仍使用原域名。回调和 solver 客户端始终直连，包括 Docker 私有网络中的 `web` / `solver` 服务名，不受出口代理或环境代理影响。

生产环境用宿主机 Caddy/Nginx 反向代理 `127.0.0.1:3000`，配置 HTTPS，设置实际
`PUBLIC_ORIGIN=https://your-domain.example` 和 `COOKIE_SECURE=true`。不要公开 Go 桥端口。
不用共享命名空间的独立容器可改用 Docker 私有网络和服务名；跨主机须使用 HTTPS 或 VPN。
切勿把 localhost 理解为任意容器的宿主机。

管理密码每次 Node 启动随机生成，仅在日志输出；内存中保留 scrypt 校验值。
路由写入 SQLite，重启不变。8 小时会话使用 HttpOnly / SameSite=Strict Cookie，重启失效。
随机路径不是鉴权替代品，所有管理 API 检查会话；写操作校验 Origin 和自定义请求头。
登录有单 IP 与全局速率限制，不信任任意客户端提供的 X-Forwarded-For。

本地显式配置为 localhost、127.0.0.1 或 [::1] 时，允许同协议、同端口的这三个回环别名，
且请求 Origin 必须与实际 Host 匹配。公网域名不作别名扩展，仍只允许配置的 origin。
例如 localhost:3080 与 127.0.0.1:3080 都可访问，但其他端口、外部站点和缺少 Origin 的写请求仍被拒绝。
`Invalid origin` 表示来源检查失败，发生在密码验证之前；检查地址栏、代理 Host、PUBLIC_ORIGIN 和 COOKIE_SECURE，
不要通过删除 CSRF 校验来解决。

**凭据和任务正文按本地信任模型明文保存在 SQLite**，文件权限 0600，目录 0700，容器非 root。
这不是数据库加密；保护 Docker 权限、卷、备份和日志，不要上传 Git。
管理员可配置任意 HTTP(S) 站点，因此管理账号与 Webhook 密钥属于高权限机密。
前台不返回账号、密码、任务、原始错误、Token 或管理路由。

后台「同步与数据」可以在线导出 JSON / SQLite (.db)，并以合并或替换方式导入 web 业务数据；备份包含明文凭据，不包含独立 Go 数据库与管理会话。操作语义和 API 见 [后台同步配置与数据迁移](admin-data.md)。

完整部署备份时先 `docker compose stop`，备份两个命名卷，再 `docker compose start`。
不要在写入期间只复制 `.db` 而漏掉 WAL。`docker compose down` 保留卷；不要随意使用 `down -v`。
单个 web / sync 实例即可；不支持多副本同时挂载同一卷。

## Turnstile 与一次性模型探测

`docker compose --profile solver up -d --build` 启用第三个可选容器；Node 和 Go 仍是两个独立容器。
浏览器镜像体积较大，不需要 Turnstile 时无需启动。Sidecar 只监听共享命名空间的 127.0.0.1:8092，
没有 RDP、对外端口或凭据卷。它收到的只有站点登录页 URL 和公开 sitekey，不包含账号、密码或 AT/RT。
接口任务限量，等待最多 90 秒，不重放提交；验证码不写 SQLite、不写日志，成功后仅用于当前一次登录。
失败会报告到站点状态，不尝试删除上游验证码校验或绕过 MFA。

Solver 构建固定引用 Theyka 提交，包装层关闭其默认 token 日志、磁盘结果和额外 IP 查询。
上游 **CC BY-NC 4.0** 许可不允许未经授权的商用；与站点的使用授权也应分别确认。
Cloudflare 完整 WAF 页面不等于嵌入式 Turnstile，此集成不承诺解决前者。

Sub2API 不再使用 `/channels/available` 作为模型来源。每个可公开分组依次：

1. 先把探测记录与随机 Key 名写入 Go SQLite 的 `model_probes`。
2. `POST /api/v1/keys`，指定 group_id、随机 custom_key、Idempotency-Key、1 天有效期和极小消费上限。
3. 仅携带该网关 Key 请求一次 `/v1/models`，保存模型数组及探测时间。
4. 删除临时 Key；删除成功清空本地 Key 内容。失败保留清理状态，后续同步重试删除。

创建响应丢失时按精确随机名称和分组查询已创建的 Key，不再次 POST。
已完成或中断的模型请求均不自动重放；失败也留痕，模型未知不会冒充空列表。
默认每轮最多开始 4 个新分组，以免触发上游创建限制；未处理分组会在后续同步继续。
改密码或重启不会重置缓存；更换 URL/账号是新的探测身份，删除再添加站点也会产生新身份。
首次探测不是实时监控，上游今后的模型变更不会自动重新探测，前台明确标注快照日期。
若更换/删除凭据前还有未完成的远端 Key 清理，应先完成清理；1 天有效期是上游支持时的额外保护，
不可替代成功删除。探测只读取模型列表，不发起推理、充值或其他付费 API 请求。

## 本地运行

需要 Go 1.26+、Node 24.13+，推荐与 Docker 相同的 Node 24 LTS。

```sh
# 终端一：两边配置相同的随机密钥，Go 使用独立数据库。
export CERIUM_WEBHOOK_SECRET='your-generated-secret-at-least-32-characters'
export CERIUM_WEBHOOK_URL=http://127.0.0.1:3000/api/webhooks/sync
go run ./cmd/cerium serve -db data/bridge.db

# 终端二
cd web
npm ci --ignore-scripts --legacy-peer-deps
npx -y hpsetup@4.7.4 "$HEROUI_SETUP_TOKEN"
npm run build
export CERIUM_WEBHOOK_SECRET='the-same-generated-secret'
npm start
```

每次干净安装后再次安装 Pro 产物；npm 占位包不含完整组件。
若全局 npm `allow-scripts` 配置导致 `EALLOWSCRIPTS`，仅对该命令使用
`NPM_CONFIG_USERCONFIG=/dev/null`，无需改动个人全局配置。
`heroui-pro.figlet` override 固定到 1.11.3，规避 GHSA-62ch-8vmq-8xm7；上游修复后可移除。
前端与构建依赖锁定在 package-lock.json；运行镜像只拷贝 server 与 dist。

`npm run dev` 用于公开页面热更新，API 代理到 Node 3000。随机管理入口由 Node 注入模式，
管理界面的完整验证在 `npm run build && npm start` 的 3000 端口进行。

## 数据语义

- 前台目录采用紧凑的横向条状卡片，只显示站点基本信息、最低已知的固定分组倍率和公开分组数量；横屏每行两张、竖屏每行一张。
  点击卡片查看全部分组倍率，再点击彩色分组 badge 查看该组模型与公开价格。动态或未知倍率不参与最低值计算。
- 分组 badge 使用与 Sub2API 一致的 OpenAI、Claude、Gemini 平台图标。优先采用上游明确给出的 `platform`；
  没有平台字段时，从模型名称识别，混合分组展示多个图标；没有可识别模型时才参考分组名称，仍无法识别则归为「其他」。
- 目录与站点详情均支持平台筛选，详情另支持分组名称搜索。右上角的双滑块共用一条轨道，按「不低于 / 不高于」选择包含端点的固定倍率区间，支持鼠标、触摸与键盘操作及重置。
  平台和倍率必须同时命中同一个分组；启用目录筛选后，卡片显示匹配分组内的最低倍率与数量。区间筛选生效时，动态或未知倍率分组不参与匹配；不限倍率时仍可查看。
- 横屏点击分组后，模型在分组详情左侧的独立卡片展示，两栏独立滚动，切换分组直接更新模型卡片，不向原容器下方追加内容。
  竖屏进入独立模型视图，通过「返回分组」恢复原有筛选；长模型列表可以分批展开并搜索，所有公开模型均可访问。后台分组 badge 可直接打开对应模型卡片。
- 站点图标独立于目录 sync。首次请求图标时，Node 从首页同源 icon 链接和常见 `favicon.ico` / `favicon.svg` / `favicon.png` / `apple-touch-icon.png` 路径发现候选，限时、限大小且只允许公网地址；逐一检查后选用首个可用图标。
  候选、选中地址和实际图像字节一起持久保存在 web SQLite 中，随 `/app/data` 数据卷保留，并发请求合并为一次抓取。`GET /api/sites/:id/icon` 只返回本站缓存路径，前端通过 `GET /api/sites/:id/icon/image` 读取图像，不直接请求上游资源。单张图片最多 1 MiB，按内容识别图片类型；缓存 SVG 使用限制资源访问与脚本执行的 CSP，隐藏或删除站点后不再公开其缓存。
  后续自动 / 手动 sync、普通编辑和重启都不重新抓取已缓存的图标；修改站点 URL 或显式图标地址才清除旧缓存。旧版本只保存地址的记录在下一次图标请求时优先下载原选中地址，下载失败后尝试普通发现；显式配置的图标只尝试指定地址。成功缓存后，上游临时不可达不影响访客展示。
  首页和全部候选探测各有 10 秒总预算，单个图标和迁移旧地址各最多 5 秒；访客先显示构建附带的默认图标，不因较慢的代理出口阻塞页面。没有可用图片时保存失败时间，15 分钟内不重复请求，之后的下一次图标请求会重试；不会后台定时刷新已打开页面。旧版无时间的失败记录会重新发现一次。浏览器读取本站缓存失败时回退到默认图标，不回源请求远程图标。
  JSON / SQLite 备份均包含图像缓存，恢复后无需重新下载。JSON 使用可校验的 `favicon_cache: { type, data }`，其中 `data` 为图片的 Base64；SQLite 使用 `favicon_blob` 和 `favicon_type` 列。仍兼容只有地址或没有图标字段的旧备份，导入后按上述规则补齐缓存；所有图标都计入原有 64 MiB 备份大小限制。
- 管理面板的「分组波动监测」默认开启。首次成功快照只建立基准；之后仅比较两次成功快照的分组 ID 与倍率，记录新增、移除及固定/动态倍率变化。模型列表、分组顺序和浮点舍入误差不会通报；同步失败保留上一成功快照。
  前台顶部展示最近 7 天未撤下的变动；后台「波动记录」保留最多 30 天或 2000 条，可撤下/恢复单条通报。暂停监测、隐藏站点或删除站点会使其通报不在前台出现；恢复监测不补发暂停期间的变动。所有记录保存在 web SQLite 中，重启不丢失。
- NewAPI 后台可切换「账号密码」或「访问令牌 + 用户 ID」。令牌模式适用于第三方登录：
  填写站点的面板访问令牌（不是模型 API Key）和对应用户 ID，允许粘贴带 `Bearer ` 前缀的值。
  编辑时令牌留空保留原值；令牌不回显，也不会出现在公开 API 中。切换认证方式会清理另一种凭据。
  不请求密码登录或刷新接口；先使用 `Authorization` 与 `New-Api-User` 验证受保护的分组接口，
  令牌过期、撤销或 ID 不匹配时需管理员更新。新版细粒度访问令牌须授予 `/api/user/self/groups` 读取权限。
  已有账号密码配置无需修改，旧 Go 数据库会自动迁移并保留会话、快照和站点映射。
- 原有 `cerium run` 保持账号可见目录行为；`serve` 使用独立的 `PublicProviders()`。
- Sub2API 只发布明确 `is_exclusive=false` 且 `subscription_type=standard` 的可用分组，使用默认倍率，
  不发布个人倍率、专属或订阅分组。缺少可见性字段则保守隐藏并提醒管理员。
  若上游限制采集账号的公开分组可见性，Cerium 无法越权补齐；建议使用无限制的普通采集账号。
- NewAPI 登录/刷新或手动令牌验证后，以全新匿名会话读取 `/api/pricing`，`usable_group` 决定公开范围。
  禁用匿名 pricing 时报告失败，不回退到个人分组或优惠价。
- 输入价为 `model_ratio * 2 * group_ratio`，单位 USD 站内额度 / 百万 tokens；输出再乘 `completion_ratio`。
  缓存读/写乘相应比率；按次价为 `model_price * group_ratio`。有效站点价（包括 0）优先；缺少的输入/输出价
  分别尝试 LiteLLM 默认价并标注「默认」，仍未匹配时显示未知。按次价不混用 token 单价。
- 表达式、插件或其他动态计费保留「动态」badge，输入/输出栏仍展示匹配到的默认数字；
  没有默认价则显示未知，不能反推固定单价。表达式默认隐藏，在 badge 悬停、键盘聚焦或手机点击时显示，绝不执行。
  自动分组无单一倍率，不编造固定站点模型价。价格是上游公开基础计费或明确标注的默认参考，不涵盖音频/图像附加项、
  高峰/长上下文等所有可能费用，也不自动折算为人民币实际成本。
- 充值仅维护 `x CNY = 1 USD` 的站内额度兑换价，不单独设置充值倍率。旧 CNY/USD 配置在保存或导入时按比例归一化，已有支付渠道不会因预设调整丢失。后台默认支付渠道为云猫寄售、链动小铺、站点直充，可在「同步与数据」维护预设并在站点表单多选。
- 目录卡片不显示简介；管理员填写的简介仅在详情标题下展示，未填写时不显示占位或默认简介。
- `others` 明确标记手动维护。前台时间是最后成功抓取时间，不是页面刷新时间。
- `models_known=false` 表示没有完整映射；空列表不等于没有任何模型。

### LiteLLM 默认价格与模型图标

`web/src/data/model-prices.json` 是 LiteLLM 价格表的精简本地快照，包含原始数据 SHA256、抓取日期及来源。
打开模型面板时才懒加载，压缩后约 47 KB；访客无需连接 GitHub 或第三方价格 API。失败不会影响站点原有价格。
默认价单位为基础 USD / 百万 tokens，**不乘分组倍率，也不是本站承诺的实际收费**。价格展示为 `$1 / 1M`，单位使用灰色；按次价格为 `$1 / 次`，未知价格保持 `—`，不标成零。
长上下文、模态、批量或优先级等附加/阶梯计费不折入这个基础单价。非 token 计费模型不会转换为 token 价格。

匹配顺序与边界：

1. 完整型号和完整托管平台路径精确匹配优先。
2. 只接受明确的模型厂商前缀，并校验后缀确实属于该厂商；归一化不从任意第三方托管平台挑一个低价。
   `z-ai/glm-5.3` 可匹配 `zai/glm-5.3`；不带前缀的 GLM 默认使用 Z.ai 国际 USD 表，BigModel 区域价格只用于明确路径。
3. Claude 的小数版本写法可互换，且在没有完整 `-thinking` 型号时允许剥离末尾的 `-thinking`。
   `claude-opus-5-5-thinking` 可以匹配 `claude-opus-5-5`。
4. `flash`、`27b`、`a3b`、`instruct`、`sol`、`terra`、日期、版本等全部保留。
   `glm-5.3-flash` 只接受其自身报价，不匹配 `glm-5.3`；`qwen3.8-27b` 不匹配 `qwen3.8`。
5. 同一归一化名称的官方报价若冲突则不猜测；无价或匹配不明的型号保持未知。

更新快照后需要重新构建前端镜像：

```sh
cd web
npm run prices:update
# 也可从已经下载的原始 LiteLLM JSON 可复现地生成（保留原始文件用于 SHA256 对账）：
npm run prices:update -- /path/to/model_prices_and_context_window.json
npm test && npm run build
```

模型图标采用本地 Lobe Icons SVG，固定来源提交 `8064bdc847be0a94c956c00440eb67586af2871f`，
原始素材位于 `web/src/assets/models/`。优先识别匹配记录中的模型厂商，再参考明确模型名；未知厂商使用中性通用图标，
识别出厂商不意味着价格也匹配成功。图标无远程 CDN 请求，浅深色均可见。
LiteLLM 和 Lobe Icons 的 MIT 许可保存在 `web/src/assets/LICENSE.litellm` 与 `web/src/assets/LICENSE.lobe-icons`；
构建时同时复制到 `dist/assets/`，随 Docker 镜像分发。商标仍属于各自持有人。

## 双向 Webhook

两个方向都使用：

```text
Content-Type: application/json
X-Cerium-Timestamp: <unix-seconds>
X-Cerium-Signature: sha256=<hex(HMAC-SHA256(secret, timestamp + "\n" + rawBody))>
```

接受时间偏差不超过 5 分钟。按原始字节签名，不要重新序列化 JSON 后验签。
结果方向另需 `X-Cerium-Event: sync.completed`。禁止 HTTP 重定向，避免转发凭据。

Node -> Go `POST /v1/sync`：

```json
{
  "job_id": "generated-uuid", "site_id": "stable-generated-uuid", "config_revision": 1,
  "operation": "sync", "name": "Example", "url": "https://relay.example",
  "type": "newapi", "account": "configured-user", "password": "configured-password"
}
```

`operation` 是 `sync` 或 `delete`。仅这一方向包含凭据。
NewAPI 令牌模式把 `account` / `password` 置空，改为 `"access_token":"configured-panel-token","user_id":123`。
Go 以 site_id 关联 credential_id；修改 URL/类型/账号/密码/令牌/用户 ID 使旧会话失效，改名称不丢失会话。
过期配置版本被拒绝，同一 job_id 不允许不同正文。先保存结果再回调，回调失败重送复用结果，
不再次旋转令牌。SQLite lease 防止重入；结果落盘前进程崩溃的未完成任务可能重新采集。

Go -> Node `POST /api/webhooks/sync`，在原有 Result 基础上增加任务关联与价格：

```json
{
  "job_id": "generated-uuid", "site_id": "stable-generated-uuid", "config_revision": 1,
  "credential_id": 1, "name": "Example", "url": "https://relay.example", "type": "newapi",
  "checked_at": "2026-11-02T00:00:00Z", "refresh": "rotated",
  "catalog": {
    "scope": "public",
    "groups": [{
      "id": "default", "name": "default", "multiplier": 1, "multiplier_source": "public",
      "models_known": true, "models": ["example-model"],
      "prices": [{"model": "example-model", "mode": "tokens", "input": 2, "output": 8}]
    }]
  }
}
```

失败带 `error`，不覆盖成功快照。Node 验证任务、版本、URL、类型和 `scope=public`，只存白名单字段。
重复回调幂等，已删除站点不会被复活；旧版本回调只确认、不应用。删除站点立即从前台隐藏，
保留凭据清理任务直到 Go 确认，断网不会丢失意图。连接失败以 5 秒至 15 分钟退避；站点本身
认证/采集失败在下个周期重试，也可在后台点击「重新同步」。手动操作立即提前退避中的待处理任务，保持相同 job_id 以便安全重送缓存结果；运行中的任务不重放。当前任务状态优先于上一轮失败状态，旧错误诊断和成功快照仍保留。完成/被替代任务与 Go 结果保留最多 30 天，未完成任务不丢弃。
删除清理 Go 凭据、会话与快照，但不包含密码/Token 的历史完成结果可能保留到 30 天。

原有 CLI `run -webhook` 的无任务结果仍适合自定义 Sink，不能绕过网站的任务匹配校验。
新增自动 Provider 时实现接口、注册公开 Provider 并调整桥/网站类型白名单；其他回传可实现 Sink。

## 验证

```sh
go test -race ./...
go vet ./...
cd web
npm test
npm run build
npx playwright install chromium  # 首次缺少浏览器时需要
npm run test:ui
```

浏览器测试启动真实 Node、编译后的 Go 桥与临时上游 Mock，验证双向签名回调、价格、私有分组隔离、
管理登录/CRUD/同步/隐藏/删除、平台图标、双滑块包含端点且同组匹配的筛选、左右独立模型面板、长模型列表，及桌面/平板/手机浅深色截图。
数据在临时目录，截图在 `artifacts/`，不是生产种子，也不构成真实第三方可用性证据。
MFA、CAPTCHA、WAF 与第三方 fork 需要实站验证。Turnstile 测试区分协议 Mock、Cloudflare 官方测试 sitekey
和真实站点验证；测试 sitekey 成功不等于真实站点挑战一定成功。

### 后端回归与读取性能

管理 API 和同步回调的 JSON 正文必须是对象，不能是 `null`、数组或标量；分组与价格条目也必须是对象。
错误输入返回 400，不更新站点或任务。站点 `enabled` 只接受布尔值，省略时默认启用，不能用字符串 `"false"` 隐藏站点。

目录读取使用一次站点/当前任务联合查询和一次同步周期查询，不随站点数量增加 SQL 调用次数；
当前版本有多个活动任务时，按创建时间、插入顺序选取最新任务。周期调整、任务重试与快照变化在下次读取立即生效，不增加目录缓存。

```sh
cd web
node --test test/validation.test.mjs test/server.test.mjs test/store-read.test.mjs
node scripts/benchmark-store.mjs
```

微基准只创建临时 SQLite 文件和合成数据：200 个站点、每站 5 个分组、每组 20 个模型，
分别测量有无待处理任务时的公开/管理目录读取，输出 300 次采样的中位数与 p95。
它不访问第三方站点、不读取生产库，不代表 HTTP 吞吐或端到端同步耗时；比较时应使用相同 Node 版本与机器环境。

浏览器夹具通过 SIGTERM 优雅退出；等待 Go 子进程退出前先注册监听，避免进程组同时收到信号时漏掉退出事件。
2026-11-03 的完整本地回归、隔离容器验证、性能对比及验证边界见 [后端维护验证记录](backend-verification.md)。

- TODO（运行验证）：补验 GitHub CI 新构建 Solver 镜像的正常服务启动、健康检查与非 root 停止；[分支整合 CI](release-status.md#verified-remote-ci) 已通过固定上游镜像构建和两项离线轮询回归，原 Docker Hub EOF 不再阻塞这两项。此前本地启动与停止证据仍来自源码一致的缓存镜像，新的候选镜像完成上述运行检查后删除此项。
- TODO（构建验证）：在具备授权的 `HEROUI_SETUP_TOKEN` 环境中，以 BuildKit secret 执行无缓存 Web 镜像构建，再验证启动、静态资源与 API；本次复用了私有依赖安装层，无法证明全新授权安装成功，无缓存构建和运行检查通过后删除此项。不要把令牌写入命令参数、日志或仓库文件。
