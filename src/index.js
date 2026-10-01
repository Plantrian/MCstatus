/**
 * src/index.js
 * ---------------------------------------------------------------------------
 * Express 入口（纯 API，不提供页面）：
 *   GET /api/status       单台服务器 JSON
 *   GET /api/banner.png   单台服务器状态图（PNG）
 *   GET /api/overview     多台服务器 JSON 一览
 *   GET /api/overview.png 多台服务器一览图（PNG）
 *
 * 监听端口由环境变量 PORT 控制，默认 3000。
 * 直接 `node src/index.js` 时才会 listen；被 import 时只导出 app（方便测试）。
 * ---------------------------------------------------------------------------
 */

import { pathToFileURL } from 'node:url';
import express from 'express';

// 状态聚合（Query + SLP）与缓存都在 status.js 里
import { CACHE_TTL_MS, DEFAULT_GAME_PORT, DEFAULT_TIMEOUT_MS, getCacheStats, getStatus } from './status.js';
import {
  DEFAULT_LAYOUT,
  DEFAULT_OUTPUT_SCALE,
  DEFAULT_THEME,
  getFontDiagnostics,
  LAYOUTS,
  MAX_OUTPUT_SCALE,
  STYLES,
  THEMES,
  listLayouts,
  listStyles,
  listThemes,
  renderBanner,
  renderMessageBanner,
  renderOverview,
  themeLayout,
  themeStyle,
} from './image.js';

const APP_PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
/** 多服一览一次最多查多少台（防止被当成压测入口） */
const MAX_OVERVIEW_SERVERS = Number.parseInt(process.env.MAX_OVERVIEW_SERVERS ?? '8', 10) || 8;
const CACHE_MAX_AGE_SECONDS = Math.round(CACHE_TTL_MS / 1000);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* ------------------------------ 参数处理 -------------------------------- */

/** 允许 CORS：这是个只读的公开状态接口，方便被别的页面/插件直接引用 */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

/**
 * 请求日志：排查「请求到底有没有打到本服务」时非常有用。
 * 用 LOG_REQUESTS=off 可以关掉。
 */
if ((process.env.LOG_REQUESTS || 'on').toLowerCase() !== 'off') {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const url = req.originalUrl.length > 120 ? `${req.originalUrl.slice(0, 117)}...` : req.originalUrl;
      console.log(
        `[mcstatus-api] ${res.statusCode} ${req.method} ${url} ${Date.now() - startedAt}ms from ${req.ip}`
      );
    });
    next();
  });
}

/** 判断查询串里的布尔值（refresh=1 / refresh=true） */
function isTruthy(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * 校验 host：
 *   - 必填、非空
 *   - 不能带协议前缀 / 路径 / 空白字符
 *   - 长度不超过 253（DNS 域名上限）
 */
function parseHost(rawHost) {
  if (rawHost === undefined || rawHost === null || String(rawHost).trim() === '') {
    return { error: 'host 参数必填，例如 host=play.example.com', errorCode: 'HOST_REQUIRED' };
  }
  const host = String(rawHost).trim();
  if (host.length > 253) {
    return { error: 'host 长度不能超过 253 个字符', errorCode: 'HOST_TOO_LONG' };
  }
  if (/\s/.test(host)) {
    return { error: 'host 不能包含空白字符', errorCode: 'HOST_INVALID' };
  }
  if (host.includes('://') || host.includes('/')) {
    return { error: 'host 只能是域名或 IP，不要带 http:// 或路径', errorCode: 'HOST_INVALID' };
  }
  return { value: host };
}

/** 校验端口：必须是 1-65535 的整数；未传时返回 fallback */
function parsePort(rawPort, { name, fallback, errorCode }) {
  if (rawPort === undefined || rawPort === null || String(rawPort).trim() === '') {
    return { value: fallback };
  }
  const text = String(rawPort).trim();
  if (!/^\d+$/.test(text)) {
    return { error: `${name} 必须是 1-65535 之间的整数`, errorCode };
  }
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return { error: `${name} 必须是 1-65535 之间的整数`, errorCode };
  }
  return { value };
}

/**
 * 可选参数 scale：输出倍数（1 = 800x400，2 = 1600x800，3 = 2400x1200）。
 * 内部本来就按 2x 超采样再降采样，scale>1 时直接输出高清原图。
 */
