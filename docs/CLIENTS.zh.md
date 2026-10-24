# 客户端

现成的两个 QQ 机器人接入。都是关键词驱动：群里或私聊发一句关键词，机器人回一张本 API 渲染的状态图。都不需要数据库，也没有第三方依赖，Node 单进程即可。

| 客户端 | 运行环境 | 配置放在 |
| --- | --- | --- |
| [koishi-plugin-mcstatus](https://github.com/yunxineko/koishi-plugin-mcstatus) | Koishi 4.18+ | Koishi 控制台表单 |
| [napcat-plugin-mcstatus](https://github.com/yunxineko/napcat-plugin-mcstatus) | NapCat ≤ 4.18.5，或任意版本走 OneBot 11 | `rules.json` + `client.config.json` |

两边都只需要填一个 `apiBaseUrl`，指向公共实例或自己部署的地址都行。

## koishi-plugin-mcstatus

把插件目录放进 Koishi 的插件目录，重启后在控制台进 **插件配置 → mcstatus**，全部是表单：

- `apiBaseUrl` —— 本 API 的地址，例如 `http://127.0.0.1:3002`
- `sendMode` —— 直接发图，还是回一个链接
- `timeout` / `cooldown` —— 单次请求超时、同一会话的冷却
- `rules` —— 一条规则一个关键词：`keyword[]`（多个别名）、`match`（`exact` / `contains` / `regex`）、`endpoint`（`banner` / `overview` / `status` / `overview-json`），再加 `host`、`port`、`queryPort`、`name`、`theme`、`style`、`layout`
- `rulesFile` —— 可选，直接指向 NapCat 版那份 `rules.json`。填了之后文件优先于控制台规则，保存即热加载，两种客户端可以共用同一份规则

## napcat-plugin-mcstatus

两种跑法。**B 在所有 NapCat 版本上都能用**，A 只到 4.18.5（4.18.11 起加了官方插件白名单）。

**A. NapCat 插件** —— 目录扔进 NapCat 的 `plugins/`，重启，在 WebUI 里配。

**B. 独立 OneBot 11 客户端**（推荐）

```bash
cp rules.example.json rules.json                    # 关键词规则
cp client.config.example.json client.config.json    # WebSocket 地址 + 令牌
node client.mjs
```

`client.config.json` 指向 NapCat 的 OneBot WebSocket 服务（`ws://127.0.0.1:3001`）和它的 access token。`rules.json` 支持 `//` 注释和尾随逗号，改完保存热加载，加服务器不用重启。

```jsonc
{
  "rules": [
    {
      "keyword": ["状态", "mc"],         // 字符串或别名数组
      "endpoint": "banner",              // banner / overview / status / overview-json
      "match": "exact",                  // exact / contains / regex
      "params": {
        "host": "mc.example.com",
        "port": 25565,
        "name": "我的服务器",
        "theme": "mono",
        "layout": "split"
      }
    }
  ]
}
```

`params` 也可以直接写查询串（`"?host=mc.example.com&port=25565"`），从 [playground](https://mcstatus.windwhispers.top/playground) 拼好链接拷过去最省事。

## 共用同一份规则

把 Koishi 插件里的 `rulesFile` 指向 NapCat 客户端的 `rules.json`，规则只维护一份就行。Koishi 侧按修改时间热加载；没有这个文件的环境，控制台里的 `rules` 数组照旧生效。
