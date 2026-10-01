# mcstatus-api

[English](README.en.md) | [简体中文](README.md)

A server-status API for **Minecraft Java Edition**. It speaks both query protocols and serves **JSON data** plus **image endpoints that return a PNG directly**:

| Protocol | Transport | What it provides |
| --- | --- | --- |
| **Server List Ping (SLP)** | TCP (game port, `port`) | Server icon (favicon), **latency**, version name + protocol number, two-line MOTD, player sample (with UUIDs) |
| **GameSpy4 Query** | UDP (`queryPort`) | **Full** player list, plugin list, world name, server software |

Both are merged into a single status, and:

- **One working protocol is enough to count as online.** Query is often disabled (plenty of servers only keep SLP); the icon, latency, player count and MOTD still show up, and the player list degrades to the SLP sample with its source marked on the image
- The game port and the query port are **completely separate** (`port` / `queryPort`) — Query being off by default never makes the API unusable
- **Multi-server overview**: query several servers concurrently and get one list image (`/api/overview.png`) plus an aggregate JSON (`/api/overview`)
- Images default to **1600×800** (`scale=2`), with the height adapting to the player count / server count; an offline server, invalid parameters or a render failure **all return an image** — never a 500, never a blank body
- In-memory TTL cache of **30 seconds**; JSON and images **share the same query result** (one round of UDP+TCP serves both endpoints)
- **7 themes × 5 visual styles × 3 layouts**, freely combinable — colors and layout are switchable with URL parameters
- Player avatars are **rendered in-house**: the project fetches skins from Mojang and crops/scales them itself, with no third-party avatar service required

---

## Table of contents