function parseScale(rawScale, fallback) {
  if (rawScale === undefined || rawScale === null || String(rawScale).trim() === '') {
    return { value: fallback };
  }
  const text = String(rawScale).trim();
  if (!/^\d+$/.test(text)) {
    return { error: `scale 必须是 1-${MAX_OUTPUT_SCALE} 之间的整数`, errorCode: 'SCALE_INVALID' };
  }
  const value = Number.parseInt(text, 10);
  if (value < 1 || value > MAX_OUTPUT_SCALE) {
    return { error: `scale 必须是 1-${MAX_OUTPUT_SCALE} 之间的整数`, errorCode: 'SCALE_INVALID' };
  }
  return { value };
}

/**
 * 主题：对应 src/image.js 里的 THEMES。
 * 不传就用 BANNER_THEME（默认 default），传了必须在列表内。
 */
function parseTheme(rawTheme) {
  if (rawTheme === undefined || rawTheme === null || String(rawTheme).trim() === '') {
    return { value: DEFAULT_THEME };
  }
  const name = String(rawTheme).trim().toLowerCase();
  if (!THEMES[name]) {
    return {
      error: `未知主题「${name}」，可用：${Object.keys(THEMES).join(' / ')}（GET /api/themes 看全部）`,
      errorCode: 'THEME_INVALID',
    };
  }
  return { value: name };
}

/**
 * 布局：对应 src/image.js 里的 LAYOUTS。
 * 不传就用「主题配套的布局」（见 THEMES[].layout），传了必须在列表内。
 */
function parseLayout(rawLayout, fallback) {
  if (rawLayout === undefined || rawLayout === null || String(rawLayout).trim() === '') {
    return { value: fallback ?? DEFAULT_LAYOUT };
  }
  const name = String(rawLayout).trim().toLowerCase();
  if (!LAYOUTS[name]) {
    return {
      error: `未知布局「${name}」，可用：${Object.keys(LAYOUTS).join(' / ')}（GET /api/layouts 看全部）`,
      errorCode: 'LAYOUT_INVALID',
    };
  }
  return { value: name };
}

/**
 * 视觉语言：对应 src/image.js 里的 STYLES。
 * 不传就用「主题配套的视觉语言」，传了必须在列表内 —— 三种层可以自由组合。
 */
function parseStyle(rawStyle, fallback) {
  if (rawStyle === undefined || rawStyle === null || String(rawStyle).trim() === '') {
    return { value: fallback ?? 'material' };
  }
  const name = String(rawStyle).trim().toLowerCase();
  if (!STYLES[name]) {
    return {
      error: `未知视觉语言「${name}」，可用：${Object.keys(STYLES).join(' / ')}（GET /api/styles 看全部）`,
      errorCode: 'STYLE_INVALID',
    };
  }
  return { value: name };
}

/**
 * 自定义显示名称：用来替换「host:port」作为标题展示。
 * 限制 60 字符，且不能含换行 / 控制字符（避免画图时撑破版式）。
 */
function parseDisplayName(rawName) {
  if (rawName === undefined || rawName === null) return { value: null };
  const name = String(rawName).trim();
  if (name === '') return { value: null };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { error: 'name 不能包含换行或控制字符', errorCode: 'NAME_INVALID' };
  }
  if (name.length > 60) {
    return { error: 'name 最长 60 个字符', errorCode: 'NAME_INVALID' };
  }
  return { value: name };
}

/**
 * 解析多服一览的 servers 参数：
 *   servers=[显示名@]host[:port[:queryPort]],[显示名@]host[:port[:queryPort]]
 * 留空时回退到环境变量 OVERVIEW_SERVERS，这样可以配好常用服、直接请求 /api/overview.png
 */
