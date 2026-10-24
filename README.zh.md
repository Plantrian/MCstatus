# mcstatus-api
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[简体中文](README.zh.md) | [English](README.md)

Minecraft **Java 版**服务器状态查询 API。同时跑 SLP（TCP）和 GameSpy4 Query（UDP），输出 JSON，或者直接给你一张能贴到群里 / 签名档的 PNG。

- 两个协议**任一成功就算在线**；Query 没开（很常见）时照样有图标、延迟、人数、MOTD，玩家列表退化成 SLP 采样并在图上标注来源
- `port`（游戏端口）和 `queryPort`（Query 端口）完全分离
- 图片默认 **1600×800**（`scale=2`），高度随玩家数自适应；服务器离线、参数非法、渲染失败**也返回一张图**，不会 500、不会空白
- 查询结果缓存 **30 秒**，JSON 与图片共用同一轮查询
- **7 主题 × 5 视觉语言 × 3 布局**，全部走 URL 参数
- 玩家头像自研渲染：自己取皮肤、自己裁剪放大，不依赖第三方头像站

## 快速开始

需要 Node **≥ 18.17**（`canvas` 是原生模块）。

```bash
npm install
npm start                     # 默认监听 3000
```

```bash
curl "http://localhost:3000/api/status?host=play.example.com"
curl -o out.png "http://localhost:3000/api/banner.png?host=play.example.com&port=25565&theme=midnight"
curl -o list.png "http://localhost:3000/api/overview.png?servers=主服@a.example.com:25565:25566,副服@b.example.com:25565"
```

调参用可视化调试台：<http://localhost:3000/playground> —— 左边预览、右边改参数、底下实时生成请求链接。

## 接口

| 端点 | 返回 | 说明 |
| --- | --- | --- |
| `GET /playground` | HTML | 参数调试台 |
| `GET /api/status` | JSON | 单台服务器完整状态 |
| `GET /api/banner.png` | PNG | 单台服务器状态图 |
| `GET /api/overview` | JSON | 多台服务器汇总 + 每台完整状态 |
| `GET /api/overview.png` | PNG | 多台服务器一览图（一行一台） |
| `GET /api/themes` | JSON | 主题列表（含配套 layout / style / 色卡） |
| `GET /api/layouts` | JSON | 布局列表 |
| `GET /api/styles` | JSON | 视觉语言列表 |
| `GET /healthz` | JSON | 健康检查（uptime + 缓存统计） |

全部支持 CORS（`Allow-Origin: *`），`OPTIONS` 返回 204。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `host` | — | **必填**，域名或 IP |
| `port` | `25565` | 游戏端口，用于 SLP |
| `queryPort` | 同 `port` | Query 端口，用于 UDP |
| `servers` | — | overview 专用，`[显示名@]host[:port[:queryPort]]`，逗号分隔，最多 8 台 |
| `timeout` | `5000` | 500–10000 毫秒 |
| `scale` | `2` | 输出倍率 1 / 2 / 3（1× = 800×400） |
| `name` | — | 覆盖标题里的地址 |
| `theme` `layout` `style` | — | 配色 / 布局 / 视觉语言，见下一节 |
| `refresh=1` | — | 跳过 30 秒缓存，强制重新查询 |

不传 `host` 会得到 `400` + `HOST_REQUIRED`（JSON 接口是 JSON 错误，图片接口是一张说明图）。缺 `servers` 同理。

