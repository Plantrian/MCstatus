# mcstatus-api

[简体中文](README.md) | [English](README.en.md)

Minecraft **Java 版**服务器状态查询 API。同时跑两套协议，对外提供 **JSON 数据** 与 **直接返回 PNG 的图片接口**：

| 协议 | 传输 | 提供的信息 |
| --- | --- | --- |
| **Server List Ping (SLP)** | TCP（游戏端口 `port`） | 服务器图标（favicon）、**延迟**、版本名 + 协议号、两行 MOTD、玩家采样（带 UUID） |
| **GameSpy4 Query** | UDP（`queryPort`） | **完整**玩家列表、插件列表、世界名、服务端软件名 |

两份数据合并成一份状态，并且：

- **只要有一个协议成功就算在线**。Query 没开是很常见的情况（很多服只留 SLP），这时仍能显示图标、延迟、人数、MOTD，玩家列表自动退化为 SLP 采样并在图上标注来源
- 游戏端口与 Query 端口**完全分离**（`port` / `queryPort`），Query 默认关闭也不会导致接口不可用
- **多服一览**：一次并发查多台，输出一张列表图（`/api/overview.png`）+ 汇总 JSON（`/api/overview`）
- 图片**默认 1600×800**（`scale=2` 高清），高度随玩家数 / 台数自适应；服务器离线、参数非法、渲染失败**都返回一张图片**，不会 500、不会空白
- 内存 TTL 缓存 **30 秒**，JSON 与图片**共用同一份查询结果**（一轮 UDP+TCP 只服务两类请求）
- **7 套主题 × 5 种视觉语言 × 3 种布局**任意组合，配色与版式都能用 URL 参数切换
- 玩家头像**自研渲染**：自己从 Mojang 取皮肤、自己裁剪放大，不依赖第三方头像服务

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 服务器端准备](#2-服务器端准备)
- [3. API 参考](#3-api-参考)
- [4. 主题 / 布局 / 视觉语言](#4-主题--布局--视觉语言)
- [5. 图片规格](#5-图片规格)
- [6. 玩家头像](#6-玩家头像)
- [7. 字体](#7-字体)
- [8. 缓存](#8-缓存)
- [9. 环境变量](#9-环境变量)
- [10. 部署](#10-部署)
- [11. 项目结构](#11-项目结构)
- [12. 故障排查](#12-故障排查)
- [13. 设计说明](#13-设计说明)
- [14. 为什么没用 `@hloth/minecraft-query`](#14-为什么没用-hlothminecraft-query)
- [15. License](#15-license)

---

## 1. 快速开始

### 环境要求

- **Node.js >= 18.17**（需要全局 `fetch`、`AbortController`）
- 一台开启了 Query 的 Minecraft Java 版服务器（**可选**，仅 SLP 也能用）
- `node-canvas` 使用预编译包，Linux 上通常无需编译工具链；装不上时见 [node-canvas wiki](https://github.com/Automattic/node-canvas/wiki)

### 安装与运行

```bash
npm install
npm start                 # 默认监听 3000
PORT=3001 npm start       # 自定义监听端口
npm run dev               # node --watch，改代码自动重启
npm test                  # 端到端自测（不需要真实服务器）
```

启动输出：

```
[mcstatus-api] 已启动，监听端口 3001
[mcstatus-api] JSON:  http://localhost:3001/api/status?host=play.example.com
[mcstatus-api] 图片:  http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566
[mcstatus-api] 字体: UI 字重 6 个（含中文）；系统 CJK 未找到；emoji /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf；符号 /usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf
```

最后那行是**字体自检结果**：图片里的中文与 emoji 分别用了哪个字体文件。
排查「容器里画成方框」时先看它，见[第 7 节](#7-字体)。

### 本地假服务器（没有真服也能开发）

`test/mock-server.mjs` 是一个「假 Minecraft 服务器」，同时实现了上面两套协议，还会现画一个 64×64 的服务器图标：

```bash
node test/mock-server.mjs     # TCP 25565（SLP）+ UDP 25566（Query），12 名玩家
curl "http://localhost:3001/api/status?host=127.0.0.1&port=25565&queryPort=25566"
```

它也支持被 import 进测试：`startMockServer({ withSlp, withQuery, gamePort, queryPort })`，自测脚本正是用它覆盖「只有 SLP」「Query 关闭」等场景。

`npm test` 会用假服务器 + 假头像服务跑完整链路，共 **61 项断言**（JSON 字段、图片尺寸、参数校验、缓存命中、主题/布局/风格、头像裁剪等），产物写在 `test-output/`。

---

## 2. 服务器端准备

### 打开 Query（可选）

Query 协议**默认关闭**，需要在服务器根目录的 `server.properties` 里打开：

```properties
enable-query=true
query.port=25566
```

- 改完**必须重启服务器**才生效
- `query.port` 可以和游戏端口相同，也可以不同、或指向另一台机器
- Query 与 RCON 是两件事，**不需要** `enable-rcon`
- 即使不开启 Query，本接口依然可用：靠 SLP 拿图标 / 延迟 / 人数 / MOTD，只是玩家列表只能拿采样

### 防火墙

| 协议 | 端口 | 传输 |
| --- | --- | --- |
| SLP | `port`（游戏端口） | **TCP** |
| Query | `queryPort` | **UDP** |

常见坑：只放行了 TCP 25565，UDP 的 query 端口被挡 → 表现为「服务器明明在线，`playerList` 却拿不到 / `queryError` 报超时」。本接口会同时给出 SLP 结果，所以这种情况仍会判为在线。

### 关于 SRV 记录

本项目的 Query 查询**不做 SRV 解析**，直接用你传入的 `queryPort`。SRV 只影响客户端找游戏端口，如果你的服靠 SRV 暴露游戏端口，把解析出的端口手动填进 `port` 用于展示即可。

---

## 3. API 参考

| 端点 | 返回 | 说明 |
| --- | --- | --- |
| `GET /api/status` | JSON | 单台服务器完整状态 |
| `GET /api/banner.png` | PNG | 单台服务器状态图 |
| `GET /api/overview` | JSON | 多台服务器汇总 + 每台完整状态 |
| `GET /api/overview.png` | PNG | 多台服务器一览图（一行一台） |
| `GET /api/themes` | JSON | 可用主题列表（含每套配套的布局与视觉语言） |
| `GET /api/layouts` | JSON | 可用布局列表 |
| `GET /api/styles` | JSON | 可用视觉语言列表 |
| `GET /healthz` | JSON | 健康检查（uptime + 缓存统计） |

全部端点允许 CORS（`Access-Control-Allow-Origin: *`），`OPTIONS` 返回 204。请求日志默认打印，`LOG_REQUESTS=off` 可关。

### `GET /api/status`

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | ✅ | — | 域名或 IP，**不要**带 `http://` 或路径 |
| `port` | ❌ | `25565` | 游戏端口（SLP 走这个端口的 TCP，同时用于图片展示） |
| `queryPort` | ❌ | 等于 `port` | Query 协议的 **UDP** 端口 |
| `timeout` | ❌ | `3000` | 单个协议的超时（毫秒），范围 500–10000 |
| `refresh` / `nocache` | ❌ | — | `1`/`true` 跳过缓存强制重查 |
| `name` | ❌ | — | **自定义显示名称**，替换标题里的 `host:port`（最长 60 字符，不能含换行/控制字符） |
| `theme` / `layout` / `style` | ❌ | — | 只影响图片；JSON 里会原样回显，见[第 4 节](#4-主题--布局--视觉语言) |
| `scale` | ❌ | `2` | 对 JSON 无效，仅为与图片接口共用参数解析 |

在线响应示例：

```json
{
  "online": true,
  "host": "play.example.com",
  "port": 25575,
  "queryPort": 25577,

  "motd": "[金羊毛] Golden Fleece Server 把世界建成你喜欢的样子，和方可梦一起🔮",
  "motdRaw": "[金羊毛] Golden Fleece Server\n把世界建成你喜欢的样子，和方可梦一起🔮",
  "motdLines": ["[金羊毛] Golden Fleece Server", "把世界建成你喜欢的样子，和方可梦一起🔮"],

  "players": 9,
  "maxPlayers": 16,
  "playerList": ["Chexiaya", "xiaochengzi23", "Yun_feng112"],
  "playerListSource": "query",
  "samplePlayers": [
    { "name": "Yoghj", "id": "c2214e74-0077-40a5-957e-c2d429a3c72e" }
  ],

  "version": "1.21.1",
  "protocol": 767,
  "latencyMs": 430,
  "serverIcon": "data:image/png;base64,iVBORw0KGgo...",

  "software": "Paper on 1.21.1-R0.1-SNAPSHOT",
  "plugins": ["WorldEdit 7.3.0", "EssentialsX 2.20.1"],
  "map": "world",
  "gametype": "SMP",
  "gameId": "MINECRAFT",
  "serverIp": "203.0.113.10",
  "serverPort": 25575,

  "sources": { "query": true, "ping": true },
  "queryError": null,
  "pingError": null,
  "queriedAt": "2026-09-22T00:10:00.000Z",
  "durationMs": 780,

  "theme": "default",
  "layout": "stack",
  "style": "material"
}
```

字段速查：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `motd` / `motdRaw` / `motdLines` | SLP 优先 | 去掉 § 颜色码的 MOTD / 原始 / 最多两行（与原版多人列表一致） |
| `players` / `maxPlayers` | Query 优先，否则 SLP | 在线人数 / 上限 |
| `playerList` | Query（完整） | 只有 SLP 时是采样列表 |
| `playerListSource` | — | `query`（完整） / `slp-sample`（采样） / `null` |
| `samplePlayers` | SLP | SLP 采样，带 UUID（原版列表里唯一带 UUID 的来源） |
| `version` / `protocol` | SLP 优先 | 版本名 / 协议号（如 `767`） |
| `latencyMs` | SLP | 状态交换的往返耗时，≈ 多人列表里的信号格 |
| `serverIcon` | SLP | `data:image/png;base64,...`（64×64） |
| `software` / `plugins` | Query | 服务端软件名 / 插件列表 |
| `sources` | — | 两个协议各自是否成功 |
| `cached` | — | 这条结果是否来自 30 秒内存缓存 |
| `theme` / `layout` / `style` | — | 回显本次生效的展示组合 |
| `queryError` / `pingError` | — | 各自失败原因（在线时也保留，便于排查） |
| `error` / `errorCode` | — | 仅当**两个协议都失败**时才有值 |

离线 / 超时（HTTP 仍为 **200**）：

```json
{
  "online": false,
  "error": "TCP ECONNREFUSED: could not reach play.example.com:25575 (server offline, or the port is closed)",
  "errorCode": "CONNECTION_ERROR",
  "sources": { "query": false, "ping": false },
  "playerList": []
}
```

### `GET /api/banner.png`

参数同 `/api/status`，另加：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `scale` | `2` | 输出倍数：`1` / `2` / `3`（宽度 = 800 × scale） |

返回头：

```
Content-Type: image/png
Cache-Control: public, max-age=30
ETag: W/"..."
X-Query-Status: online | offline
X-Query-Source: play.example.com:25577
Access-Control-Allow-Origin: *
```

**永远返回图片**，不会 500 / 空白：

| 场景 | HTTP | 返回 |
| --- | --- | --- |
| 在线 | 200 | 状态图 |
| 离线 / 超时（两个协议都失败） | 200 | 离线状态图（红色状态点 + 失败原因 + 排查提示） |
| 参数非法（缺 host、端口越界、scale 越界…） | 400 | 「Invalid request」说明图 |
| 渲染异常 | 500 | 「Render failed」说明图 |

### `GET /api/overview`（多服一览）

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `servers` | ✅（除非配了环境变量） | `OVERVIEW_SERVERS` | 逗号分隔的列表，每项 `[显示名@]host[:port[:queryPort]]`，省略端口时用 `25565` / 等于游戏端口 |
| `timeout` | ❌ | `3000` | 每台服务器的协议超时 |
| `refresh` / `nocache` | ❌ | — | 跳过缓存 |

一次最多 **8 台**（`MAX_OVERVIEW_SERVERS` 可调），多台**并行**查询，返回汇总 + 每台的完整状态：

```bash
# 带自定义显示名（显示名里的中文在 URL 里记得 encode）
curl "http://localhost:3001/api/overview?servers=主服@play.example.com:25565:25566,生存服@play.example.com:25575:25577"
```

```json
{
  "total": 4,
  "online": 3,
  "offline": 1,
  "players": 13,
  "maxPlayers": 58,
  "servers": [
    {
      "online": true,
      "host": "play.example.com",
      "port": 25575,
      "queryPort": 25577,
      "players": 6,
      "maxPlayers": 16,
      "playerList": ["Chexiaya", "..."],
      "playerListSource": "query",
      "motdLines": ["[金羊毛] Golden Fleece Server", "..."],
      "version": "1.21.1",
      "protocol": 767,
      "latencyMs": 405,
      "serverIcon": "data:image/png;base64,...",
      "sources": { "query": true, "ping": true }
    },
    {
      "online": false,
      "host": "play.example.com",
      "port": 25595,
      "queryPort": 25597,
      "error": "TCP ECONNREFUSED: could not reach play.example.com:25595",
      "errorCode": "CONNECTION_ERROR",
      "sources": { "query": false, "ping": false }
    }
  ]
}
```

### `GET /api/overview.png`（多服一览图）

参数同上，另加 `scale`（默认 2 → 宽 1600）与 `theme` / `style`。**高度随服务器数量自适应**：

```
卡片高 = 118 + 台数 × 70 + 18
画布高 = (24 + 卡片高 + 46) × scale
```

例：3 台 → 1600×832；4 台 → 1600×972。

每台服务器占一行，行内包含：

```
● [服务器图标] 显示名称                      12 / 60
               MOTD 首行                    ▂▄▆ 375 ms
               [头像][头像][头像][头像]…
```

- **头像只铺一排、不显示玩家名**（`OVERVIEW.maxAvatars` 默认 15，不需要全量）；0 人在线就不画
- 离线的服务器：红点 + `离线` + 失败原因，不画头像
- 顶部是汇总（`3/4 台在线 · 13 名玩家在线 · 1 台离线`），底部是整批查询的真实耗时

```bash
curl -o overview.png "http://localhost:3001/api/overview.png?servers=play.example.com:25565:25566,play.example.com:25575:25577"
```

```html
<img src="http://localhost:3001/api/overview.png?servers=a.example.com:25565:25566,b.example.com:25565:25566" />
```

> 常用的一批服务器建议直接写进环境变量，之后请求可以不带参数：
> ```bash
> OVERVIEW_SERVERS="play.example.com:25565:25566,play.example.com:25575:25577" npm start
> curl "http://localhost:3001/api/overview.png"
> ```

### 元数据端点

```bash
curl "http://localhost:3001/api/themes"     # 主题列表（含配套 layout / style）
curl "http://localhost:3001/api/layouts"    # 布局列表
curl "http://localhost:3001/api/styles"     # 视觉语言列表
```

```json
// GET /api/themes
{
  "default": "default",
  "themes": [
    {
      "name": "midnight",
      "label": "Midnight Galaxy · 星空紫",
      "source": "theme-factory: midnight-galaxy",
      "mode": "dark",
      "layout": "split",
      "style": "cosmic",
      "styleLabel": "宇宙颗粒"
    }
  ]
}
```

### `GET /healthz`

```json
{
  "ok": true,
  "uptimeSeconds": 128,
  "cache": { "entries": 3, "alive": 3, "ttlMs": 30000, "maxEntries": 500 }
}
```

其它路径返回 404 JSON（本服务**只提供 API**，没有页面）：

```json
{
  "error": "Not Found",
  "endpoints": [
    "/api/status", "/api/banner.png", "/api/overview", "/api/overview.png",
    "/api/themes", "/api/layouts", "/api/styles", "/healthz"
  ]
}
```

### 自定义显示名称

把标题里的 `host:port` 换成你想要的名称（游戏里那种「服务器名」）：

```
/api/banner.png?host=play.example.com&port=25575&queryPort=25577&name=金羊毛主服
/api/overview.png?servers=主服@play.example.com:25565:25566,生存服@play.example.com:25575:25577
```

- 单服用 `name=`，多服一览用 `显示名@host:port:queryPort`
- 有显示名时，**图上不再出现 `host:port`**（名称完全取代地址）；没传显示名时才用 `host:port` 当标题
- `name` 只影响展示，**不参与缓存 key**，所以同一个地址换名字不会多查一次
- 校验：最长 60 字符，含换行/控制字符直接 400（`NAME_INVALID`）

### 错误码

| `errorCode` | 含义 |
| --- | --- |
| `CONNECTION_ERROR` | TCP 建连失败（服务器离线 / 端口未开放） |
| `TIMEOUT` | 超时未响应 |
| `SOCKET_ERROR` / `SEND_ERROR` | UDP 套接字 / 发包失败 |
| `BAD_CHALLENGE` | Query 握手返回了异常的 challenge token |
| `BAD_RESPONSE` | 响应无法解析 |
| `HOST_REQUIRED` / `HOST_TOO_LONG` / `HOST_INVALID` | host 缺失 / 过长 / 含协议前缀或路径 |
| `PORT_INVALID` / `QUERYPORT_INVALID` | 端口不是 1–65535 的整数 |
| `TIMEOUT_INVALID` / `SCALE_INVALID` | 参数超范围 |
| `THEME_INVALID` / `LAYOUT_INVALID` / `STYLE_INVALID` | 主题 / 布局 / 视觉语言不在可用列表内 |
| `SERVERS_REQUIRED` | 多服一览缺少 `servers` 参数 |
| `TOO_MANY_SERVERS` | 一次请求的服务器数量超过上限 |
| `SERVER_ENTRY_INVALID` | 服务器条目格式不对（应为 `[显示名@]host[:port[:queryPort]]`） |
| `NAME_INVALID` | 显示名称过长或含换行/控制字符 |
| `UNKNOWN` | 兜底 |

> 查询阶段的 `error` 文本统一是英文（对程序化调用更友好）；图片上则按 `errorCode` 映射成当前语言的说明，所以**没有 CJK 字体的机器也不会画出一堆方框**。

### 调用示例

```bash
# JSON
curl "http://localhost:3001/api/status?host=play.example.com&port=25565&queryPort=25566"

# 只取人数
curl -s "http://localhost:3001/api/status?host=play.example.com&queryPort=25566" | jq '.players, .maxPlayers'

# 图片（默认 1600x800）
curl -o banner.png "http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566"

# 老规格 800x400
curl -o banner-800.png "http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566&scale=1"

# 多服一览图（一行一台）
curl -o overview.png "http://localhost:3001/api/overview.png?servers=play.example.com:25565:25566,play.example.com:25575:25577"

# 多服汇总 JSON
curl -s "http://localhost:3001/api/overview?servers=play.example.com:25565:25566,play.example.com:25575:25577" | jq '{online, players}'

# 跳过 30 秒缓存强制重查
curl "http://localhost:3001/api/status?host=play.example.com&queryPort=25566&refresh=1"
```

`<img>` / Markdown / 定时刷新：

```html
<img src="http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566" alt="server status" />
```

```markdown
![server status](http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566)
```

```html
<img id="banner" alt="status" />
<script>
  const q = 'host=play.example.com&port=25565&queryPort=25566';
  const draw = () => { document.getElementById('banner').src = `/api/banner.png?${q}&t=${Date.now()}`; };
  draw();
  setInterval(draw, 30000); // 服务端缓存 30 秒，正好对齐
</script>
```

---

## 4. 主题 / 布局 / 视觉语言

图片外观由三个**互相独立**的参数控制，可以任意组合（`7 × 5 × 3 = 105` 种）：

| 参数 | 取哪些值 | 接口 | 决定什么 |
| --- | --- | --- | --- |
| `theme` | 7 套配色 | `GET /api/themes` | 底色、状态色、强调色、明暗模式（其余表面色按明暗自动推导） |
| `style` | 5 种视觉语言 | `GET /api/styles` | 背景怎么铺、卡片什么材质、分隔线怎么画、标签排版、装饰元素 |
| `layout` | 3 种版式 | `GET /api/layouts` | 信息如何排布（卡片堆叠 / 紧凑横条 / 左右分栏） |

```bash
# 用主题配套的组合（推荐）
curl -o a.png "http://localhost:3001/api/banner.png?host=play.example.com&theme=midnight"

# 自由组合：深紫配色 + 瑞士网格 + 紧凑横条
curl -o b.png "http://localhost:3001/api/banner.png?host=play.example.com&theme=midnight&style=swiss&layout=compact"
```

**优先级：显式参数 > 主题配套值 > 全局默认**（`BANNER_THEME` / `BANNER_LAYOUT`）。三个参数都只影响展示，**不参与缓存 key**，切换不会触发重新查询。未知值直接 400，并在报错里列出可用值。

### 主题（7 套）

| 主题 | 模式 | 配套布局 | 配套视觉语言 | 来源 |
| --- | --- | --- | --- | --- |
| `default` | 深色 | `stack` | `material` | 本项目（深色靛蓝，和最初版本一致） |
| `midnight` | 深色 | `split` | `cosmic` | theme-factory: midnight-galaxy |
| `ocean` | 深色 | `stack` | `swiss` | theme-factory: ocean-depths |
| `forest` | 深色 | `compact` | `organic` | theme-factory: forest-canopy |
| `sunset` | 深色 | `split` | `editorial` | theme-factory: sunset-boulevard |
| `frost` | **浅色** | `stack` | `material` | theme-factory: arctic-frost |
| `mono` | **浅色** | `compact` | `swiss` | theme-factory: modern-minimalist |

主题的实现方式是「底色 + 状态色 + 强调色 + 明暗模式」，其余表面色（卡片 / 胶囊 / 分隔线 / 文字灰阶）按明暗模式推导 —— 所以浅色主题能自动拿到深色文字。

### 视觉语言（5 种）

| `style` | 处理方式 | 默认用在 |
| --- | --- | --- |
| `material` | 半透明材质卡片 + 顶部亮边 + 柔和投影 + 渐变淡出分隔线 | `default`、`frost` |
| `swiss` | 平面色块 + 全宽发丝线 + 无投影 + 模数网格背景 + 四角刻线 + 标签大写宽字距 | `ocean`、`mono` |
| `cosmic` | 确定性伪随机微粒背景 + 强调色外发光 + 虚线分隔 + 标题放大 | `midnight` |
| `organic` | 大圆角 + 三块柔和色斑背景 + 圆点分隔 + 无边框 | `forest` |
| `editorial` | 顶部实色带 + 卡片左侧粗规线 + 扁平卡片 + 左段短分隔 + 标签大写 | `sunset` |

（实现集中在 `src/image.js` 的 `STYLES` 与 `drawBackground` / `drawCard` / `drawSoftDivider` / `drawStyleDecorations`。）

### 布局（3 种）

| 布局 | 尺寸 | 形态 |
| --- | --- | --- |
| `stack`（默认） | 800 × 动态 | 卡片堆叠：图标 + 名称 + 状态 + MOTD + 玩家网格（带名字） |
| `compact` | **800 × 218** | 紧凑横条：一行信息 + 一条头像带（不带名字），适合签名 / 公告 |
| `split` | 800 × 动态（≥400） | 左右分栏：左边图标 / 名称 / MOTD / 人数，右边头像墙（不带名字，按列数换行） |

---

## 5. 图片规格

图片默认 **1600×800**（`scale=2`）。原因：800×400 的图在 HiDPI 屏或聊天窗里被放大显示时一定会发虚，这是分辨率问题，不是抗锯齿问题（实测内部 2x 超采样只把文字边缘能量提升 0.2~0.4%）。

| 变量 / 参数 | 默认 | 作用 |
| --- | --- | --- |
| `scale`（URL 参数） | `2` | 输出倍数 1–3（宽度 = 800 × scale） |
| `BANNER_DEFAULT_SCALE` | `2` | 改默认输出倍数（想让接口默认回到 800×400 就设 1） |
| `BANNER_SUPERSAMPLE` | `2` | 内部超采样倍数（矢量边、圆角、CJK 笔画更干净） |

### `stack` 布局高度公式

宽度固定 800 × scale；**高度按玩家数量自适应** —— 每行固定 5 个玩家，玩家多就加行：

```
行数   = ceil(min(玩家数, BANNER_MAX_PLAYERS) / 5)
卡片高 = max(336, 284 + (行数 − 1) × 34 + 28)     // 行高 34、头像 28
画布高 = 24 + 卡片高 + 40                          // 再乘 scale
```

例：≤5 人 → 1 行 → 高 400；6–10 人 → 2 行 → 高 410；12 人 → 3 行 → 高 444；20 人 → 4 行 → 高 478。

**默认把在线玩家全部画出来**（不截断到 10 个），超过 `BANNER_MAX_PLAYERS`（默认 100）才截断并显示「显示 x / y 人」。

### 图像处理细节

- **玩家头像是完整方形、不做圆角裁剪**：直接从皮肤裁「脸 + 帽子层」画成整块方形（游戏里皮肤头本来就是方块），不切角、不加边框
- **缩放策略按方向决定**：源图比目标大（缩小）开平滑更清晰；比源大（放大）关平滑保持像素画质感
- **头像并发失败会自动重试一次**：首次对 mc-heads 发起 10 个并发请求时偶发超时，重试后基本都能拿到

---

## 6. 玩家头像

默认**不依赖任何第三方头像服务**，头像由本项目自己渲染：

```
玩家名 ──▶ api.mojang.com/users/profiles/minecraft/<name>        （404 = 离线服/非正版账号）
       ──▶ sessionserver.mojang.com/session/minecraft/profile/<uuid>
       ──▶ textures.minecraft.net/texture/<hash>                 （64x64 或 legacy 64x32 皮肤贴图）
       ──▶ 自己裁「脸(8,8,8,8)」+「帽子层(40,8,8,8)」→ 最近邻放大成头像
```

为什么这样做：

- **完全自主可控**：裁剪、缩放、圆角都由我们决定，且**按设备像素渲染**（2x 输出就渲染 2 倍大），画上去是 1:1，像素画不会被缩放糊掉
- **更轻**：皮肤贴图只有几百字节～几 KB，比每次拉一张现成头像图小得多
- **判定准确**：Mojang 对不存在的名字返回 **404**，可以立刻判定「这个玩家没有皮肤」，不用再去猜

### 数据源链

`BANNER_AVATAR_PROVIDERS`（默认 `mojang,mccag,mc-heads`）从左到右依次尝试，第一个成功即采用：

| 数据源 | 说明 |
| --- | --- |
| `mojang` | 上面的自研链路（默认首选），要全自研就设 `BANNER_AVATAR_PROVIDERS=mojang` |
| `mccag` | 隔壁的头像服务（`BANNER_MCCAG_BASE`，默认 `http://127.0.0.1:3000`），渲染带立体感；不可用会自动跳过 |
| `mc-heads` | 第三方头像服务，作为兜底；同时保留「默认脸」识别逻辑 |

任何一个数据源失败都会自动尝试下一个；`mojang` 明确返回 404（确认无皮肤）时**直接短路到字母头像**，不会再去问后面的源。

### 头像渲染风格（`BANNER_AVATAR_STYLE`）

| 值 | 效果 |
| --- | --- |
| `minimal`（默认） | **对齐 mccag 的 minimal**：平面脸 + 比脸大 9.3% 的帽子层 + 柔和投影，透明背景 —— 头发/帽子会自然溢出脸的边缘，轮廓带起伏 |
| `3d` | 立体头：正面 + 顶面 + 右侧面（右上方俯视），顶面/侧面带明暗 |
| `flat` | 最朴素的平面头像：脸 + 同尺寸帽子层，铺满整张图 |

**minimal 的构图参数**（取自 mccag 的 `Scripts/Data.js`，在 `src/skin.js` 的 `MINIMAL_LAYOUT`）：

```
画布 1000x1000（透明底）
脸   ：贴图 (8,8,8,8)  →  放大到 600，贴在 (200,200)
帽子层：贴图 (40,8,8,8) →  放大到 656，贴在 (175,175)     ← 比脸大 9.3%
投影 ：rgba(0,0,0,0.2)，blur 15，无偏移
```

画图时会把 mccag 原版四周的空白裁掉，让头填满整个槽位（`fill` 默认 0.96，留一点边给投影）。

> **legacy 皮肤（64×32）没有帽子层**：老皮肤在贴图右侧 (40,8) 那一带往往是别的部位甚至纯黑像素，
> 无条件按帽子层叠上去会把整张脸糊成黑块（Notch 就是这种皮肤）。所以只有 64×64 的现代皮肤才会叠帽子层。

### 没有皮肤的玩家

离线服 / 非正版账号在 Mojang 里查不到（HTTP 404），此时按 `BANNER_AVATAR_FALLBACK` 处理：

- `letter`（默认）：画**按名字取色的字母头像**，每人颜色不同、可区分，不会出现一排重复的「史蒂夫」
- `plain`：显示头像源返回的默认脸（若用的是 mc-heads，会出现多张一样的默认脸）

想完全关掉头像（内网 / 无外网）：`BANNER_AVATARS=off`，全部走字母头像。

### 头像相关缓存

| 缓存 | TTL | 说明 |
| --- | --- | --- |
| 名字 → UUID | 1 小时 | 基本不变 |
| 皮肤贴图 | 5 分钟 | 玩家可能换皮肤 |
| 渲染好的头像 | 5 分钟（最多 300 条） | 按「尺寸:玩家名」缓存 |

Mojang 的 `api.mojang.com` 有速率限制（约 600 次/10 分钟/IP），这些缓存就是为它准备的：一台 10 人服首次渲染约 10 组请求，之后 5 分钟内全部命中缓存。

---

## 7. 字体

项目自带 **HarmonyOS Sans SC** 全字重（`assets/fonts/`，6 个文件共约 **47MB**），中英文都由它渲染：

| 字重 | 用在哪里 |
| --- | --- |
| `Black` | 大号数字（在线人数 `12`、一览行人数 `0 / 20`） |
| `Bold` | 标题、地址、状态文字 |
| `Medium` | 小节标签、胶囊标签、玩家名、一览行地址 |
| `Regular` | 正文、次要信息、图注 |
| `Light` | MOTD 正文 |
| `Thin` | 已注册备用（改 `src/image.js` 里的 `WEIGHT_FALLBACK` 或调用处的 `weight` 即可启用） |

```
HarmonyOS_Sans_SC_Thin.ttf     8.02 MB
HarmonyOS_Sans_SC_Light.ttf    7.95 MB
HarmonyOS_Sans_SC_Regular.ttf  7.88 MB
HarmonyOS_Sans_SC_Medium.ttf   7.85 MB
HarmonyOS_Sans_SC_Bold.ttf     7.78 MB
HarmonyOS_Sans_SC_Black.ttf    7.75 MB
```

（授权文件随字体一起放在 `assets/fonts/LICENSE.txt`。）

**字体栈**：`"HarmonyOS Sans <字重>", "MCBannerCJK", sans-serif` —— 前两个都缺某个字形时，仍由系统 CJK 字体兜底（Pango 逐字形回退），不会画出方框。

**想省体积**：删掉用不到的字重即可（例如只留 `Regular` / `Medium` / `Bold`，约 23MB）；或换成纯拉丁的 HarmonyOS Sans 子集（每个约 145KB）—— 但那种文件里没有汉字，中文会退回系统字体渲染。

**换字体**：把同名文件放进 `assets/fonts/`，或用 `BANNER_FONT_DIR` 指向自己的字体目录：

```bash
BANNER_FONT_DIR=/app/my-fonts npm start
```

> node-canvas 的 `registerFont` 只能按「字体族」注册、不支持 `font-weight`，
> 所以本项目把每个字重**注册成独立族名**（`HarmonyOS Sans Bold` 等），
> 并在缺失时按 `WEIGHT_FALLBACK` 链降级；字体栈里不写 `bold` 关键字，避免触发合成加粗。

### emoji 与符号字体

中英文是自带的，但 **emoji 仍然依赖系统字体**，而且这里有两个坑：

1. **彩色 emoji 是位图字体**（NotoColorEmoji 用 CBDT、Apple / Segoe 用 sbix）。cairo + FreeType 的
   组合稍旧就栅格化不出来，表现是 emoji 变成**空白或豆腐块** —— 装了字体不等于画得出来。
2. **emoji 不只在 U+1F000 以上**。BMP 里有两类都要单独交给 emoji 字体：
   默认就是 emoji 呈现的（`✨ ⚡ ⭐ ✅ ⌚ ⏰`），以及默认文本呈现、必须跟一个 `U+FE0F` 才算 emoji 的
   （`☀️ ❤️ ⚔️ ⛏️ ↔️`）。而 `★ ✂ ™ ♥` 这类**本来就不是 emoji**，仍旧走主字体栈 ——
   塞给 emoji 字体反而会画成「里面写着码位的方框」（emoji 字体确实没有这些字形，实测 Segoe UI Emoji 就没有 `★`）。

所以服务启动时会**把候选字体逐个试画一遍**，只采用真能画出来的：

| 用途 | 自检样本 | 候选（按优先级） |
| --- | --- | --- |
| 星体面 emoji（🔮🎮） | 🔮 | NotoColorEmoji → Noto Emoji → Symbola → Noto Sans Symbols 2 → Apple Color Emoji → Segoe UI Emoji |
| BMP 符号（⭐✨） | ⭐ | 同上 |

- 判定标准：**画出了像素**、**不等于缺字豆腐块**、且**步进宽度合理**（位图字体只有一个像素尺寸时字距会被撑开）
- 彩色字体不合格会自动退到**单色轮廓字体**（Symbola / Noto Emoji），后者任何 cairo 都画得出来
- 两份字体允许不同：只拿到符号字体时，`🔮` 这类星体面 emoji 会被**整段丢掉**（宁可没有，也不画方框），`⭐✨` 照常渲染
- 一个 emoji 字体都没有时：星体面 emoji 丢掉，BMP 符号交回主字体栈（DejaVu 提供 `★ ☆ ✓ ⚠` 等字形）
- 除了写死的路径，还会扫 `/usr/share/fonts` 等目录找文件名含 `emoji` / `symbola` / `symbols` 的字体

容器里需要装的字体（见 `Dockerfile`）：

```bash
apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-color-emoji fonts-symbola
```

---

## 8. 缓存

- TTL **30 秒**，key 为 `${host}:${port}:${queryPort}`（`scale`、`name`、`theme`、`layout`、`style` 都不参与 key，因为图片和 JSON 共用同一份状态）
- 缓存的是 **Promise**：并发的 JSON / 图片请求只会触发一轮真实的 UDP + TCP 查询，不会击穿
- 响应头 `Cache-Control: public, max-age=30`，配合 express 默认 ETag（重复请求会走 304）
- 内存上限 500 条，超出后先清过期、再按过期时间淘汰最旧
- `?refresh=1` 可跳过缓存
- 多服一览里每台服务器用**自己的 key**，所以「先单独查过 A，再查 A+B 一览」时 A 直接命中缓存

---

## 9. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | API 监听端口 |
| `LOG_REQUESTS` | `on` | 请求日志，`off` 关闭（排查「请求有没有打到本服务」时很有用） |
| `OVERVIEW_SERVERS` | — | 多服一览的默认服务器列表，配好后 `/api/overview.png` 可以不传参 |
| `MAX_OVERVIEW_SERVERS` | `8` | 多服一览一次最多查多少台 |
| `BANNER_THEME` | `default` | 默认主题（7 套可选，见第 4 节） |
| `BANNER_LAYOUT` | `stack` | 默认布局（`stack` / `compact` / `split`）；传了主题时以主题配套为准 |
| `BANNER_DEFAULT_SCALE` | `2` | 图片默认输出倍数（1 = 800×400） |
| `BANNER_SUPERSAMPLE` | `2` | 内部超采样倍数 |
| `BANNER_LABELS` | `auto` | `auto` / `zh` / `en`，图片标签语言 |
| `BANNER_MAX_PLAYERS` | `100` | 单服图最多渲染多少个玩家头像（超出则截断并标注「显示 x / y」） |
| `BANNER_AVATARS` | `on` | 设 `off` 则完全不请求头像（内网 / 无外网环境） |
| `BANNER_AVATAR_PROVIDERS` | `mojang,mccag,mc-heads` | 头像数据源链，从左到右依次尝试 |
| `BANNER_AVATAR_STYLE` | `minimal` | 头像风格：`minimal` / `3d` / `flat` |
| `BANNER_AVATAR_FALLBACK` | `letter` | 玩家没有皮肤时：`letter` = 按名字取色的字母头像，`plain` = 显示头像源的默认脸 |
| `BANNER_AVATAR_BASE` | `https://mc-heads.net` | 第三方头像源，可换自建镜像（需兼容 `/avatar/<name>/50`） |
| `BANNER_MCCAG_BASE` | `http://127.0.0.1:3000` | mccag 头像服务地址，不可用会自动跳过 |
| `BANNER_FONT_DIR` | `assets/fonts` | 自定义 UI 字体目录（放同名文件即可整组替换，缺字重会自动降级） |
| `BANNER_FONT_PATH` | — | 指定 CJK 字体文件（如 `wqy-microhei.ttc`） |
| `BANNER_FONT_FAMILY` | — | 配合上一项使用的字体族名 |

---

## 10. 部署

### Docker（推荐，开箱即用）

项目自带 `Dockerfile` 与 `docker-compose.yml`：

```bash
docker compose up -d --build       # 端口、环境变量都在 compose 文件里
docker compose logs -f
```

单独用 Docker 也可以：

```bash
docker build -t mcstatus-api .
docker run -d --name mcstatus-api -p 3001:3001 \
  -e OVERVIEW_SERVERS="主服@play.example.com:25565:25566" \
  mcstatus-api
```

镜像基于 `node:20-slim`，里面装了三套字体（slim 基础镜像默认一个系统字体都没有）：

| 包 | 作用 |
| --- | --- |
| `fonts-dejavu-core` | `★ ☆ ✓` 这类文本符号，兼作主字体栈的兜底 |
| `fonts-noto-color-emoji` | 彩色 emoji（CBDT 位图字体），cairo 支持时优先用它 |
| `fonts-symbola` | 单色轮廓字体、覆盖面很广；彩色那套栅格化不了时自动退到它 |

中文字体（HarmonyOS Sans SC）是项目自带的，不需要额外安装。启动日志会打印实际选中的字体文件，
排查 emoji / 中文显示问题时先看它。镜像内置 `HEALTHCHECK`（探测 `/healthz`），并以非 root 的 `node` 用户运行。

### systemd 常驻

推荐直接把项目放到 `/opt/mcstatus-api` 用 systemd 托管 —— **崩溃自动拉起 + 开机自启**。

```bash
# 1) 放到稳定位置并安装生产依赖
cp -r mcstatus-api /opt/mcstatus-api
cd /opt/mcstatus-api && npm install --omit=dev

# 2) 复制项目自带的 unit 文件
cp deploy/mcstatus-api.service /etc/systemd/system/

# 3) 启用并启动
systemctl daemon-reload
systemctl enable --now mcstatus-api
```

`deploy/mcstatus-api.service` 的内容：

```ini
[Unit]
Description=mcstatus-api — Minecraft 服务器状态 JSON / 状态图 API
Documentation=file:///opt/mcstatus-api/README.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0          # 不限制重启次数

[Service]
Type=simple
WorkingDirectory=/opt/mcstatus-api
ExecStart=/usr/bin/node src/index.js

Environment=NODE_ENV=production
Environment=PORT=3001
Environment=BANNER_DEFAULT_SCALE=2
Environment=BANNER_AVATAR_PROVIDERS=mojang,mccag,mc-heads
Environment=BANNER_MCCAG_BASE=http://127.0.0.1:3000
Environment="OVERVIEW_SERVERS=主服@play.example.com:25565:25566,生存服@play.example.com:25575:25577"

Restart=always                   # 崩溃/被杀自动拉起
RestartSec=5                     # 5 秒后重试
TimeoutStopSec=10                # 优雅退出最多等 10 秒

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mcstatus-api    # journalctl -u mcstatus-api 的标识

NoNewPrivileges=true             # 轻度加固：不提权、不写盘
PrivateTmp=true

[Install]
WantedBy=multi-user.target       # 开机自启
```

### 常用命令

```bash
systemctl status mcstatus-api           # 状态（含最近日志）
systemctl restart mcstatus-api          # 重启（改完配置/代码后）
systemctl stop mcstatus-api             # 停止
systemctl is-enabled mcstatus-api       # 是否开机自启（enabled）
journalctl -u mcstatus-api -f           # 实时日志
journalctl -u mcstatus-api -n 100       # 最近 100 行
journalctl -u mcstatus-api --since today
```

### 验证自动拉起

```bash
systemctl kill -s SIGKILL mcstatus-api   # 模拟进程崩溃
systemctl status mcstatus-api            # 应该是 active (running)，MainPID 变了
```

### 关于「改代码」

systemd 跑的是 `/opt/mcstatus-api`，所以**改代码要改这个目录**（改完 `systemctl restart mcstatus-api`）。
如果你在别处（比如开发目录）改，记得同步过去：

```bash
rsync -a --delete --exclude node_modules --exclude test-output \
      /path/to/mcstatus-api/ /opt/mcstatus-api/ && systemctl restart mcstatus-api
```

### 备选：PM2

```bash
npm i -g pm2
PORT=3001 BANNER_DEFAULT_SCALE=2 pm2 start src/index.js --name mcstatus-api
pm2 save && pm2 startup            # 生成开机自启项（按提示执行输出的那条命令）
pm2 logs mcstatus-api
```

---

## 11. 项目结构

```
mcstatus-api/
├── package.json
├── package-lock.json
├── Dockerfile               # 容器镜像（node:20-slim + 符号/emoji 字体 + HEALTHCHECK）
├── docker-compose.yml       # 一键起服务（端口与环境变量都写在这里）
├── .gitignore
├── .dockerignore
├── README.md                # 简体中文（本文件）
├── README.en.md             # English
├── assets/
│   └── fonts/               # HarmonyOS Sans SC 6 个字重（约 47MB，中英文全覆盖）+ LICENSE
├── deploy/
│   └── mcstatus-api.service # systemd unit
├── src/
│   ├── index.js             # Express 入口：路由、参数校验、响应头、请求日志
│   ├── query.js             # GameSpy4 Query（UDP）：握手、全量解析、插件/玩家解析
│   ├── ping.js              # Server List Ping（TCP）：favicon、延迟、协议号、两行 MOTD
│   ├── skin.js              # 自己取皮肤并渲染头像（Mojang 接口 + canvas 裁剪/像素放大）
│   ├── status.js            # 两协议并行 + 合并 + 30 秒内存缓存
│   └── image.js             # node-canvas 绘制状态图（主题/布局/视觉语言 + 超采样 + 字体/emoji 处理）
└── test/
    ├── mock-server.mjs      # 假服务器：TCP SLP + UDP Query + 现画图标（可直接运行）
    └── smoke.mjs            # 端到端自测：61 项断言
```

---

## 12. 故障排查

| 玩家 | 排查方向 |
| --- | --- |
| 图片显示离线，`errorCode: CONNECTION_ERROR` | 服务器没开，或 **TCP** 游戏端口被防火墙挡住 |
| 在线但 `playerList` 为空、`playerListSource: "slp-sample"` | Query 没开（`enable-query=true`）或 **UDP** query 端口没放行。看 `queryError` |
| `latencyMs` 很大（几百 ms） | 本机到服务器的网络距离；这是 SLP 往返耗时，与游戏内延迟同量级 |
| 图上有方块（豆腐块） | 没装 CJK 字体，见第 7 节；启动日志会打印系统 CJK 字体有没有找到 |
| MOTD 里的 emoji 不见了 | 没有任何可用的 emoji 字体：容器里装 `fonts-noto-color-emoji`（彩色）或 `fonts-symbola`（单色兜底），见第 7 节；启动日志会写明选中了哪个字体文件 |
| emoji 是黑白的 / 和旁边彩色的不一致 | 彩色 emoji 字体没通过自检（cairo 栅格化不了 CBDT），自动降级到了单色字体，属预期行为 |
| 头像不显示 | 无外网 → `BANNER_AVATARS=off`；或用 `BANNER_AVATAR_BASE` 指向自建镜像 |
| 好几个头像是同一个「史蒂夫」 | 那些玩家是离线服 / 非正版账号，Mojang 里查不到（404）。默认换成按名字取色的字母头像；`BANNER_AVATAR_FALLBACK=plain` 或把 `mc-heads` 放前面时会出现多张一样的默认脸 |
| 头像取不到 / 想要纯本地 | `BANNER_AVATAR_PROVIDERS=mojang` 只用自研链路；完全不要头像用 `BANNER_AVATARS=off` |
| 图片发虚 | 用默认 `scale=2`（1600×800）；确认 `BANNER_DEFAULT_SCALE` 没被设成 1 |
| 主题 / 布局不生效 | 三个参数优先级是「URL > 主题配套 > 全局默认」，显式传 `layout` / `style` 会覆盖主题配套值 |
| `canvas` 装不上 | Node 版本低于 18；或参照 node-canvas wiki 装 `libcairo` / `libpango` |
| JSON 里 MOTD 乱码 | 服务端 MOTD 不是 UTF-8（少数老端或代理），属于服务端问题 |
| 改了服务器配置没生效 | `server.properties` 改完必须**重启服务器** |
| 一览图里某一台显示离线 | 单独查那一台看 `errorCode`；常见是端口写错或该端口没开 Query |

---

## 13. 设计说明

图片的视觉语言参考 Apple 的设计原则，落在静态图上主要是四条：

- **材质与层次**：内容放在一块半透明材质卡片里（淡填充 + 顶部亮边渐变描边 + 柔和投影），背景用**服务器图标的平均色**做一层极淡的环境光晕 —— 换服务器图标，整张图的色调会跟着变
- **排版**：字距随字号变化（25px 地址 `-0.5px`、19px 正文 `-0.2px`、11px 小标签 `+0.9px`），层级由「字号 + 字重 + 行距」共同建立，而不是只堆字号
- **不要生硬分隔线**：两条分隔线改成两端淡出的软渐变
- **克制**：只有状态点、延迟格用语义色（绿 / 黄 / 红），其余交给透明度层级 + 环境色

三个实现上的限制（改样式前请先看这条）：

1. node-canvas **不支持 `ctx.letterSpacing`**（实测 `false`），所以字距是按码点逐单元累加手写的 —— 好处是顺便避免了拆断代理对
2. 所有文字都走 `drawRichText()`，它同时负责**逐单元字体切换 + 字距 + 右/中对齐 + 按宽度截断**。新增文字时请用它，不要直接 `ctx.fillText`，否则 emoji 或字距会出问题
3. **emoji 不能靠字体回退**：NotoColorEmoji 会把 ASCII 数字当键帽 emoji 渲染（实测 `"25575"` 宽度从 44.1px 变成 99.6px），
   所以现在按「绘制单元」分别设置字体。emoji 字体本身也要先自检再用（见第 7 节）：
   没有可用字体时星体面 emoji 整段丢掉、BMP 符号回落到主字体栈，都不会画出方框

---

## 14. 为什么没用 `@hloth/minecraft-query`

需求最初点名了这个库，但实测它**无法在纯 Node 下使用**，因此 Query 部分用 `node:dgram` 等价实现（协议逻辑与 `minecraft-server-util` 的 `queryFull` 对齐）：

1. npm 包 `@hloth/minecraft-query@1.0.0` 的 `"main"` 指向 `index.ts`，**只发布了 TS 源码**。`import` 会直接抛
   `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`，即 `npm install && npm start` 跑不起来
2. 它内部**强制做 `_minecraft._udp` SRV 解析**，且一次查询只接受一个端口，无法把游戏端口与 Query 端口分开
3. 它解析全量响应用 `toString('utf-8', 11)`，比协议真实偏移（**16**）少 5 字节，键值对会错位；`info.plugins.split(':')` 在没有 plugins 字段时还会抛异常

自研实现只依赖 Node 内置模块，并额外做了：校验响应包的 sessionId 与包类型（忽略乱序 / 伪造包）、正确处理 vanilla 的 `00 01 player_ 00 00` 玩家段分隔与 11 字节填充、UDP 丢包重试、把无符号 challenge token 收敛到 int32。

---

## 15. License

MIT
