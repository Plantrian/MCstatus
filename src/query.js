/**
 * src/query.js
 * ---------------------------------------------------------------------------
 * Minecraft Query 协议（GameSpy4 / UDP）查询客户端 + 内存 TTL 缓存
 *
 * 为什么这里用 node:dgram 手写协议，而不是直接 import 需求里点名的
 * @hloth/minecraft-query：
 *   1. 该包 1.0.0 只发布了 TypeScript 源码（package.json -> "main": "index.ts"，
 *      files 字段里没有编译产物）。在纯 Node 环境下 import 会直接抛：
 *      TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
 *      也就是说 `npm install && npm start` 跑不起来（除非额外挂 tsx/ts-node 加载器）。
 *   2. 它内部会强制做 `_minecraft._udp.<host>` 的 SRV 解析，且一个查询只能传一个端口，
 *      无法把「游戏端口」和「Query 端口」分开。
 *   3. 它解析全量响应时用了 `toString('utf-8', 11)`，比协议真实偏移（16）少了 5 字节，
 *      键值对会错位；并且 `info.plugins.split(':')` 在没有 plugins 字段时会抛异常。
 *   因此这里用 dgram 实现「等价且稳定」的协议逻辑，行为与广泛使用的
 *   minecraft-server-util（queryFull）保持一致，同时满足：
 *     - game port 与 query port 完全分离
 *     - 不做 SRV 解析（Query 协议直接用 queryPort 即可）
 *     - 零额外依赖、可完整拿到玩家列表
 *
 * 协议流程（见 https://wiki.vg/Query）：
 *   1) 握手：FE FD 09 + sessionId(int32 BE)
 *      响应：0x09 + sessionId + challengeToken 字符串（NUL 结尾）
 *   2) 全量：FE FD 00 + sessionId + challengeToken(int32 BE) + 4 个 0x00
 *      响应：0x00 + sessionId + 11 字节填充 + 键值对 + 玩家列表
 * ---------------------------------------------------------------------------
 */

import dgram from 'node:dgram';

/* -------------------------------- 常量 ---------------------------------- */

/** 默认游戏端口 */
export const DEFAULT_GAME_PORT = 25565;
/** 单次 UDP 请求等待响应的超时时间（毫秒） */
export const DEFAULT_TIMEOUT_MS = 3000;
/** 缓存有效期（毫秒），同时也是响应头 Cache-Control 的 max-age */
export const CACHE_TTL_MS = 30_000;

/** 请求包的魔术字 0xFE 0xFD */
const PACKET_MAGIC = 0xfefd;
/** 握手包类型 */
const TYPE_HANDSHAKE = 0x09;
/** 全量统计包类型 */
const TYPE_STAT = 0x00;
/** 会话 ID：客户端自选，服务端会原样回显（vanilla 同样会 & 0x0F0F0F0F） */
const SESSION_ID = 0x01020304 & 0x0f0f0f0f;

/**
 * 键值对与玩家列表之间的分隔符。
 * vanilla 服务端在玩家段前写入： 00 01 "player_" 00 00
 * （wiki.vg 抓包示例里该片段同样存在）
 */
const PLAYER_SECTION_SEPARATOR = '\x00\x01player_\x00\x00';
/** 兜底分隔符：万一服务端少发了前缀字节 */
const PLAYER_SECTION_FALLBACK = 'player_\x00';

/** 缓存最大条目数，超过后清理过期项与最早的条目，防止内存无限增长 */
const MAX_CACHE_ENTRIES = 500;
/** 允许的最大超时时间，避免调用方传入超大值把连接占死 */
const MAX_TIMEOUT_MS = 10_000;

/* ------------------------------- 工具 ----------------------------------- */

/** 查询相关错误的统一类型，带 code 便于区分超时 / 套接字错误 */
class QueryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 去掉 MOTD / 服务器名里的 § 颜色与格式代码。
 * 覆盖 §0-§f、§k-§r（含大写形式），以及 §x 十六进制 RGB 写法。
 */
