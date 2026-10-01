/**
 * test/mock-server.mjs
 * ---------------------------------------------------------------------------
 * 「假 Minecraft 服务器」，同时实现两套协议，用于本地开发与自测：
 *
 *   TCP 25565  Server List Ping  → 服务器图标(64x64 favicon)、延迟、版本/协议号、
 *                                  两行 MOTD、玩家采样（多人列表里能看到的那套）
 *   UDP 25566  GameSpy4 Query    → 完整玩家列表、插件列表、世界名、软件名
 *
 * 直接运行（默认监听 25565 / 25566）：
 *   node test/mock-server.mjs
 *
 * 也可以被 import 进测试，用随机端口：
 *   const server = await startMockServer({ withSlp: true, withQuery: true });
 *   server.gamePort / server.queryPort / server.stats / server.close()
 * ---------------------------------------------------------------------------
 */

import dgram from 'node:dgram';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { createCanvas } from 'canvas';

/** 玩家名单（12 人，其中最后一个人为「头像加载失败」的演示位） */
export const MOCK_PLAYERS = [
  'Notch',
  'jeb_',
  'Dinnerbone',
  'Grumm',
  'Herobrine',
  'Steve',
  'Alex',
  'Ari',
  'Efe',
  'Kai',
  'Sunny',
  'Noor',
];

/** 玩家列表里刻意混入一个特殊名字，方便验证「头像加载失败」时的占位逻辑 */
export const MOCK_MOTD = '§a§lAstrBot §r§6Demo Server\n§7Powered by §fQuery + SLP§7, 12 players online';

const MOCK_KV = {
  hostname: '§a§lAstrBot §r§6Demo Server   §7demo of query protocol',
  gametype: 'SMP',
  game_id: 'MINECRAFT',
  version: '1.20.4',
  plugins: 'Paper on 1.20.4-R0.1-SNAPSHOT: WorldEdit 7.3.0; EssentialsX 2.20.1; Vault 1.7.3',
  map: 'world_the_end',
  numplayers: String(MOCK_PLAYERS.length),
  maxplayers: '100',
  hostip: '127.0.0.1',
};
const KV_ORDER = ['hostname', 'gametype', 'game_id', 'version', 'plugins', 'map', 'numplayers', 'maxplayers', 'hostport', 'hostip'];

/* ------------------------- 服务器图标（64x64） ------------------------- */

/** 用 canvas 现画一个苦力怕脸，转成 SLP 要求的 data URL */
function makeServerIcon() {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4a7c3f';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#2c4a27';
  ctx.fillRect(0, 0, 64, 6);
  ctx.fillRect(0, 58, 64, 6);
  ctx.fillStyle = '#11160f';
  ctx.fillRect(12, 16, 12, 12);
  ctx.fillRect(40, 16, 12, 12);
  ctx.fillRect(24, 32, 16, 8);
  ctx.fillRect(16, 40, 12, 10);
  ctx.fillRect(36, 40, 12, 10);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

/* ------------------------------ VarInt ---------------------------------- */

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

function readVarInt(buffer, offset) {
  let value = 0;
  let position = 0;
  let cursor = offset;
  for (;;) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << (7 * position);
    position += 1;
    if ((byte & 0x80) === 0) return { value, size: position };
  }
}

function writeString(text) {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

/* --------------------------- UDP: Query 协议 ---------------------------- */

const QUERY_CHALLENGE = '1701240911';
const SESSION_MASK = 0x0f0f0f0f;

function buildFullStatPacket(hostPort, players) {
  const head = Buffer.alloc(16);
  head.writeUInt8(0x00, 0);
  head.writeInt32BE(1 & SESSION_MASK, 1);

  let body = 'splitnum\x00\x80\x00';
  for (const key of KV_ORDER) {
    const value =
      key === 'hostport'
        ? String(hostPort)
        : key === 'numplayers'
          ? String(players.length)
          : MOCK_KV[key] ?? '';
    body += `${key}\x00${value}\x00`;
  }
  body += '\x00\x01player_\x00\x00';
  for (const name of players) body += `${name}\x00`;

  return Buffer.concat([head, Buffer.from(body, 'utf8')]);
}

/* -------------------------- TCP: Server List Ping ----------------------- */

function handleSlpConnection(socket, { gamePort, icon, stats, players }) {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // 握手包：[长度][0x00][协议号][地址][端口][下一状态]
    const length = readVarInt(buffer, 0);
    if (buffer.length < length.size + length.value + 2) return;
    const packetId = readVarInt(buffer, length.size);
    if (packetId.value !== 0x00) return;

    // 紧随其后的状态请求：[长度=1][0x00]
    const statusOffset = length.size + length.value;
    if (buffer[statusOffset] !== 0x01 || buffer[statusOffset + 1] !== 0x00) return;
    buffer = Buffer.alloc(0);

    const payload = {
      version: { name: 'Paper 1.20.4', protocol: 765 },
      players: {
        max: 100,
        online: players.length,
        sample: players.map((name, index) => ({
          name,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        })),
      },
      description: { text: '', extra: [{ text: MOCK_MOTD }] },
      favicon: icon,
      enforcesSecureChat: false,
      previewsChat: false,
    };

    const body = Buffer.concat([writeVarInt(0x00), writeString(JSON.stringify(payload))]);
    socket.write(Buffer.concat([writeVarInt(body.length), body]));

    stats.slp += 1;
    socket.end();
  });

  socket.on('error', () => socket.destroy());
}

