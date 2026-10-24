# Clients

Two ready-made QQ bot integrations. Both are keyword driven: someone types a keyword in a group or a private chat, the bot replies with the image rendered by this API. Neither of them needs a database or any third-party dependency — Node only.

| Client | Runtime | Config lives in |
| --- | --- | --- |
| [koishi-plugin-mcstatus](https://github.com/yunxineko/koishi-plugin-mcstatus) | Koishi 4.18+ | Koishi console forms |
| [napcat-plugin-mcstatus](https://github.com/yunxineko/napcat-plugin-mcstatus) | NapCat ≤ 4.18.5, or any NapCat via OneBot 11 | `rules.json` + `client.config.json` |

Both take a single `apiBaseUrl`, so they work against the public instance or your own deployment.

## koishi-plugin-mcstatus

```bash
# copy the plugin folder into your Koishi plugins dir, then restart
cd koishi-app && npm install
```

Then in the console: **插件配置 → mcstatus**. Every field is a form:

- `apiBaseUrl` — this API's address, e.g. `http://127.0.0.1:3002`
- `sendMode` — send the image directly, or reply with a link
- `timeout` / `cooldown` — per-request timeout and per-session cooldown
- `rules` — add a rule per keyword: `keyword[]` (aliases), `match` (`exact` / `contains` / `regex`), `endpoint` (`banner` / `overview` / `status` / `overview-json`), plus `host`, `port`, `queryPort`, `name`, `theme`, `style`, `layout`
- `rulesFile` — optional path to a NapCat-style `rules.json`; when set, the file wins over the console rules and is hot-reloaded on save, so both clients can share one rule file

## napcat-plugin-mcstatus

Two ways to run it. **B works on every NapCat version**, A only on 4.18.5 and earlier (4.18.11 added an official plugin whitelist).

**A. NapCat plugin** — drop the folder into NapCat's `plugins/`, restart, then configure it in the WebUI.

**B. Standalone OneBot 11 client** (recommended)

```bash
cp rules.example.json rules.json                        # keyword rules
cp client.config.example.json client.config.json        # WebSocket URL + token
node client.mjs
```

`client.config.json` points at NapCat's OneBot WebSocket server (`ws://127.0.0.1:3001`) and its access token. `rules.json` supports `//` comments and trailing commas, and is hot-reloaded — no restart when you add a server.

```jsonc
{
  "rules": [
    {
      "keyword": ["status", "mc"],       // string or array of aliases
      "endpoint": "banner",              // banner / overview / status / overview-json
      "match": "exact",                  // exact / contains / regex
      "params": {
        "host": "mc.example.com",
        "port": 25565,
        "name": "My server",
        "theme": "mono",
        "layout": "split"
      }
    }
  ]
}
```

`params` also accepts a raw query string (`"?host=mc.example.com&port=25565"`), which is handy when copying links from the [playground](https://mcstatus.windwhispers.top/playground).

## Sharing one rule file

Point `rulesFile` in the Koishi plugin at the NapCat client's `rules.json` and only maintain one file. The Koishi side reads it on every change (mtime check), while the console `rules` array keeps working as a fallback for installations that do not have that file.