function parseServersParam(query) {
  const raw = query.servers ?? process.env.OVERVIEW_SERVERS ?? '';
  const source = String(raw).trim();

  if (!source) {
    return {
      error:
        '缺少 servers 参数，格式：servers=play.example.com:25565:25566,play.example.com:25575:25577（也可用环境变量 OVERVIEW_SERVERS 配置默认列表）',
      errorCode: 'SERVERS_REQUIRED',
    };
  }

  const entries = source
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return { error: 'servers 参数里没有有效的服务器条目', errorCode: 'SERVERS_REQUIRED' };
  }
  if (entries.length > MAX_OVERVIEW_SERVERS) {
    return {
      error: `一次最多查询 ${MAX_OVERVIEW_SERVERS} 台服务器（当前 ${entries.length} 台）`,
      errorCode: 'TOO_MANY_SERVERS',
    };
  }

  const servers = [];
  for (const entry of entries) {
    // 支持「显示名@host[:port[:queryPort]]」，显示名会把标题换成自定义名称
    let rawEntry = entry;
    let displayName = null;
    const atIndex = rawEntry.indexOf('@');
    if (atIndex !== -1) {
      const parsedName = parseDisplayName(rawEntry.slice(0, atIndex));
      if (parsedName.error) return { error: parsedName.error, errorCode: parsedName.errorCode };
      displayName = parsedName.value;
      rawEntry = rawEntry.slice(atIndex + 1);
    }

    const parts = rawEntry.split(':');
    if (parts.length > 3 || parts.some((part) => part.trim() === '')) {
      return {
        error: `无法解析服务器条目「${entry}」，格式为 [显示名@]host[:port[:queryPort]]`,
        errorCode: 'SERVER_ENTRY_INVALID',
      };
    }

    const host = parseHost(parts[0]);
    if (host.error) return { error: `「${entry}」：${host.error}`, errorCode: host.errorCode };

    const port = parsePort(parts[1], { name: 'port', fallback: DEFAULT_GAME_PORT, errorCode: 'PORT_INVALID' });
    if (port.error) return { error: `「${entry}」：${port.error}`, errorCode: port.errorCode };

    // 省略 queryPort 时默认等于游戏端口
    const queryPort = parsePort(parts[2], {
      name: 'queryPort',
      fallback: port.value,
      errorCode: 'QUERYPORT_INVALID',
    });
    if (queryPort.error) return { error: `「${entry}」：${queryPort.error}`, errorCode: queryPort.errorCode };

    servers.push({ host: host.value, port: port.value, queryPort: queryPort.value, displayName });
  }

  return { servers };
}

/** 可选参数 timeout：500-10000ms */
function parseTimeout(rawTimeout) {
  if (rawTimeout === undefined || rawTimeout === null || String(rawTimeout).trim() === '') {
    return { value: DEFAULT_TIMEOUT_MS };
  }
  const text = String(rawTimeout).trim();
  if (!/^\d+$/.test(text)) {
    return { error: 'timeout 必须是 500-10000 之间的整数（毫秒）', errorCode: 'TIMEOUT_INVALID' };
  }
  const value = Number.parseInt(text, 10);
  if (value < 500 || value > 10_000) {
    return { error: 'timeout 必须是 500-10000 之间的整数（毫秒）', errorCode: 'TIMEOUT_INVALID' };
  }
  return { value };
}

/**
 * 解析并校验全部查询参数。
 * @returns {{ error?: string, errorCode?: string, params?: object }}
 */
function parseQueryParams(query) {
  const host = parseHost(query.host);
  if (host.error) return { error: host.error, errorCode: host.errorCode };

  const port = parsePort(query.port, { name: 'port', fallback: DEFAULT_GAME_PORT, errorCode: 'PORT_INVALID' });
  if (port.error) return { error: port.error, errorCode: port.errorCode };

  // queryPort 默认等于 port
  const queryPort = parsePort(query.queryPort, {
    name: 'queryPort',
    fallback: port.value,
    errorCode: 'QUERYPORT_INVALID',
  });
  if (queryPort.error) return { error: queryPort.error, errorCode: queryPort.errorCode };

  const timeout = parseTimeout(query.timeout);
  if (timeout.error) return { error: timeout.error, errorCode: timeout.errorCode };

  const scale = parseScale(query.scale, DEFAULT_OUTPUT_SCALE);
  if (scale.error) return { error: scale.error, errorCode: scale.errorCode };

  const displayName = parseDisplayName(query.name);
  if (displayName.error) return { error: displayName.error, errorCode: displayName.errorCode };

  const theme = parseTheme(query.theme);
  if (theme.error) return { error: theme.error, errorCode: theme.errorCode };

  // 布局：显式传 ?layout= 优先，否则用该主题配套的布局
  const layout = parseLayout(query.layout, themeLayout(theme.value));
  if (layout.error) return { error: layout.error, errorCode: layout.errorCode };

  // 视觉语言：同理，?style= 可覆盖主题配套的那个
  const style = parseStyle(query.style, themeStyle(theme.value));
  if (style.error) return { error: style.error, errorCode: style.errorCode };

  return {
    params: {
      host: host.value,
      port: port.value,
      queryPort: queryPort.value,
      timeoutMs: timeout.value,
      refresh: isTruthy(query.refresh) || isTruthy(query.nocache),
      outputScale: scale.value, // 仅用于图片输出，不参与缓存 key
      displayName: displayName.value, // 展示用，不参与缓存 key
      theme: theme.value, // 亦然
      layout: layout.value,
      style: style.value,
    },
  };
}

