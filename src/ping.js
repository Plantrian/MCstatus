/**
 * src/ping.js
 * ---------------------------------------------------------------------------
 * Server List Ping（SLP，TCP）—— 就是「多人游戏」列表里那一套协议。
 *
 * 为什么会需要它：Query（UDP）只给出 MOTD/人数/完整玩家名，**没有服务器图标、
 * 没有延迟、也没有协议号**。而原版多人列表里能看到的东西恰好是 SLP 提供的：
 *   - favicon：服务器图标（64x64 PNG 的 base64 data URL）
 *   - description：两行 MOTD（支持聊天组件/§ 颜色码）
 *   - players：在线人数、上限、以及最多若干条玩家采样（带 UUID）
 *   - version：版本名 + 协议号
 *   - 延迟：状态交换的往返耗时（原版列表里那几格信号条）
 *
 * 协议流程：
 *   1) 握手包  0x00 + 协议号(-1) + 地址 + 端口(uint16) + 下一状态(1=status)
 *   2) 状态请求 0x00
 *   3) 状态响应 0x00 + JSON 字符串
 * 包里所有整数都是 VarInt，字符串是 VarInt 长度 + UTF-8 字节。
 * ---------------------------------------------------------------------------
 */

import net from 'node:net';

/** 默认 SLP 超时（毫秒） */
export const PING_TIMEOUT_MS = 3000;
/** -1 的 VarInt 表示「我只想查状态」，服务端会原样返回自己的协议号 */
const PROTOCOL_VERSION = -1;

/* ------------------------------ VarInt ---------------------------------- */

/** 写 VarInt（负数按 32 位补码处理，-1 -> FF FF FF FF 0F） */
function writeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return Buffer.from(bytes);
}

/**
 * 读 VarInt。
 * @returns {{ value: number, offset: number, size: number } | null} 数据不够时返回 null
 */
function readVarInt(buffer, offset) {
  let value = 0;
  let position = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << (7 * position);
    position += 1;
    if ((byte & 0x80) === 0) {
      return { value: value | 0, offset: cursor, size: position };
    }
    if (position > 5) throw new Error('VarInt 长度超过 5 字节，响应非法');
  }
  return null; // 还没收全
}