图片接口按 IP 限流 30 次/分、JSON 接口 120 次/分，超了返回 429（图片接口仍然是 PNG），响应头带 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`；`/healthz` 和 `/playground` 不占额度。

## 主题 / 布局 / 视觉语言

| `theme` | 明暗 | 配套 `layout` | 配套 `style` |
| --- | --- | --- | --- |
| `default` | 深色 | `stack` | `material` |
| `midnight` | 深色 | `split` | `cosmic` |
| `ocean` | 深色 | `stack` | `swiss` |
| `forest` | 深色 | `compact` | `organic` |
| `sunset` | 深色 | `split` | `editorial` |
| `frost` | 浅色 | `stack` | `material` |
| `mono` | 浅色 | `compact` | `swiss` |

- **布局**：`stack` 卡片堆叠（默认） / `compact` 800×218 横条 / `split` 左信息右头像墙
- **视觉语言**：`material` 半透明材质 / `swiss` 瑞士网格 / `cosmic` 颗粒星光 / `organic` 大圆角色团 / `editorial` 杂志排版

只传主题就用它配套的布局和视觉语言；想混搭就再加参数：

```bash
/api/banner.png?host=a.example.com&theme=midnight                      # split + cosmic
/api/banner.png?host=a.example.com&theme=midnight&layout=compact&style=swiss
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `LOG_REQUESTS` | `on` | `off` 关闭请求日志 |
| `OVERVIEW_SERVERS` | — | overview 的默认服务器列表，配好后可不带参数调用 |
| `MAX_OVERVIEW_SERVERS` | `8` | 单次一览最多几台 |
| `RATE_LIMIT_ENABLED` | `on` | `off` 关闭限流 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_MAX_IMAGE` | `120` / `30` | JSON / 图片每窗口额度 |
| `BANNER_THEME` | `default` | 默认主题 |
| `BANNER_LAYOUT` | `stack` | 默认布局 |
| `BANNER_DEFAULT_SCALE` | `2` | 默认输出倍率 |
| `BANNER_LABELS` | `auto` | 图内文案语言：`auto` / `zh` / `en` |
| `BANNER_AVATARS` | `on` | `off` 完全不取头像（纯内网时有用） |
| `BANNER_AVATAR_STYLE` | `minimal` | 头像风格：`minimal` / `3d` / `flat` |
| `BANNER_FONT_DIR` / `BANNER_FONT_PATH` | — | 自定义字体目录 / 指定中文字体文件 |

其余（头像源链、mccag 地址、超采样、玩家人数上限等）见 `src/index.js` 与 `src/image.js` 里的 `process.env` 读取处。

## 客户端

现成的 QQ 机器人接入：群里或私聊发个关键词，机器人回一张状态图。

- **[koishi-plugin-mcstatus](https://github.com/yunxineko/koishi-plugin-mcstatus)** —— Koishi 插件。关键词、匹配方式和全部请求参数都在 Koishi 控制台里以表单配置；也能直接加载 NapCat 版那份 `rules.json`，两种客户端可以共用同一份规则。
- **[napcat-plugin-mcstatus](https://github.com/yunxineko/napcat-plugin-mcstatus)** —— NapCat 插件（v4.18.5 及更早）或独立 OneBot 11 客户端（`node client.mjs`，不受 v4.18.11 起插件白名单的影响）。规则写在带注释的 `rules.json` 里，改完保存热加载。

## 部署

```bash
docker compose up -d --build      # 端口和环境变量都在 compose 文件里
```

或者裸 Docker：

```bash
docker build -t mcstatus-api .
docker run -d --name mcstatus-api -p 3001:3001 mcstatus-api
```

镜像基于 `node:20-slim`，额外装了 DejaVu / Noto Color Emoji / Symbola 三个字体包（中文 HarmonyOS Sans SC 随项目自带），内置 `HEALTHCHECK`（探 `/healthz`），以非 root 用户运行。systemd 方式见 `deploy/mcstatus-api.service`。

## 项目结构

```
├── src/index.js     Express 入口：路由、参数校验、限流、请求日志
├── src/ping.js      Server List Ping（TCP）：图标、延迟、版本、MOTD
├── src/query.js     GameSpy4 Query（UDP）：完整玩家、插件、世界
├── src/status.js    并行跑两套协议 + 合并 + 30 秒内存缓存
├── src/skin.js      取皮肤、裁脸放大（自研头像渲染）
├── src/image.js     画布渲染：主题 / 布局 / 视觉语言 / 字体
├── public/          调试台页面（/playground）
└── test/            假服务器 + 端到端自测
```

## 测试

```bash
npm test
```

自带一个假 Minecraft 服务器（TCP + UDP）和一个假头像服务，全程不需要真实服务器，跑完会往 `test-output/` 丢几张图。

## License

MIT