export function stripMinecraftFormatting(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/§[0-9A-FK-ORa-fk-or]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------- 协议包构造 --------------------------------- */

/** 构造握手请求包（共 7 字节） */
function buildHandshakeRequest() {
  const buf = Buffer.alloc(7);
  buf.writeUInt16BE(PACKET_MAGIC, 0);
  buf.writeUInt8(TYPE_HANDSHAKE, 2);
  buf.writeInt32BE(SESSION_ID, 3);
  return buf;
}

/**
 * 构造全量统计请求包（共 15 字节）
 * challengeToken 由握手响应给出，必须是 32 位有符号整数。
 */
function buildFullStatRequest(challengeToken) {
  const buf = Buffer.alloc(15);
  buf.writeUInt16BE(PACKET_MAGIC, 0);
  buf.writeUInt8(TYPE_STAT, 2);
  buf.writeInt32BE(SESSION_ID, 3);
  buf.writeInt32BE(challengeToken, 7);
  buf.writeUInt32BE(0, 11);
  return buf;
}

/**
 * 解析握手响应，取出 challenge token。
 * 部分服务端会返回无符号大数（例如 3000000000），这里统一收敛到 int32。
 */
function parseChallengeToken(packet) {
  const raw = packet.subarray(5).toString('utf8').split('\x00')[0].trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new QueryError(`Server returned an invalid challenge token: ${JSON.stringify(raw)}`, 'BAD_CHALLENGE');
  }
  let token = parsed >>> 0; // 先按无符号 32 位截断
  if (token > 0x7fffffff) token -= 0x1_0000_0000; // 再转回有符号，便于 writeInt32BE
  return token;
}

/**
 * 解析全量统计响应（type 0x00）。
 * 报文结构：
 *   [0]     0x00
 *   [1..4]  sessionId (int32 BE)
 *   [5..15] 11 字节填充
 *   [16.. ] 键值对 + 玩家段
 *
 * @returns {{ info: Record<string,string>, playerList: string[] }}
 */
export function parseFullStat(packet) {
  const payload = packet.subarray(16).toString('utf8');

  let infoText = payload;
  let playersText = '';

  const separatorIndex = payload.indexOf(PLAYER_SECTION_SEPARATOR);
  if (separatorIndex !== -1) {
    infoText = payload.slice(0, separatorIndex);
    playersText = payload.slice(separatorIndex + PLAYER_SECTION_SEPARATOR.length);
  } else {
    const fallbackIndex = payload.indexOf(PLAYER_SECTION_FALLBACK);
    if (fallbackIndex !== -1) {
      infoText = payload.slice(0, fallbackIndex);
      playersText = payload.slice(fallbackIndex + PLAYER_SECTION_FALLBACK.length);
    }
  }

  // 键值对：key\0value\0key\0value\0 ...（第一对固定是 splitnum -> "\x80"）
  const tokens = infoText.split('\x00');
  const info = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = tokens[i].replace(/^\x01/, '');
    if (key === '' || key === 'player_') break; // 空 key 表示键值对结束
    info[key] = tokens[i + 1];
  }

  // 玩家列表：每个名字以 \0 结尾，中间的空白片段直接丢弃
  const playerList = playersText
    .split('\x00')
    .map((name) => name.replace(/^\x01/, '').trim())
    .filter((name) => name.length > 0);

  return { info, playerList };
}

/**
 * 解析 plugins 字段。
 * 典型值：`Paper on 1.20.1: WorldEdit 7.2.15; EssentialsX 2.19.0`
 * 只按第一个冒号切分，避免插件版本号里的冒号把结果切碎。
 */
export function parsePluginsField(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { software: null, plugins: [] };
  }
  const value = raw.trim();
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) {
    return { software: value, plugins: [] };
  }
  const software = value.slice(0, colonIndex).trim() || null;
  const plugins = value
    .slice(colonIndex + 1)
    .split(';')
    .map((plugin) => plugin.trim())
    .filter((plugin) => plugin.length > 0);
  return { software, plugins };
}

/* ------------------------------ UDP 收发 --------------------------------- */

/**
 * 在给定 socket 上发送一个请求包，并等待符合期望的响应包。
 * 只接受「包类型 + sessionId」都匹配的报文，其余（乱序包、伪造包）直接忽略。
 */
function sendAndReceive(socket, packet, { host, port, timeoutMs, expectedType }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(message);
    };

    const onMessage = (message) => {
      if (message.length < 6) return;
      if (message[0] !== expectedType) return;
      if (message.readInt32BE(1) !== SESSION_ID) return;
      finish(null, message);
    };

    const onError = (error) => {
      finish(new QueryError(`UDP socket error: ${error.message}`, 'SOCKET_ERROR'));
    };

    timer = setTimeout(() => {
      finish(
        new QueryError(
          `Query timed out after ${timeoutMs}ms: no UDP response from ${host}:${port} (server offline, or the query port is blocked by a firewall)`,
          'TIMEOUT'
        )
      );
    }, timeoutMs);

    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(packet, port, host, (error) => {
      if (error) finish(new QueryError(`Failed to send UDP packet: ${error.message}`, 'SEND_ERROR'));
    });
  });
}