/** 写「VarInt 长度 + UTF-8 内容」的字符串 */
function writeString(text) {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

/* ------------------------------ 包构造 ----------------------------------- */

/** 握手包（外层再套一个 VarInt 长度） */
function buildHandshakePacket(host, port) {
  const portBuffer = Buffer.alloc(2);
  portBuffer.writeUInt16BE(port, 0);

  const payload = Buffer.concat([
    writeVarInt(0x00), // packet id
    writeVarInt(PROTOCOL_VERSION),
    writeString(host),
    portBuffer,
    writeVarInt(1), // next state: 1 = status
  ]);

  return Buffer.concat([writeVarInt(payload.length), payload]);
}

/** 状态请求包：长度 1，内容只有 packet id 0x00 */
const STATUS_REQUEST = Buffer.from([0x01, 0x00]);

/* ------------------------------ 结果构造 --------------------------------- */

function pingOffline({ error, errorCode, startedAt }) {
  return {
    online: false,
    error,
    errorCode,
    latencyMs: null,
    version: null,
    protocol: null,
    players: 0,
    maxPlayers: 0,
    samplePlayers: [],
    descriptionText: '',
    favicon: null,
    enforcesSecureChat: null,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 把 SLP 的 description 拍平成纯文本（保留 § 颜色码，交由上层清洗）。
 * 原版可能是字符串、也可能是 { text, extra: [...] } 聊天组件。
 */
export function flattenDescription(description) {
  if (typeof description === 'string') return description;
  if (Array.isArray(description)) return description.map(flattenDescription).join('');
  if (description && typeof description === 'object') {
    let text = typeof description.text === 'string' ? description.text : '';
    if (Array.isArray(description.extra)) {
      text += description.extra.map(flattenDescription).join('');
    }
    return text;
  }
  return '';
}

/* ------------------------------ 对外接口 --------------------------------- */

/**
 * 对服务器做一次 SLP 查询（TCP，使用**游戏端口**）。
 * 永不 reject：失败时返回 online:false + 原因。
 *
 * @param {object} options
 * @param {string} options.host      服务器地址（域名或 IP）
 * @param {number} options.port      游戏端口，SLP 走 TCP
 * @param {number} [options.timeoutMs] 超时，默认 3000ms
 */
export function pingServer({ host, port, timeoutMs = PING_TIMEOUT_MS }) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    let connectTime = 0; // TCP 建连完成的时刻，用于计算延迟

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(Math.min(Math.max(Number(timeoutMs) || PING_TIMEOUT_MS, 100), 10_000));

    socket.on('timeout', () => {
      finish(
        pingOffline({
          error: `Server list ping timed out after ${timeoutMs}ms: no TCP response from ${host}:${port}`,
          errorCode: 'TIMEOUT',
          startedAt,
        })
      );
    });

    socket.on('error', (error) => {
      const code = error && error.code ? error.code : error.message;
      finish(
        pingOffline({
          error: `TCP ${code}: could not reach ${host}:${port} (server offline, or the port is closed)`,
          errorCode: 'CONNECTION_ERROR',
          startedAt,
        })
      );
    });

    socket.on('close', () => {
      finish(
        pingOffline({
          error: `Connection to ${host}:${port} closed before a status response was received`,
          errorCode: 'BAD_RESPONSE',
          startedAt,
        })
      );
    });

    socket.on('connect', () => {
      connectTime = Date.now();
      socket.write(buildHandshakePacket(host, port));
      socket.write(STATUS_REQUEST);
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        const length = readVarInt(buffer, 0);
        if (!length) return; // 长度字段还没收全
        if (buffer.length < length.size + length.value) return; // 包体还没收全

        const body = buffer.subarray(length.size, length.size + length.value);
        const packetId = readVarInt(body, 0);
        if (!packetId || packetId.value !== 0x00) {
          finish(
            pingOffline({
              error: `Unexpected status packet id: ${packetId ? packetId.value : 'unknown'}`,
              errorCode: 'BAD_RESPONSE',
              startedAt,
            })
          );
          return;
        }

        const jsonLength = readVarInt(body, packetId.offset);
        const jsonText = body
          .subarray(jsonLength.offset, jsonLength.offset + jsonLength.value)
          .toString('utf8');
        const data = JSON.parse(jsonText);

        // 延迟 = 从 TCP 建连完成到收到状态响应的往返耗时（≈ 列表里的信号格）
        const latencyMs = connectTime ? Date.now() - connectTime : Date.now() - startedAt;
        const samplePlayers = Array.isArray(data?.players?.sample)
          ? data.players.sample
              .filter((entry) => entry && typeof entry.name === 'string')
              .map((entry) => ({ name: entry.name, id: entry.id ?? null }))
          : [];

        finish({
          online: true,
          error: null,
          errorCode: null,
          latencyMs,
          version: data?.version?.name ?? null,
          protocol: typeof data?.version?.protocol === 'number' ? data.version.protocol : null,
          players: typeof data?.players?.online === 'number' ? data.players.online : 0,
          maxPlayers: typeof data?.players?.max === 'number' ? data.players.max : 0,
          samplePlayers,
          descriptionText: flattenDescription(data?.description),
          favicon: typeof data?.favicon === 'string' ? data.favicon : null,
          enforcesSecureChat: typeof data?.enforcesSecureChat === 'boolean' ? data.enforcesSecureChat : null,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        finish(
          pingOffline({
            error: `Failed to parse status response: ${error.message}`,
            errorCode: 'BAD_RESPONSE',
            startedAt,
          })
        );
      }
    });

    socket.connect({ host, port });
  });
}