- [1. Quick start](#1-quick-start)
- [2. Server-side setup](#2-server-side-setup)
- [3. API reference](#3-api-reference)
- [4. Themes / layouts / visual styles](#4-themes--layouts--visual-styles)
- [5. Image specs](#5-image-specs)
- [6. Player avatars](#6-player-avatars)
- [7. Fonts](#7-fonts)
- [8. Caching](#8-caching)
- [9. Environment variables](#9-environment-variables)
- [10. Deployment](#10-deployment)
- [11. Project layout](#11-project-layout)
- [12. Troubleshooting](#12-troubleshooting)
- [13. Design notes](#13-design-notes)
- [14. Why not `@hloth/minecraft-query`](#14-why-not-hlothminecraft-query)
- [15. License](#15-license)

---

## 1. Quick start

### Requirements

- **Node.js >= 18.17** (needs global `fetch` and `AbortController`)
- A Minecraft Java Edition server with Query enabled (**optional** — SLP alone works)
- `node-canvas` ships prebuilt binaries, so a compiler toolchain is usually not needed on Linux; if installation fails, see the [node-canvas wiki](https://github.com/Automattic/node-canvas/wiki)

### Install and run

```bash
npm install
npm start                 # listens on 3000 by default
PORT=3001 npm start       # custom port
npm run dev               # node --watch, restarts on file changes
npm test                  # end-to-end self-test (no real server needed)
```

Startup output (the log text itself is Chinese, annotated here for reference):

```
[mcstatus-api] 已启动，监听端口 3001        # started, listening on port 3001
[mcstatus-api] JSON:  http://localhost:3001/api/status?host=play.example.com
[mcstatus-api] 图片:  http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566
[mcstatus-api] 字体: UI 字重 6 个（含中文）；系统 CJK 未找到；emoji /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf；符号 /usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf
```

That last line is the **font self-check**: which font file the renderer picked for CJK text and for emoji.
When something shows up as a box in a container, look at this line first — see [section 7](#7-fonts).

### Local fake server (develop without a real server)

`test/mock-server.mjs` is a "fake Minecraft server" that implements both protocols and even draws a 64×64 server icon on the fly:

```bash
node test/mock-server.mjs     # TCP 25565 (SLP) + UDP 25566 (Query), 12 players
curl "http://localhost:3001/api/status?host=127.0.0.1&port=25565&queryPort=25566"
```

It can also be imported by tests: `startMockServer({ withSlp, withQuery, gamePort, queryPort })` — which is exactly how the self-test covers cases such as "SLP only" and "Query disabled".

`npm test` runs the whole chain against the fake server plus a fake avatar service: **61 assertions** (JSON fields, image dimensions, parameter validation, cache hits, themes/layouts/styles, avatar cropping, …). Artifacts are written to `test-output/`.

---

## 2. Server-side setup

### Enable Query (optional)

The Query protocol is **disabled by default**. Turn it on in `server.properties` in the server root:

```properties
enable-query=true
query.port=25566
```

- You **must restart the server** for the change to take effect
- `query.port` may be the same as the game port, a different port, or even point at another machine
- Query and RCON are unrelated — `enable-rcon` is **not** required
- Even with Query off, this API still works: SLP provides the icon / latency / player count / MOTD, only the player list is limited to the sample

### Firewall

| Protocol | Port | Transport |
| --- | --- | --- |
| SLP | `port` (game port) | **TCP** |
| Query | `queryPort` | **UDP** |

A classic trap: only TCP 25565 is allowed and the UDP query port is blocked — the symptom is "the server is clearly online but `playerList` stays empty / `queryError` reports a timeout". This API also reports the SLP result, so the server is still marked online.

### About SRV records

The Query lookup in this project does **not** resolve SRV records; it uses the `queryPort` you pass in. SRV only affects how clients find the game port, so if your server exposes its game port through SRV, just fill the resolved port into `port` for display purposes.

---

## 3. API reference

| Endpoint | Returns | Description |
| --- | --- | --- |
| `GET /api/status` | JSON | Full status of a single server |
| `GET /api/banner.png` | PNG | Status image for a single server |
| `GET /api/overview` | JSON | Aggregate for several servers + each server's full status |
| `GET /api/overview.png` | PNG | Overview image for several servers (one row each) |
| `GET /api/themes` | JSON | Available themes (with each theme's paired layout and style) |
| `GET /api/layouts` | JSON | Available layouts |
| `GET /api/styles` | JSON | Available visual styles |
| `GET /healthz` | JSON | Health check (uptime + cache stats) |

Every endpoint allows CORS (`Access-Control-Allow-Origin: *`) and answers `OPTIONS` with 204. Request logging is on by default; turn it off with `LOG_REQUESTS=off`.

### `GET /api/status`

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `host` | ✅ | — | Hostname or IP, **without** `http://` or any path |
| `port` | ❌ | `25565` | Game port (SLP uses TCP on this port; also used for display) |
| `queryPort` | ❌ | same as `port` | **UDP** port of the Query protocol |
| `timeout` | ❌ | `3000` | Per-protocol timeout in ms, range 500–10000 |
| `refresh` / `nocache` | ❌ | — | `1`/`true` bypasses the cache and forces a re-query |
| `name` | ❌ | — | **Custom display name** replacing `host:port` in the title (max 60 chars, no newlines/control characters) |
| `theme` / `layout` / `style` | ❌ | — | Image-only; echoed back in the JSON, see [section 4](#4-themes--layouts--visual-styles) |
| `scale` | ❌ | `2` | Ignored by the JSON endpoint; only parsed so both endpoints share one parameter parser |

Example online response:

```json
{
  "online": true,
  "host": "play.example.com",
  "port": 25575,
  "queryPort": 25577,

  "motd": "[Golden Fleece] A server built the way you like it, with Cobblemon 🔮",
  "motdRaw": "[Golden Fleece] A server built the way you like it\nwith Cobblemon 🔮",
  "motdLines": ["[Golden Fleece] A server built the way you like it", "with Cobblemon 🔮"],

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

Field reference:

| Field | Source | Description |
| --- | --- | --- |
| `motd` / `motdRaw` / `motdLines` | SLP preferred | MOTD with § color codes stripped / raw / at most two lines (matching the vanilla multiplayer list) |
| `players` / `maxPlayers` | Query preferred, else SLP | Online players / limit |
| `playerList` | Query (complete) | With SLP only, this is the sample list |
| `playerListSource` | — | `query` (complete) / `slp-sample` (sample) / `null` |
| `samplePlayers` | SLP | SLP sample with UUIDs (the only source that carries UUIDs, like the vanilla list) |
| `version` / `protocol` | SLP preferred | Version name / protocol number (e.g. `767`) |
| `latencyMs` | SLP | Round-trip time of the status exchange, ≈ the signal bars in the multiplayer list |
| `serverIcon` | SLP | `data:image/png;base64,...` (64×64) |
| `software` / `plugins` | Query | Server software / plugin list |
| `sources` | — | Whether each of the two protocols succeeded |
| `cached` | — | Whether this result came from the 30-second in-memory cache |
| `theme` / `layout` / `style` | — | The display combination that was in effect |
| `queryError` / `pingError` | — | Per-protocol failure reason (kept even when online, for debugging) |
| `error` / `errorCode` | — | Only present when **both protocols failed** |

Offline / timeout (HTTP stays **200**):

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

Same parameters as `/api/status`, plus:

| Parameter | Default | Description |
| --- | --- | --- |
| `scale` | `2` | Output multiplier: `1` / `2` / `3` (width = 800 × scale) |

Response headers:

```
Content-Type: image/png
Cache-Control: public, max-age=30
ETag: W/"..."
X-Query-Status: online | offline
X-Query-Source: play.example.com:25577
Access-Control-Allow-Origin: *
```

It **always returns an image** — never a 500, never a blank body:

| Situation | HTTP | Body |
| --- | --- | --- |
| Online | 200 | Status image |
| Offline / timeout (both protocols failed) | 200 | Offline image (red status dot + failure reason + hints) |
| Invalid parameters (missing host, port out of range, scale out of range, …) | 400 | "Invalid request" explanation image |
| Render failure | 500 | "Render failed" explanation image |

### `GET /api/overview` (multi-server)

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `servers` | ✅ (unless the env var is set) | `OVERVIEW_SERVERS` | Comma-separated list, each entry `[displayName@]host[:port[:queryPort]]`; omitted ports fall back to `25565` / the game port |
| `timeout` | ❌ | `3000` | Protocol timeout per server |
| `refresh` / `nocache` | ❌ | — | Bypass the cache |

At most **8 servers** per request (tunable via `MAX_OVERVIEW_SERVERS`), queried **in parallel**, returning an aggregate plus each server's full status:

```bash
# With custom display names (URL-encode non-ASCII names)
curl "http://localhost:3001/api/overview?servers=main@play.example.com:25565:25566,survival@play.example.com:25575:25577"
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
      "motdLines": ["[Golden Fleece] A server built the way you like it", "..."],
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

### `GET /api/overview.png` (multi-server image)

Same parameters, plus `scale` (default 2 → 1600 wide) and `theme` / `style`. The **height adapts to the number of servers**:

```
card height   = 118 + serverCount × 70 + 18
canvas height = (24 + card height + 46) × scale
```

Examples: 3 servers → 1600×832; 4 servers → 1600×972.

Each server occupies one row containing:

```
● [icon] Display name                        12 / 60
         First MOTD line                    ▂▄▆ 375 ms
         [avatar][avatar][avatar][avatar]…
```

- **Avatars fill a single row and player names are omitted** (`OVERVIEW.maxAvatars` defaults to 15; the full list is unnecessary). Nothing is drawn when 0 players are online
- Offline servers show a red dot + `offline` + the failure reason, with no avatars
- The header carries the aggregate (`3/4 online · 13 players online · 1 offline`) and the footer the real elapsed time of the whole batch

```bash
curl -o overview.png "http://localhost:3001/api/overview.png?servers=play.example.com:25565:25566,play.example.com:25575:25577"
```

```html
<img src="http://localhost:3001/api/overview.png?servers=a.example.com:25565:25566,b.example.com:25565:25566" />
```

> For a fixed set of servers, put them in the environment variable and request without parameters:
> ```bash
> OVERVIEW_SERVERS="play.example.com:25565:25566,play.example.com:25575:25577" npm start
> curl "http://localhost:3001/api/overview.png"
> ```

### Metadata endpoints

```bash
curl "http://localhost:3001/api/themes"     # themes (with their paired layout / style)
curl "http://localhost:3001/api/layouts"    # layouts
curl "http://localhost:3001/api/styles"     # visual styles
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

Any other path returns 404 JSON (this service is **API-only** — there is no UI):

```json
{
  "error": "Not Found",
  "endpoints": [
    "/api/status", "/api/banner.png", "/api/overview", "/api/overview.png",
    "/api/themes", "/api/layouts", "/api/styles", "/healthz"
  ]
}
```

### Custom display names

Replace `host:port` in the title with the name you want (the "server name" you would see in-game):

```
/api/banner.png?host=play.example.com&port=25575&queryPort=25577&name=Golden%20Fleece
/api/overview.png?servers=main@play.example.com:25565:25566,survival@play.example.com:25575:25577
```

- Single server uses `name=`; the overview uses `displayName@host:port:queryPort`
- With a display name, **`host:port` no longer appears on the image** (the name fully replaces the address); without one, `host:port` is used as the title
- `name` is display-only and **not part of the cache key**, so renaming the same address does not trigger another query
- Validation: at most 60 characters; newlines/control characters return 400 (`NAME_INVALID`)

### Error codes

| `errorCode` | Meaning |
| --- | --- |
| `CONNECTION_ERROR` | TCP connect failed (server offline / port closed) |
| `TIMEOUT` | No response within the timeout |
| `SOCKET_ERROR` / `SEND_ERROR` | UDP socket / send failure |
| `BAD_CHALLENGE` | The Query handshake returned an invalid challenge token |
| `BAD_RESPONSE` | The response could not be parsed |
| `HOST_REQUIRED` / `HOST_TOO_LONG` / `HOST_INVALID` | host missing / too long / contains a scheme or path |
| `PORT_INVALID` / `QUERYPORT_INVALID` | Port is not an integer in 1–65535 |
| `TIMEOUT_INVALID` / `SCALE_INVALID` | Parameter out of range |
| `THEME_INVALID` / `LAYOUT_INVALID` / `STYLE_INVALID` | Theme / layout / visual style is not in the available list |
| `SERVERS_REQUIRED` | The overview request is missing its `servers` parameter |
| `TOO_MANY_SERVERS` | More servers requested than the limit |
| `SERVER_ENTRY_INVALID` | Malformed server entry (expected `[displayName@]host[:port[:queryPort]]`) |
| `NAME_INVALID` | Display name too long or contains newlines/control characters |
| `UNKNOWN` | Fallback |

> The `error` text from the query layer is always English (friendlier to programmatic callers); on images it is mapped through `errorCode` into the current label language, so **a machine without CJK fonts never renders a wall of boxes**.

### Examples

```bash
# JSON
curl "http://localhost:3001/api/status?host=play.example.com&port=25565&queryPort=25566"

# Just the player counts
curl -s "http://localhost:3001/api/status?host=play.example.com&queryPort=25566" | jq '.players, .maxPlayers'

# Image (1600x800 by default)
curl -o banner.png "http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566"

# Legacy size 800x400
curl -o banner-800.png "http://localhost:3001/api/banner.png?host=play.example.com&port=25565&queryPort=25566&scale=1"

# Multi-server image (one row per server)
curl -o overview.png "http://localhost:3001/api/overview.png?servers=play.example.com:25565:25566,play.example.com:25575:25577"

# Multi-server aggregate JSON
curl -s "http://localhost:3001/api/overview?servers=play.example.com:25565:25566,play.example.com:25575:25577" | jq '{online, players}'

# Force a re-query, bypassing the 30-second cache
curl "http://localhost:3001/api/status?host=play.example.com&queryPort=25566&refresh=1"
```

`<img>` / Markdown / periodic refresh:

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
  setInterval(draw, 30000); // the server caches for 30 seconds — this lines up nicely
</script>
```

---

## 4. Themes / layouts / visual styles

The look of an image is controlled by three **independent** parameters that can be combined freely (`7 × 5 × 3 = 105` combinations):

| Parameter | Values | Endpoint | What it decides |
| --- | --- | --- | --- |
| `theme` | 7 color schemes | `GET /api/themes` | Background, status colors, accent color, light/dark mode (all other surface colors are derived from the mode) |
| `style` | 5 visual styles | `GET /api/styles` | How the background is painted, the card material, how dividers are drawn, label typography, decorative elements |
| `layout` | 3 layouts | `GET /api/layouts` | How information is arranged (stacked cards / compact strip / split columns) |

```bash
# Use a theme together with its paired layout/style (recommended)
curl -o a.png "http://localhost:3001/api/banner.png?host=play.example.com&theme=midnight"

# Free combination: deep purple + Swiss grid + compact strip
curl -o b.png "http://localhost:3001/api/banner.png?host=play.example.com&theme=midnight&style=swiss&layout=compact"
```

**Priority: explicit parameter > theme's paired value > global default** (`BANNER_THEME` / `BANNER_LAYOUT`). All three affect display only and are **not part of the cache key**, so switching them never triggers another query. Unknown values return 400 with the available values listed in the error message.

### Themes (7)

| Theme | Mode | Paired layout | Paired style | Origin |
| --- | --- | --- | --- | --- |
| `default` | dark | `stack` | `material` | This project (dark indigo, unchanged from the first version) |
| `midnight` | dark | `split` | `cosmic` | theme-factory: midnight-galaxy |
| `ocean` | dark | `stack` | `swiss` | theme-factory: ocean-depths |
| `forest` | dark | `compact` | `organic` | theme-factory: forest-canopy |
| `sunset` | dark | `split` | `editorial` | theme-factory: sunset-boulevard |
| `frost` | **light** | `stack` | `material` | theme-factory: arctic-frost |
| `mono` | **light** | `compact` | `swiss` | theme-factory: modern-minimalist |

A theme is defined as "background + status colors + accent + light/dark mode"; every other surface color (cards / chips / dividers / text grays) is derived from the mode — which is why a light theme automatically gets dark text.

### Visual styles (5)

| `style` | Approach | Used by default in |
| --- | --- | --- |
| `material` | Translucent material card + bright top edge + soft shadow + gradient-fading dividers | `default`, `frost` |
| `swiss` | Flat color blocks + full-width hairlines + no shadow + modular grid background + corner ticks + uppercase wide-tracked labels | `ocean`, `mono` |
| `cosmic` | Deterministic pseudo-random grain background + accent glow + dashed dividers + enlarged title | `midnight` |
| `organic` | Large radii + three soft color blobs in the background + dot dividers + no borders | `forest` |
| `editorial` | Solid band at the top + heavy rule on the card's left + flat cards + short leading divider + uppercase labels | `sunset` |

(Implemented in `src/image.js` in `STYLES` plus `drawBackground` / `drawCard` / `drawSoftDivider` / `drawStyleDecorations`.)

### Layouts (3)

| Layout | Size | Shape |
| --- | --- | --- |
| `stack` (default) | 800 × dynamic | Stacked card: icon + name + status + MOTD + player grid (with names) |
| `compact` | **800 × 218** | Compact strip: one line of information + one row of avatars (no names) — good for signatures / announcements |
| `split` | 800 × dynamic (≥400) | Split columns: icon / name / MOTD / player count on the left, avatar wall on the right (no names, wrapping by column count) |

---

## 5. Image specs

Images default to **1600×800** (`scale=2`). The reason: an 800×400 image will always look soft once a HiDPI screen or a chat window scales it up — that is a resolution problem, not an anti-aliasing one (measurements showed internal 2× supersampling only lifts text-edge energy by 0.2–0.4%).

| Variable / parameter | Default | Effect |
| --- | --- | --- |
| `scale` (URL parameter) | `2` | Output multiplier 1–3 (width = 800 × scale) |
| `BANNER_DEFAULT_SCALE` | `2` | Change the default multiplier (set to 1 to go back to 800×400 by default) |
| `BANNER_SUPERSAMPLE` | `2` | Internal supersampling factor (cleaner vector edges, corner radii and CJK strokes) |

### `stack` layout height formula

Width is fixed at 800 × scale; the **height adapts to the player count** — 5 players per row, adding rows as needed:

```
rows        = ceil(min(playerCount, BANNER_MAX_PLAYERS) / 5)
cardHeight  = max(336, 284 + (rows − 1) × 34 + 28)   // row height 34, avatar 28
canvasHeight = 24 + cardHeight + 40                   // then × scale
```

Examples: ≤5 players → 1 row → height 400; 6–10 → 2 rows → 410; 12 → 3 rows → 444; 20 → 4 rows → 478.

**Every online player is drawn by default** (no truncation at 10); only beyond `BANNER_MAX_PLAYERS` (default 100) does it truncate and show "showing x / y".

### Image processing details

- **Avatars are full squares with no rounded clipping**: the face + hat layer are cut straight from the skin and drawn as one square block (a skin head is a cube in-game anyway) — no corner cutting, no borders
- **Scaling is direction-dependent**: smoothing is enabled when downscaling for crispness, and disabled when upscaling to keep the pixel-art feel
- **A failed concurrent avatar fetch is retried once**: the first batch of 10 concurrent requests to mc-heads occasionally times out, and the retry almost always succeeds

---

## 6. Player avatars

By default the renderer **depends on no third-party avatar service**; avatars are produced in-house:

```
player name ──▶ api.mojang.com/users/profiles/minecraft/<name>   (404 = offline-mode / non-premium account)
            ──▶ sessionserver.mojang.com/session/minecraft/profile/<uuid>
            ──▶ textures.minecraft.net/texture/<hash>            (64x64 or legacy 64x32 skin)
            ──▶ cut "face (8,8,8,8)" + "hat layer (40,8,8,8)" → nearest-neighbour upscale into an avatar
```

Why this approach:

- **Fully in control**: cropping, scaling and radii are ours, and rendering happens **at device pixels** (a 2× output is rendered 2× larger), so the result is 1:1 and pixel art never gets blurred by resampling
- **Lighter**: a skin texture is a few hundred bytes to a few KB, far smaller than fetching a ready-made avatar image every time
- **Accurate detection**: Mojang returns **404** for a name that does not exist, so "this player has no skin" is decided immediately instead of guessed

### Provider chain

`BANNER_AVATAR_PROVIDERS` (default `mojang,mccag,mc-heads`) is tried left to right; the first success wins:

| Provider | Description |
| --- | --- |
| `mojang` | The in-house chain above (default first choice). Set `BANNER_AVATAR_PROVIDERS=mojang` for a fully self-contained setup |
| `mccag` | The neighbouring avatar service (`BANNER_MCCAG_BASE`, default `http://127.0.0.1:3000`) with a more dimensional rendering; skipped automatically when unavailable |
| `mc-heads` | A third-party avatar service used as a fallback; the "default face" detection logic stays in place |

A failing provider automatically falls through to the next one; when `mojang` explicitly returns 404 (no skin), it **short-circuits straight to a letter avatar** and never asks the remaining providers.

### Avatar rendering style (`BANNER_AVATAR_STYLE`)

| Value | Effect |
| --- | --- |
| `minimal` (default) | **Matches mccag's minimal**: flat face + a hat layer 9.3% larger + soft shadow on a transparent background — hair/hats naturally overflow the face outline |
| `3d` | Dimensional head: front + top + right faces (viewed from above-right), with shading on the top/side |
| `flat` | The plainest flat avatar: face + same-size hat layer, filling the whole image |

**Composition parameters of `minimal`** (taken from mccag's `Scripts/Data.js`, stored in `MINIMAL_LAYOUT` in `src/skin.js`):

```
canvas 1000x1000 (transparent)
face     : texture (8,8,8,8)  → scaled to 600, placed at (200,200)
hat layer: texture (40,8,8,8) → scaled to 656, placed at (175,175)   ← 9.3% larger than the face
shadow   : rgba(0,0,0,0.2), blur 15, no offset
```

The surrounding whitespace of the original mccag output is cropped away so the head fills the slot (`fill` defaults to 0.96, leaving a little room for the shadow).

> **Legacy skins (64×32) have no hat layer**: in an old skin the (40,8) area often holds an unrelated body part or plain black pixels,
> so unconditionally compositing it as a hat layer smears the whole face into a black block (Notch's skin is exactly this case).
> Only modern 64×64 skins get a hat layer.

### Players without a skin

Offline-mode servers and non-premium accounts are not found in Mojang (HTTP 404); `BANNER_AVATAR_FALLBACK` decides what happens:

- `letter` (default): draw a **letter avatar colored from the name** — every player gets a distinct color and no row of identical "Steves" appears
- `plain`: show the default face returned by the avatar provider (with mc-heads, several identical faces appear)

To disable avatars entirely (intranet / no outbound network): `BANNER_AVATARS=off` — everything falls back to letter avatars.

### Avatar-related caches

| Cache | TTL | Description |
| --- | --- | --- |
| Name → UUID | 1 hour | Essentially static |
| Skin texture | 5 minutes | Players do change skins |
| Rendered avatar | 5 minutes (max 300 entries) | Keyed by "size:playerName" |

`api.mojang.com` is rate limited (roughly 600 requests / 10 minutes / IP), and these caches exist for exactly that reason: a 10-player server costs about 10 request groups on first render, then everything is a cache hit for 5 minutes.

---

## 7. Fonts

The project bundles **HarmonyOS Sans SC** in all weights (`assets/fonts/`, 6 files, about **47MB** total); both Chinese and Latin text are rendered with it:

| Weight | Where it is used |
| --- | --- |
| `Black` | Large numbers (online players `12`, overview row `0 / 20`) |
| `Bold` | Titles, addresses, status text |
| `Medium` | Section labels, chip labels, player names, overview row addresses |
| `Regular` | Body text, secondary information, captions |
| `Light` | MOTD body text |
| `Thin` | Registered but unused (enable it via `WEIGHT_FALLBACK` in `src/image.js` or a call-site `weight`) |

```
HarmonyOS_Sans_SC_Thin.ttf     8.02 MB
HarmonyOS_Sans_SC_Light.ttf    7.95 MB
HarmonyOS_Sans_SC_Regular.ttf  7.88 MB
HarmonyOS_Sans_SC_Medium.ttf   7.85 MB
HarmonyOS_Sans_SC_Bold.ttf     7.78 MB
HarmonyOS_Sans_SC_Black.ttf    7.75 MB
```

(The license ships with the fonts at `assets/fonts/LICENSE.txt`.)

**Font stack**: `"HarmonyOS Sans <weight>", "MCBannerCJK", sans-serif` — if both of the first two lack a glyph, the system CJK font still catches it (Pango does per-glyph fallback), so no boxes are drawn.

**To save space**: delete the weights you do not need (keeping only `Regular` / `Medium` / `Bold` is about 23MB), or swap in the Latin-only HarmonyOS Sans subsets (about 145KB each) — but those contain no Han characters, so Chinese falls back to a system font.

**Swap the font**: drop same-named files into `assets/fonts/`, or point `BANNER_FONT_DIR` at your own directory:

```bash
BANNER_FONT_DIR=/app/my-fonts npm start
```

> node-canvas's `registerFont` only registers by *family* and does not support `font-weight`, so this project registers
> every weight as its own family name (`HarmonyOS Sans Bold`, …) and degrades through the `WEIGHT_FALLBACK` chain when a
> weight is missing; the font stack deliberately avoids the `bold` keyword so no synthetic bolding kicks in.

### Emoji and symbol fonts

Chinese and Latin are bundled, but **emoji still depends on system fonts**, and there are two traps:

1. **Color emoji are bitmap fonts** (NotoColorEmoji uses CBDT, Apple/Segoe use sbix). Slightly older cairo + FreeType
   combinations cannot rasterize them at all and the characters come out **blank or as tofu boxes** — installing the font
   is not the same as being able to draw it.
2. **Emoji are not limited to U+1F000 and above.** Two groups in the BMP must be routed to the emoji font as well:
   those that are emoji by default (`✨ ⚡ ⭐ ✅ ⌚ ⏰`) and those that are text by default and only become emoji when
   followed by `U+FE0F` (`☀️ ❤️ ⚔️ ⛏️ ↔️`). Symbols such as `★ ✂ ™ ♥` are **not emoji at all** and stay on the main
   font stack — handing them to an emoji font draws a "box with the code point inside it" instead (emoji fonts really
   do not have those glyphs; Segoe UI Emoji has no `★`).

So at startup the service **renders every candidate font once** and only keeps the ones that actually work:

| Purpose | Self-check sample | Candidates (in priority order) |
| --- | --- | --- |
| Astral emoji (🔮🎮) | 🔮 | NotoColorEmoji → Noto Emoji → Symbola → Noto Sans Symbols 2 → Apple Color Emoji → Segoe UI Emoji |
| BMP symbols (⭐✨) | ⭐ | same as above |

- Acceptance criteria: **pixels were actually painted**, the result is **not the missing-glyph tofu box**, and the **advance width is sane** (a bitmap font with a single pixel size can blow up letter spacing)
- A color font that fails is dropped in favour of a **monochrome outline font** (Symbola / Noto Emoji), which any cairo can rasterize
- The two picks may differ: with only a symbol font available, astral emoji such as `🔮` are **dropped entirely** (better absent than boxed) while `⭐✨` still render
- With no emoji font at all: astral emoji are dropped and BMP symbols fall back to the main font stack (DejaVu provides `★ ☆ ✓ ⚠`)
- Besides the hard-coded paths, well-known font directories such as `/usr/share/fonts` are scanned for files whose names contain `emoji` / `symbola` / `symbols`

The fonts to install in a container (see `Dockerfile`):

```bash
apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-color-emoji fonts-symbola
```

---

## 8. Caching

- TTL of **30 seconds**, keyed by `${host}:${port}:${queryPort}` (`scale`, `name`, `theme`, `layout` and `style` are excluded, because images and JSON share one status)
- What is cached is the **Promise**: concurrent JSON / image requests trigger a single real UDP + TCP round and never stampede
- The response carries `Cache-Control: public, max-age=30`, and with express's default ETag a repeated request is answered with 304
- The in-memory limit is 500 entries; on overflow expired entries are purged first, then the oldest by expiry
- `?refresh=1` bypasses the cache
- Each server in an overview uses **its own key**, so querying A first and then A+B still hits the cache for A

---

## 9. Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | API listen port |
| `LOG_REQUESTS` | `on` | Request logging; `off` disables it (handy when checking whether requests reach the service) |
| `OVERVIEW_SERVERS` | — | Default server list for the overview, so `/api/overview.png` can be called without parameters |
| `MAX_OVERVIEW_SERVERS` | `8` | Maximum servers per overview request |
| `BANNER_THEME` | `default` | Default theme (7 available, see section 4) |
| `BANNER_LAYOUT` | `stack` | Default layout (`stack` / `compact` / `split`); a theme's paired layout wins when one is given |
| `BANNER_DEFAULT_SCALE` | `2` | Default image output multiplier (1 = 800×400) |
| `BANNER_SUPERSAMPLE` | `2` | Internal supersampling factor |
| `BANNER_LABELS` | `auto` | `auto` / `zh` / `en` — label language on images |
| `BANNER_MAX_PLAYERS` | `100` | Maximum avatars rendered on a single-server image (beyond that it truncates and notes "showing x / y") |
| `BANNER_AVATARS` | `on` | Set to `off` to skip avatar fetching entirely (intranet / no outbound network) |
| `BANNER_AVATAR_PROVIDERS` | `mojang,mccag,mc-heads` | Avatar provider chain, tried left to right |
| `BANNER_AVATAR_STYLE` | `minimal` | Avatar style: `minimal` / `3d` / `flat` |
| `BANNER_AVATAR_FALLBACK` | `letter` | When a player has no skin: `letter` = name-colored letter avatar, `plain` = the provider's default face |
| `BANNER_AVATAR_BASE` | `https://mc-heads.net` | Third-party avatar source; may point at a self-hosted mirror (must support `/avatar/<name>/50`) |
| `BANNER_MCCAG_BASE` | `http://127.0.0.1:3000` | mccag avatar service address; skipped automatically when unavailable |
| `BANNER_FONT_DIR` | `assets/fonts` | Custom UI font directory (same-named files replace the whole set; missing weights degrade automatically) |
| `BANNER_FONT_PATH` | — | Explicit CJK font file (e.g. `wqy-microhei.ttc`) |
| `BANNER_FONT_FAMILY` | — | Family name used together with the previous entry |

---

## 10. Deployment

### Docker (recommended, works out of the box)

The project ships a `Dockerfile` and a `docker-compose.yml`:

```bash
docker compose up -d --build       # ports and environment variables live in the compose file
docker compose logs -f
```

Plain Docker works too:

```bash
docker build -t mcstatus-api .
docker run -d --name mcstatus-api -p 3001:3001 \
  -e OVERVIEW_SERVERS="main@play.example.com:25565:25566" \
  mcstatus-api
```

The image is based on `node:20-slim` and installs three font packages (the slim base image ships no system fonts at all):

| Package | Purpose |
| --- | --- |
| `fonts-dejavu-core` | Text symbols such as `★ ☆ ✓`, and the main font stack's safety net |
| `fonts-noto-color-emoji` | Color emoji (CBDT bitmap font), preferred whenever cairo can rasterize it |
| `fonts-symbola` | Monochrome outline font with very broad coverage; used automatically when the color one cannot be rasterized |

The Chinese font (HarmonyOS Sans SC) is bundled with the project and needs no installation. The startup log prints the
font file that was actually selected — check it first when emoji or Chinese text renders as boxes. The image also has a
built-in `HEALTHCHECK` (probing `/healthz`) and runs as the non-root `node` user.

### systemd

The recommended setup is to place the project in `/opt/mcstatus-api` and let systemd manage it — **restart on crash + start on boot**.

```bash
# 1) put it in a stable location and install production dependencies
cp -r mcstatus-api /opt/mcstatus-api
cd /opt/mcstatus-api && npm install --omit=dev

# 2) copy the bundled unit file
cp deploy/mcstatus-api.service /etc/systemd/system/

# 3) enable and start
systemctl daemon-reload
systemctl enable --now mcstatus-api
```

The contents of `deploy/mcstatus-api.service` (comments translated here for readability; the file itself carries Chinese comments):

```ini
[Unit]
Description=mcstatus-api — Minecraft server status JSON / image API
Documentation=file:///opt/mcstatus-api/README.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0          # do not cap the restart count

[Service]
Type=simple
WorkingDirectory=/opt/mcstatus-api
ExecStart=/usr/bin/node src/index.js

Environment=NODE_ENV=production
Environment=PORT=3001
Environment=BANNER_DEFAULT_SCALE=2
Environment=BANNER_AVATAR_PROVIDERS=mojang,mccag,mc-heads
Environment=BANNER_MCCAG_BASE=http://127.0.0.1:3000
Environment="OVERVIEW_SERVERS=main@play.example.com:25565:25566,survival@play.example.com:25575:25577"

Restart=always                   # bring it back after a crash or a kill
RestartSec=5                     # retry after 5 seconds
TimeoutStopSec=10                # allow up to 10 seconds for a graceful shutdown

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mcstatus-api    # the tag used by journalctl -u mcstatus-api

NoNewPrivileges=true             # light hardening: no privilege escalation, no writes
PrivateTmp=true

[Install]
WantedBy=multi-user.target       # start on boot
```

### Common commands

```bash
systemctl status mcstatus-api           # status (including recent logs)
systemctl restart mcstatus-api          # restart (after config/code changes)
systemctl stop mcstatus-api             # stop
systemctl is-enabled mcstatus-api       # is it enabled at boot?
journalctl -u mcstatus-api -f           # live logs
journalctl -u mcstatus-api -n 100       # last 100 lines
journalctl -u mcstatus-api --since today
```

### Verifying the auto-restart

```bash
systemctl kill -s SIGKILL mcstatus-api   # simulate a crash
systemctl status mcstatus-api            # should be active (running), with a new MainPID
```

### A note on editing code

systemd runs whatever lives in `/opt/mcstatus-api`, so **edit the code in that directory** (then `systemctl restart mcstatus-api`).
If you edit elsewhere (a development checkout, say), sync it over:

```bash
rsync -a --delete --exclude node_modules --exclude test-output \
      /path/to/mcstatus-api/ /opt/mcstatus-api/ && systemctl restart mcstatus-api
```

### Alternative: PM2

```bash
npm i -g pm2
PORT=3001 BANNER_DEFAULT_SCALE=2 pm2 start src/index.js --name mcstatus-api
pm2 save && pm2 startup            # generate the boot entry (run the command it prints)
pm2 logs mcstatus-api
```

---

## 11. Project layout

```
mcstatus-api/
├── package.json
├── package-lock.json
├── Dockerfile               # container image (node:20-slim + symbol/emoji fonts + HEALTHCHECK)
├── docker-compose.yml       # one-command startup (ports and environment variables live here)
├── .gitignore
├── .dockerignore
├── README.md                # 简体中文
├── README.en.md             # this file
├── assets/
│   └── fonts/               # HarmonyOS Sans SC, 6 weights (~47MB, full CJK + Latin) + LICENSE
├── deploy/
│   └── mcstatus-api.service # systemd unit
├── src/
│   ├── index.js             # Express entry: routes, parameter validation, headers, request log
│   ├── query.js             # GameSpy4 Query (UDP): handshake, full-stat parsing, players/plugins
│   ├── ping.js              # Server List Ping (TCP): favicon, latency, protocol, two-line MOTD
│   ├── skin.js              # In-house skin fetching + avatar rendering (Mojang APIs + canvas cropping/pixel scaling)
│   ├── status.js            # Runs both protocols in parallel, merges them, 30-second memory cache
│   └── image.js             # node-canvas rendering (themes/layouts/styles + supersampling + font & emoji handling)
└── test/
    ├── mock-server.mjs      # Fake server: TCP SLP + UDP Query + on-the-fly icon (runnable directly)
    └── smoke.mjs            # End-to-end self-test: 61 assertions
```

---

## 12. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Image says offline with `errorCode: CONNECTION_ERROR` | The server is down, or the **TCP** game port is blocked by a firewall |
| Online, but `playerList` is empty with `playerListSource: "slp-sample"` | Query is off (`enable-query=true`) or the **UDP** query port is not allowed. Check `queryError` |
| `latencyMs` is large (hundreds of ms) | Network distance to the server; this is the SLP round trip and is comparable to in-game latency |
| Boxes (tofu) on the image | No CJK font — see section 7; the startup log states whether a system CJK font was found |
| The emoji in the MOTD are missing | No usable emoji font: install `fonts-noto-color-emoji` (color) or `fonts-symbola` (monochrome fallback) in the container, see section 7. The startup log names the selected font file |
| Emoji are monochrome / mixed with colored ones | The color emoji font failed the self-check (cairo cannot rasterize CBDT) and the renderer degraded to a monochrome font — expected behaviour |
| Avatars are not shown | No outbound network → `BANNER_AVATARS=off`; or point `BANNER_AVATAR_BASE` at your own mirror |
| Several avatars are the same "Steve" | Those players belong to an offline-mode / non-premium account and are missing from Mojang (404). The default is a name-colored letter avatar; `BANNER_AVATAR_FALLBACK=plain` or putting `mc-heads` first brings back identical default faces |
| Avatars unavailable / want it fully local | `BANNER_AVATAR_PROVIDERS=mojang` uses only the in-house chain; `BANNER_AVATARS=off` disables avatars entirely |
| Image looks soft | Use the default `scale=2` (1600×800); make sure `BANNER_DEFAULT_SCALE` was not set to 1 |
| Theme / layout has no effect | Priority is "URL > theme's paired value > global default"; passing `layout` / `style` explicitly overrides the theme's paired value |
| `canvas` will not install | Node version below 18, or install `libcairo` / `libpango` per the node-canvas wiki |
| Garbled MOTD in the JSON | The server's MOTD is not UTF-8 (a few old servers or proxies) — a server-side problem |
| A server config change had no effect | `server.properties` requires a **server restart** |
| One row shows offline in the overview | Query that server on its own and read its `errorCode`; a wrong port or a port without Query enabled is the usual cause |

---

## 13. Design notes

The visual language borrows from Apple's design principles, which on a static image comes down to four things:

- **Material and hierarchy**: content sits on a translucent material card (faint fill + gradient top edge + soft shadow), and the background carries a very faint ambient glow tinted by the **average color of the server icon** — swap the icon and the whole image shifts hue
- **Typography**: tracking varies with size (25px address `-0.5px`, 19px body `-0.2px`, 11px small labels `+0.9px`); hierarchy comes from size + weight + leading together rather than size alone
- **No hard dividers**: the two dividers became soft gradients that fade out at both ends
- **Restraint**: only the status dot and the latency bars use semantic color (green / yellow / red); everything else is carried by opacity levels and the ambient tint

Three implementation constraints (read this before changing styles):

1. node-canvas **does not support `ctx.letterSpacing`** (measured `false`), so tracking is accumulated manually unit by unit — which conveniently also avoids splitting surrogate pairs
2. All text goes through `drawRichText()`, which handles **per-unit font switching + tracking + right/center alignment + width-based truncation**. Use it for new text instead of calling `ctx.fillText` directly, or emoji and tracking will misbehave
3. **Emoji cannot rely on font fallback**: NotoColorEmoji renders ASCII digits as keycap emoji (measured: `"25575"` goes from 44.1px to 99.6px wide), which is why fonts are now assigned per drawing unit. The emoji font itself is also self-checked before use (see section 7): with no usable font, astral emoji are dropped entirely and BMP symbols fall back to the main font stack — neither path draws a box

---

## 14. Why not `@hloth/minecraft-query`

The requirement originally named this library, but it turned out to be **unusable under plain Node**, so the Query side is
implemented equivalently with `node:dgram` (the protocol logic matches `minecraft-server-util`'s `queryFull`):

1. The npm package `@hloth/minecraft-query@1.0.0` points `"main"` at `index.ts` — **it only publishes TypeScript sources**.
   `import` throws `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`, so `npm install && npm start` cannot even run
2. It **forces `_minecraft._udp` SRV resolution** internally and accepts a single port per query, making it impossible to keep the game port and the query port separate
3. It parses the full-stat response with `toString('utf-8', 11)`, five bytes short of the real offset (**16**), which shifts every key/value pair; `info.plugins.split(':')` also throws when the plugins field is absent

The in-house implementation depends only on Node built-ins and additionally: validates the response packet's sessionId and packet type (ignoring reordered or spoofed packets), handles vanilla's `00 01 player_ 00 00` player-section separator and its 11-byte padding correctly, retries UDP packet loss, and narrows the unsigned challenge token to int32.

---

## 15. License

MIT
