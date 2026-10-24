# mcstatus-api
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README.zh.md)

Status API for **Minecraft Java Edition** servers. It speaks SLP (TCP) and GameSpy4 Query (UDP) at the same time and returns either JSON or a ready-to-paste PNG.

- **Online if either protocol answers** — Query is off on most servers, and you still get the icon, latency, player counts and MOTD, with the player list falling back to the SLP sample (labelled as such on the image)
- Game port (`port`) and Query port (`queryPort`) are fully separate
- Images are **1600×800** by default (`scale=2`) and grow with the player count; an offline server, a bad parameter or a render failure **still returns an image** — never a 500, never a blank
- Results are cached for **30 s**, shared between the JSON and image endpoints
- **7 themes × 5 visual styles × 3 layouts**, all switchable through URL parameters
- Player avatars are rendered in-house: we fetch skins ourselves and crop/scale them, no third-party avatar service required

## Quick start

Node **≥ 18.17** (`canvas` is a native module).

```bash
npm install
npm start                     # listens on 3000
```

```bash
curl "http://localhost:3000/api/status?host=play.example.com"
curl -o out.png "http://localhost:3000/api/banner.png?host=play.example.com&port=25565&theme=midnight"
curl -o list.png "http://localhost:3000/api/overview.png?servers=main@a.example.com:25565:25566,alt@b.example.com:25565"
```

For dialling things in, open the playground at <http://localhost:3000/playground> — preview on the left, every option on the right, request URL regenerated live at the bottom.

## Endpoints

| Endpoint | Returns | Description |
| --- | --- | --- |
| `GET /playground` | HTML | Parameter playground |
| `GET /api/status` | JSON | Full status of a single server |
| `GET /api/banner.png` | PNG | Status image for a single server |
| `GET /api/overview` | JSON | Aggregate for several servers + each server's full status |
| `GET /api/overview.png` | PNG | Overview image (one row per server) |
| `GET /api/themes` | JSON | Themes (with paired layout / style / palette) |
| `GET /api/layouts` | JSON | Layouts |
| `GET /api/styles` | JSON | Visual styles |
| `GET /healthz` | JSON | Health check (uptime + cache stats) |

Every endpoint allows CORS (`Allow-Origin: *`) and answers `OPTIONS` with 204.

### Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| `host` | — | **Required**, hostname or IP |
| `port` | `25565` | Game port, used for SLP |
| `queryPort` | same as `port` | Query port, used for UDP |
| `servers` | — | Overview only: `[name@]host[:port[:queryPort]]`, comma separated, max 8 |
| `timeout` | `5000` | 500–10000 ms |
| `scale` | `2` | Output multiplier 1 / 2 / 3 (1× = 800×400) |
| `name` | — | Overrides the address in the title |
| `theme` `layout` `style` | — | See the next section |
| `refresh=1` | — | Bypass the 30 s cache |

A missing `host` gives `400` + `HOST_REQUIRED` (JSON for JSON endpoints, an explanatory image for image endpoints); a missing `servers` behaves the same way.

Rate limits are per IP: 30 req/min for images, 120 req/min for JSON. Over the limit you get 429 (still a PNG from image endpoints) with `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers. `/healthz` and `/playground` are exempt.

## Themes / layouts / styles

| `theme` | Mode | Paired `layout` | Paired `style` |
| --- | --- | --- | --- |
| `default` | dark | `stack` | `material` |
| `midnight` | dark | `split` | `cosmic` |
| `ocean` | dark | `stack` | `swiss` |
| `forest` | dark | `compact` | `organic` |
| `sunset` | dark | `split` | `editorial` |
| `frost` | light | `stack` | `material` |
| `mono` | light | `compact` | `swiss` |

- **Layouts**: `stack` (default, stacked card) / `compact` (800×218 strip) / `split` (info left, avatar wall right)
- **Styles**: `material` translucent cards / `swiss` modular grid / `cosmic` grain and glow / `organic` big radii and blobs / `editorial` magazine rules

Passing only a theme uses its paired layout and style; add parameters to mix:

```bash
/api/banner.png?host=a.example.com&theme=midnight                      # split + cosmic
/api/banner.png?host=a.example.com&theme=midnight&layout=compact&style=swiss
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `LOG_REQUESTS` | `on` | `off` disables request logging |
| `OVERVIEW_SERVERS` | — | Default list for the overview, so it can be called without parameters |
| `MAX_OVERVIEW_SERVERS` | `8` | Max servers per overview request |
| `RATE_LIMIT_ENABLED` | `on` | `off` disables rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_MAX_IMAGE` | `120` / `30` | JSON / image quota per window |
| `BANNER_THEME` | `default` | Default theme |
| `BANNER_LAYOUT` | `stack` | Default layout |
| `BANNER_DEFAULT_SCALE` | `2` | Default output multiplier |
| `BANNER_LABELS` | `auto` | On-image labels: `auto` / `zh` / `en` |
| `BANNER_AVATARS` | `on` | `off` skips avatar fetching entirely (intranet use) |
| `BANNER_AVATAR_STYLE` | `minimal` | Avatar style: `minimal` / `3d` / `flat` |
| `BANNER_FONT_DIR` / `BANNER_FONT_PATH` | — | Custom font directory / explicit CJK font file |

Everything else (avatar provider chain, mccag address, supersampling, player cap…) is documented where it is read, in `src/index.js` and `src/image.js`.

## Deployment

```bash
docker compose up -d --build      # ports and environment variables live in the compose file
```

Plain Docker:

```bash
docker build -t mcstatus-api .
docker run -d --name mcstatus-api -p 3001:3001 mcstatus-api
```

The image is based on `node:20-slim` plus the DejaVu / Noto Color Emoji / Symbola font packages (Chinese HarmonyOS Sans SC ships with the project), has a built-in `HEALTHCHECK` against `/healthz`, and runs as the non-root `node` user. For systemd, see `deploy/mcstatus-api.service`.

## Project layout

```
├── src/index.js     Express entry: routes, validation, rate limiting, request log
├── src/ping.js      Server List Ping (TCP): icon, latency, version, MOTD
├── src/query.js     GameSpy4 Query (UDP): full player list, plugins, world
├── src/status.js    Runs both protocols in parallel, merges them, 30 s cache
├── src/skin.js      Skin fetching and avatar rendering
├── src/image.js     Canvas rendering: themes / layouts / styles / fonts
├── public/          Playground page (/playground)
└── test/            Mock server + end-to-end self-test
```

## Testing

```bash
npm test
```

The suite starts a fake Minecraft server (TCP + UDP) and a fake avatar service, so no real server is needed; it drops a few images into `test-output/`.

## License

MIT
