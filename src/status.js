/**
 * src/status.js
 * ---------------------------------------------------------------------------
 * 把两个协议的结果合并成一份「服务器状态」，并带 30 秒内存缓存。
 *
 *   Query（UDP，queryPort） → 完整玩家列表、插件列表、世界名、软件名
 *   Ping （TCP，port）      → 服务器图标、延迟、协议号、MOTD（两行）、玩家采样
 *
 * 两者并行发起：
 *   - 都成功：信息最全（推荐同时开启 Query + 正常开服）
 *   - 只有 Ping 成功：服务器其实在线（Query 未开启是很常见的情况），
 *     仍然可以显示图标/延迟/人数/MOTD，玩家列表退化为 SLP 采样列表
 *   - 都失败：online=false，并分别保留两个协议的错误原因
 * ---------------------------------------------------------------------------
 */

import {
  CACHE_TTL_MS,
  DEFAULT_GAME_PORT,
  DEFAULT_TIMEOUT_MS,
  queryServer,
  stripMinecraftFormatting,
} from './query.js';
import { pingServer } from './ping.js';

export { CACHE_TTL_MS, DEFAULT_GAME_PORT, DEFAULT_TIMEOUT_MS };

/** 缓存最大条目数 */
const MAX_CACHE_ENTRIES = 500;

/**
 * 并行做一次 Query(UDP) + Ping(TCP)，并合并结果（两个子调用都不会 reject）
 */
async function probe({ host, port, queryPort, timeoutMs }) {
  const [query, ping] = await Promise.all([
    queryServer({ host, port, queryPort, timeoutMs }),
    pingServer({ host, port, timeoutMs }),
  ]);

  const online = Boolean(query.online || ping.online);

  // 玩家列表：优先用 Query 的完整列表；只有 SLP 时退化为采样列表
  const slpNames = ping.samplePlayers.map((player) => player.name);
  const playerList = query.online ? query.playerList : ping.online ? slpNames : [];
  const playerListSource = query.online ? 'query' : ping.online && slpNames.length > 0 ? 'slp-sample' : null;

  // MOTD：优先用 SLP 的 description（就是多人列表里显示的那两行）
  const motdRaw = String(ping.descriptionText || query.motdRaw || '').replace(/[ \t]+$/, '');
  const motdLines = cleanMotdLines(motdRaw);

  return {
    online,
    host,
    port,
    queryPort,

    motd: stripMinecraftFormatting(motdRaw),
    motdRaw,
    /** 清洗后的 MOTD 分行（最多 2 行，与原版多人列表一致） */
    motdLines,

    players: query.online ? query.players : ping.players,
    maxPlayers: query.online ? query.maxPlayers : ping.maxPlayers,
    playerList,
    playerListSource,
    samplePlayers: ping.samplePlayers,

    version: ping.version || query.version,
    protocol: ping.protocol,
    latencyMs: ping.latencyMs,
    serverIcon: ping.favicon,
    description: ping.descriptionText || null,

    software: query.software,
    plugins: query.plugins,
    map: query.map,
    gametype: query.gametype,
    gameId: query.gameId,
    serverIp: query.serverIp,
    serverPort: query.serverPort,

    /** 两个协议各自是否成功，便于调用方判断数据完整度 */
    sources: { query: query.online, ping: ping.online },
    queryError: query.online ? null : query.error,
    pingError: ping.online ? null : ping.error,

    // 只有在两个协议都失败时才认为「离线」，并给出主要原因
    error: online ? null : ping.error || query.error,
    errorCode: online ? null : ping.errorCode || query.errorCode,

    queriedAt: new Date().toISOString(),
    durationMs: Math.max(query.durationMs, ping.durationMs),
  };
}

/**
 * 清洗 MOTD 并保留原版的两行结构：
 * 先按换行切分，再逐行去掉 § 颜色码，最后丢掉空行、最多取 2 行。
 */
function cleanMotdLines(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.replace(/§[0-9A-FK-ORa-fk-or]/g, '').replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, 2);
}

/* ------------------------------- 缓存 ------------------------------------ */

/**
 * 内存缓存：key -> { expiresAt, promise }
 * 缓存 Promise，因此并发的 JSON / 图片请求只会触发一轮真实的 UDP+TCP 查询。
 * @type {Map<string, { expiresAt: number, promise: Promise<object> }>}
 */
const cache = new Map();

/** 生成缓存 key：`${host}:${port}:${queryPort}` */
export function cacheKey(host, port, queryPort) {
  return `${host}:${port}:${queryPort}`;
}

/** 清理过期条目；条目过多时按过期时间淘汰最旧的一批 */
function pruneCache(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const overflow = cache.size - MAX_CACHE_ENTRIES;
  for (let i = 0; i < overflow; i += 1) cache.delete(sorted[i][0]);
}

/**
 * 带缓存地查询服务器状态（JSON 与图片共用同一份缓存）。
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} [options.port]      游戏端口，默认 25565
 * @param {number} [options.queryPort] Query 的 UDP 端口，默认等于 port
 * @param {number} [options.timeoutMs] 单次协议超时，默认 3000ms
 * @param {number} [options.ttl]       自定义缓存有效期
 * @param {boolean} [options.refresh]  true 时忽略缓存强制重查
 * @returns {Promise<object>} 永远 resolve
 */
export function getStatus({
  host,
  port = DEFAULT_GAME_PORT,
  queryPort = port,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttl = CACHE_TTL_MS,
  refresh = false,
} = {}) {
  const key = cacheKey(host, port, queryPort);
  const now = Date.now();

  if (!refresh) {
    const hit = cache.get(key);
    // 命中缓存时打上标记，调用方（JSON / 图片）可以据此说明「这是缓存结果」
    if (hit && hit.expiresAt > now) return hit.promise.then((status) => ({ ...status, cached: true }));
  }

  const promise = probe({ host, port, queryPort, timeoutMs })
    .then((status) => ({ ...status, cached: false }))
    .catch((error) => ({
    online: false,
    host,
    port,
    queryPort,
    error: error instanceof Error ? error.message : String(error),
    errorCode: 'UNKNOWN',
    motd: null,
    motdRaw: null,
    motdLines: [],
    players: 0,
    maxPlayers: 0,
    playerList: [],
    playerListSource: null,
    samplePlayers: [],
    version: null,
    protocol: null,
    latencyMs: null,
    serverIcon: null,
    description: null,
    software: null,
    plugins: [],
    map: null,
    gametype: null,
    gameId: null,
    serverIp: null,
    serverPort: null,
    sources: { query: false, ping: false },
    queryError: null,
    pingError: null,
    cached: false,
    queriedAt: new Date().toISOString(),
    durationMs: 0,
  }));

  cache.set(key, { expiresAt: now + Math.max(0, Number(ttl) || CACHE_TTL_MS), promise });
  pruneCache(now);

  return promise;
}

/** 缓存概况（/healthz 用） */
export function getCacheStats() {
  const now = Date.now();
  let alive = 0;
  for (const entry of cache.values()) if (entry.expiresAt > now) alive += 1;
  return { entries: cache.size, alive, ttlMs: CACHE_TTL_MS, maxEntries: MAX_CACHE_ENTRIES };
}

/** 清空缓存（调试用） */
export function clearCache() {
  cache.clear();
}