/**
 * 执行一次完整的 Query 查询（握手 + 全量统计）。
 * 注意：game port 只用于展示，真正通信的是 queryPort。
 */
async function queryOnce({ host, port, queryPort, timeoutMs }) {
  const socket = dgram.createSocket('udp4');
  try {
    // 1) 握手拿 challenge token
    const handshakeResponse = await sendAndReceive(socket, buildHandshakeRequest(), {
      host,
      port: queryPort,
      timeoutMs,
      expectedType: TYPE_HANDSHAKE,
    });
    const challengeToken = parseChallengeToken(handshakeResponse);

    // 2) 全量统计（含完整玩家列表）
    const statResponse = await sendAndReceive(socket, buildFullStatRequest(challengeToken), {
      host,
      port: queryPort,
      timeoutMs,
      expectedType: TYPE_STAT,
    });

    return parseFullStat(statResponse);
  } finally {
    try {
      socket.close();
    } catch {
      /* 已经被关闭时忽略 */
    }
  }
}

/* ---------------------------- 结果归一化 --------------------------------- */

/** 构造「在线」结果对象 */
function normalizeOnline({ host, port, queryPort, info, playerList, startedAt }) {
  const motdRaw = info.hostname ?? '';
  const { software, plugins } = parsePluginsField(info.plugins);

  return {
    online: true,
    host,
    port,
    queryPort,
    motd: stripMinecraftFormatting(motdRaw),
    motdRaw,
    players: Number.parseInt(info.numplayers ?? '0', 10) || 0,
    maxPlayers: Number.parseInt(info.maxplayers ?? '0', 10) || 0,
    playerList,
    version: info.version ?? null,
    software,
    plugins,
    map: info.map ?? null,
    gametype: info.gametype ?? null,
    gameId: info.game_id ?? null,
    serverIp: info.hostip ?? null,
    serverPort: Number.parseInt(info.hostport ?? '', 10) || null,
    queriedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** 构造「离线 / 查询失败」结果对象（不抛异常，交给调用方统一处理） */
function normalizeOffline({ host, port, queryPort, error, startedAt }) {
  return {
    online: false,
    host,
    port,
    queryPort,
    error: error instanceof Error ? error.message : String(error),
    errorCode: error && error.code ? error.code : 'UNKNOWN',
    motd: null,
    motdRaw: null,
    players: 0,
    maxPlayers: 0,
    playerList: [],
    version: null,
    software: null,
    plugins: [],
    map: null,
    gametype: null,
    gameId: null,
    serverIp: null,
    serverPort: null,
    queriedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/* ------------------------------ 对外查询 --------------------------------- */

/**
 * 直接查询服务器（不走缓存，永不 reject）。
 *
 * @param {object} options
 * @param {string} options.host       服务器地址（域名或 IP）
 * @param {number} [options.port]     游戏端口，默认 25565（仅用于展示与回包）
 * @param {number} [options.queryPort] Query 协议 UDP 端口，默认等于 port
 * @param {number} [options.timeoutMs] 单次请求超时，默认 3000ms
 * @param {number} [options.attempts] 尝试次数（UDP 丢包时重试），默认 2
 */
export async function queryServer({
  host,
  port = DEFAULT_GAME_PORT,
  queryPort = port,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 2,
} = {}) {
  const startedAt = Date.now();
  const safeTimeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
  let lastError = new QueryError('Unknown query error', 'UNKNOWN');

  const tries = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const { info, playerList } = await queryOnce({
        host,
        port,
        queryPort,
        timeoutMs: safeTimeout,
      });
      return normalizeOnline({ host, port, queryPort, info, playerList, startedAt });
    } catch (error) {
      lastError = error;
      if (attempt < tries) await delay(150);
    }
  }

  return normalizeOffline({ host, port, queryPort, error: lastError, startedAt });
}

/* ------------------------------- 说明 ------------------------------------ */

/*
 * 缓存与「Query + SLP 合并」逻辑已移到 src/status.js，
 * 本文件只负责单一协议：GameSpy4 Query（UDP）。
 */

export { QueryError };