/** 统一的异步错误包装（兼容 express 4/5） */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function setStatusHeaders(res, status) {
  res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
  res.set('X-Query-Status', status.online ? 'online' : 'offline');
  res.set('X-Query-Source', `${status.host}:${status.queryPort}`);
}

/* -------------------------------- 路由 ---------------------------------- */

/** JSON 状态接口 */
app.get(
  '/api/status',
  asyncHandler(async (req, res) => {
    const parsed = parseQueryParams(req.query);
    if (parsed.error) {
      res.status(400).json({ online: false, error: parsed.error, errorCode: parsed.errorCode });
      return;
    }

    const { outputScale, displayName, theme, layout, style, ...queryOptions } = parsed.params;
    void outputScale; // JSON 接口忽略 scale
    const status = await getStatus(queryOptions);
    const result = { ...status, theme, layout, style };
    if (displayName) result.displayName = displayName;
    setStatusHeaders(res, result);
    res.json(result);
  })
);

/** 图片接口：永远返回一张 PNG（离线、参数错误都不返回 500/空白） */
app.get(
  '/api/banner.png',
  asyncHandler(async (req, res) => {
    const parsed = parseQueryParams(req.query);
    const outputScale = parsed.params?.outputScale ?? 1;

    if (parsed.error) {
      const png = await renderMessageBanner(
        { kind: 'invalid', code: parsed.errorCode, message: parsed.error },
        { outputScale, theme: DEFAULT_THEME }
      );
      res.status(400).type('png').set('Cache-Control', 'no-store').send(png);
      return;
    }

    const { outputScale: _scale, displayName, theme, layout, style, ...queryOptions } = parsed.params;
    const raw = await getStatus(queryOptions);
    // displayName / theme / layout / style 只影响展示，不进缓存，所以在这里合并
    const status = { ...raw, theme, layout, style, ...(displayName ? { displayName } : {}) };

    try {
      const png = await renderBanner(status, { outputScale, theme, layout, style });
      setStatusHeaders(res, status);
      res.type('png').send(png);
    } catch (renderError) {
      // 渲染失败也返回图片，方便在 <img> 里直接看到原因
      const png = await renderMessageBanner(
        {
          kind: 'render-error',
          message: renderError instanceof Error ? renderError.message : String(renderError),
          hint: 'Check node-canvas installation (see README)',
        },
        { outputScale }
      );
      res.status(500).type('png').set('Cache-Control', 'no-store').send(png);
    }
  })
);

/** 多服一览（JSON）：一次返回多台服务器的状态 */
app.get(
  '/api/overview',
  asyncHandler(async (req, res) => {
    const parsed = parseServersParam(req.query);
    if (parsed.error) {
      res.status(400).json({ online: false, error: parsed.error, errorCode: parsed.errorCode });
      return;
    }

    const timeout = parseTimeout(req.query.timeout);
    if (timeout.error) {
      res.status(400).json({ online: false, error: timeout.error, errorCode: timeout.errorCode });
      return;
    }

    const refresh = isTruthy(req.query.refresh) || isTruthy(req.query.nocache);
    const servers = await Promise.all(
      parsed.servers.map(async ({ displayName, ...server }) => {
        const status = await getStatus({ ...server, timeoutMs: timeout.value, refresh });
        return displayName ? { ...status, displayName } : status;
      })
    );

    const onlineCount = servers.filter((server) => server.online).length;
    res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
    res.json({
      total: servers.length,
      online: onlineCount,
      offline: servers.length - onlineCount,
      players: servers.reduce((sum, server) => sum + (server.online ? server.players : 0), 0),
      maxPlayers: servers.reduce((sum, server) => sum + (server.online ? server.maxPlayers : 0), 0),
      servers,
    });
  })
);