/* ------------------------------- 启动 ----------------------------------- */

/**
 * 启动假服务器。
 * @param {object} [options]
 * @param {boolean} [options.withSlp]   是否启用 TCP SLP，默认 true
 * @param {boolean} [options.withQuery] 是否启用 UDP Query，默认 true
 * @param {number}  [options.gamePort]  默认 25565（传 0 用随机端口）
 * @param {number}  [options.queryPort] 默认 25566（传 0 用随机端口）
 * @param {string}  [options.host]      默认 127.0.0.1
 */
export async function startMockServer({
  withSlp = true,
  withQuery = true,
  gamePort = 25565,
  queryPort = 25566,
  host = '127.0.0.1',
  quiet = true,
  /** 玩家名单，默认用 MOCK_PLAYERS；测试「人多就加行」时传更长的数组 */
  players = MOCK_PLAYERS,
} = {}) {
  const stats = { slp: 0, handshake: 0, full: 0 };
  const icon = makeServerIcon();
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  let tcpServer = null;
  let udpSocket = null;
  let actualGamePort = null;
  let actualQueryPort = null;

  if (withSlp) {
    tcpServer = net.createServer((socket) =>
      handleSlpConnection(socket, { gamePort: actualGamePort, icon, stats, players })
    );
    actualGamePort = await new Promise((resolve, reject) => {
      tcpServer.once('error', reject);
      tcpServer.listen(gamePort, host, () => resolve(tcpServer.address().port));
    });
    log(`[mock] SLP   TCP ${host}:${actualGamePort} 就绪（图标 / 延迟 / 版本 / 两行 MOTD / 12 人采样）`);
  }

  if (withQuery) {
    udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', (message, rinfo) => {
      const type = message.readUInt8(2);

      if (type === 0x09) {
        stats.handshake += 1;
        const response = Buffer.alloc(9 + QUERY_CHALLENGE.length + 1);
        response.writeUInt8(0x09, 0);
        response.writeInt32BE(message.readInt32BE(3), 1);
        response.write(`${QUERY_CHALLENGE}\x00`, 5, 'utf8');
        udpSocket.send(response, rinfo.port, rinfo.address);
        return;
      }

      if (type === 0x00) {
        stats.full += 1;
        const packet = buildFullStatPacket(actualGamePort ?? gamePort, players);
        packet.writeInt32BE(message.readInt32BE(3), 1);
        udpSocket.send(packet, rinfo.port, rinfo.address);
      }
    });

    actualQueryPort = await new Promise((resolve, reject) => {
      udpSocket.once('error', reject);
      udpSocket.bind(queryPort, host, () => resolve(udpSocket.address().port));
    });
    log(`[mock] Query UDP ${host}:${actualQueryPort} 就绪（完整玩家列表 ${MOCK_PLAYERS.length} 人）`);
  }

  return {
    host,
    icon,
    players: MOCK_PLAYERS,
    motd: MOCK_MOTD,
    stats,
    get gamePort() {
      return actualGamePort;
    },
    get queryPort() {
      return actualQueryPort;
    },
    close: () => {
      if (tcpServer) tcpServer.close();
      if (udpSocket) {
        try {
          udpSocket.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  };
}

/* ------------------------------ 直接运行 --------------------------------- */

// 注意：Windows 的路径分隔符是 `\`，不能用 split('/') 取文件名，否则本地永远跑不起来
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const server = await startMockServer({ quiet: false });
  console.log(`[mock] 用这套参数测试：`);
  console.log(`       http://localhost:3001/api/status?host=127.0.0.1&port=${server.gamePort}&queryPort=${server.queryPort}`);
  console.log(`       http://localhost:3001/api/banner.png?host=127.0.0.1&port=${server.gamePort}&queryPort=${server.queryPort}`);
  setInterval(() => {
    console.log(
      `[mock] 累计 —— SLP ${server.stats.slp} · Query 握手 ${server.stats.handshake} / 全量 ${server.stats.full}`
    );
  }, 20000).unref();
}