/** 多服一览（PNG 图片）：一行一台服务器，高度随数量自适应 */
app.get(
  '/api/overview.png',
  asyncHandler(async (req, res) => {
    const parsed = parseServersParam(req.query);
    const scale = parseScale(req.query.scale, DEFAULT_OUTPUT_SCALE);
    const outputScale = scale.value ?? DEFAULT_OUTPUT_SCALE;
    const theme = parseTheme(req.query.theme);
    const style = parseStyle(req.query.style, themeStyle(theme.value ?? DEFAULT_THEME));

    if (style.error) {
      const png = await renderMessageBanner(
        { kind: 'invalid', code: style.errorCode, message: style.error },
        { outputScale }
      );
      res.status(400).type('png').set('Cache-Control', 'no-store').send(png);
      return;
    }

    if (theme.error) {
      const png = await renderMessageBanner(
        { kind: 'invalid', code: theme.errorCode, message: theme.error },
        { outputScale }
      );
      res.status(400).type('png').set('Cache-Control', 'no-store').send(png);
      return;
    }

    if (parsed.error) {
      const png = await renderMessageBanner(
        { kind: 'invalid', code: parsed.errorCode, message: parsed.error },
        { outputScale }
      );
      res.status(400).type('png').set('Cache-Control', 'no-store').send(png);
      return;
    }

    const timeout = parseTimeout(req.query.timeout);
    if (timeout.error) {
      const png = await renderMessageBanner(
        { kind: 'invalid', code: timeout.errorCode, message: timeout.error },
        { outputScale }
      );
      res.status(400).type('png').set('Cache-Control', 'no-store').send(png);
      return;
    }

    const refresh = isTruthy(req.query.refresh) || isTruthy(req.query.nocache);
    const startedAt = Date.now();
    const statuses = await Promise.all(
      parsed.servers.map(async ({ displayName, ...server }) => {
        const status = await getStatus({ ...server, timeoutMs: timeout.value, refresh });
        return displayName ? { ...status, displayName } : status;
      })
    );

    try {
      const png = await renderOverview(statuses, {
        outputScale,
        elapsedMs: Date.now() - startedAt,
        theme: theme.value,
        style: style.value,
      });
      res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
      res.set('X-Query-Status', statuses.every((status) => status.online) ? 'online' : 'partial');
      res.type('png').send(png);
    } catch (renderError) {
      const png = await renderMessageBanner(
        {
          kind: 'render-error',
          message: renderError instanceof Error ? renderError.message : String(renderError),
          hint: 'Check node-canvas installation (see README)',
        },
        { outputScale }
      );
      res.status(500).type('png').set('Cache-Control', 'no-store').send(png);
    }
  })
);

/** 可用主题列表（含每套主题配套的布局） */
app.get('/api/themes', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ default: DEFAULT_THEME, themes: listThemes() });
});

/** 可用视觉语言列表 */
app.get('/api/styles', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ styles: listStyles() });
});

/** 可用布局列表 */
app.get('/api/layouts', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ default: DEFAULT_LAYOUT, layouts: listLayouts() });
});

/** 简单的作业状态接口，便于部署时做健康检查 */
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    cache: getCacheStats(),
  });
});

/** 404 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    endpoints: [
      '/api/status',
      '/api/banner.png',
      '/api/overview',
      '/api/overview.png',
      '/api/themes',
      '/api/layouts',
      '/api/styles',
      '/healthz',
    ],
  });
});

/** 兜底错误处理 */
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error('[mcstatus-api] 未捕获错误:', error);
  if (res.headersSent) return;
  res.status(500).json({
    error: 'Internal Server Error',
    message: error instanceof Error ? error.message : String(error),
  });
});

/* ------------------------------- 启动 ----------------------------------- */

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const server = app.listen(APP_PORT, () => {
    const example = `http://localhost:${APP_PORT}/api/banner.png?host=play.example.com&port=25565&queryPort=25566`;
    console.log(`[mcstatus-api] 已启动，监听端口 ${APP_PORT}`);
    console.log(`[mcstatus-api] JSON:  http://localhost:${APP_PORT}/api/status?host=play.example.com`);
    console.log(`[mcstatus-api] 图片:  ${example}`);

    // 字体自检打一行日志：容器里最容易踩的坑就是「字体没装 → 中文/emoji 画成方框」
    const fonts = getFontDiagnostics();
    console.log(
      `[mcstatus-api] 字体: UI 字重 ${fonts.uiWeights.length} 个${fonts.uiHasCjk ? '（含中文）' : ''}` +
        `；系统 CJK ${fonts.cjk ?? '未找到'}` +
        `；emoji ${fonts.emojiFile ?? '未找到（星体面 emoji 会被跳过）'}` +
        `；符号 ${fonts.symbolFile ?? '未找到（交给主字体回退）'}`
    );
  });

  server.on('error', (error) => {
    console.error('[mcstatus-api] 启动失败:', error.message);
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    console.log(`\n[mcstatus-api] 收到 ${signal}，正在关闭...`);
    server.close(() => process.exit(0));
    // 兜底：2 秒内没关完就强制退出
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export { app, parseQueryParams, APP_PORT };
export default app;
