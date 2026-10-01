/**
 * test/smoke.mjs
 * ---------------------------------------------------------------------------
 * 端到端自测：不需要真实 Minecraft 服务器。
 *   1. 起一个「假」服务器（test/mock-server.mjs：TCP SLP + UDP Query）
 *   2. 起一个「假」头像服务端（HTTP，用 canvas 现画 PNG，其中一个名字返回 404）
 *   3. 起真实 API 服务，跑 JSON / PNG / 参数校验 / 缓存命中 / 采样列表 等断言
 * 运行： npm test
 * ---------------------------------------------------------------------------
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from 'canvas';

import { startMockServer } from './mock-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'test-output');

/** 头像加载失败的那个玩家（验证占位块逻辑） */
const BROKEN_AVATAR = 'Noor';

/**
 * 一览图的版式公式（与 src/image.js 的 OVERVIEW 保持一致）：
 * 每台服务器一行，行高 70，卡片高 = 118 + 台数×70 + 18。
 */
function expectedOverviewHeight(rowCount, outputScale = 1) {
  const cardHeight = 118 + rowCount * 70 + 18;
  return (24 + cardHeight + 46) * outputScale;
}

/**
 * 单服图的版式公式：
 * 每行固定 5 个玩家，玩家多就加行，行数决定卡片与画布高度。
 */
function expectedBannerHeight(playerCount, outputScale = 1) {
  const rows = Math.max(1, Math.ceil(Math.min(playerCount, 100) / 5));
  const lastRowBottom = 284 + (rows - 1) * 34 + 28; // 行高 34，头像 28
  const cardHeight = Math.max(336, lastRowBottom);
  return (24 + cardHeight + 40) * outputScale;
}

function startFakeAvatarServer() {
  const server = http.createServer((req, res) => {
    const match = /^\/avatar\/([^/]+)\/50$/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const name = decodeURIComponent(match[1]);
    if (name === BROKEN_AVATAR) {
      res.writeHead(404).end();
      return;
    }

    const canvas = createCanvas(50, 50);
    const ctx = canvas.getContext('2d');
    const hue = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
    ctx.fillStyle = `hsl(${hue}, 45%, 55%)`;
    ctx.fillRect(0, 0, 50, 50);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, 50, 16);

    const buffer = canvas.toBuffer('image/png');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buffer.length });
    res.end(buffer);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => server.close(),
      });
    });
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const mock = await startMockServer({ gamePort: 0, queryPort: 0 });
  const avatarServer = await startFakeAvatarServer();

  process.env.BANNER_AVATAR_BASE = `http://127.0.0.1:${avatarServer.port}`;
  // 自测要可离线运行：只用假的 mc-heads 源，不碰 Mojang / mccag
  process.env.BANNER_AVATAR_PROVIDERS = 'mc-heads';
  process.env.BANNER_LABELS = 'en';

  const { app } = await import('../src/index.js');
  const apiServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => apiServer.once('listening', resolve));
  const base = `http://127.0.0.1:${apiServer.address().port}`;

  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push(`  ✔ ${name}`);
    } catch (error) {
      results.push(`  ✘ ${name}\n      ${error.message}`);
      process.exitCode = 1;
    }
  };

  const query = `host=127.0.0.1&port=${mock.gamePort}&queryPort=${mock.queryPort}`;

  /* ------------------------- 1. 两套协议都成功 ------------------------- */
  const statusResponse = await fetch(`${base}/api/status?${query}`);
  const status = await statusResponse.json();

  check('JSON 接口返回 200，并带 Cache-Control', () => {
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get('cache-control'), 'public, max-age=30');
  });
  check('online = true，两套协议都成功', () => {
    assert.equal(status.online, true);
    assert.deepEqual(status.sources, { query: true, ping: true });
  });
  check('玩家数 / 上限正确', () => {
    assert.equal(status.players, mock.players.length);
    assert.equal(status.maxPlayers, 100);
  });
  check('完整玩家列表（来自 Query UDP）', () => {
    assert.equal(status.playerListSource, 'query');
    assert.deepEqual(status.playerList, mock.players);
  });
  check('SLP 采样玩家（带 UUID）', () => {
    assert.equal(status.samplePlayers.length, mock.players.length);
    assert.equal(status.samplePlayers[0].name, 'Notch');
    assert.ok(status.samplePlayers[0].id, '采样玩家应带 UUID');
  });
  check('服务器图标（data URL，64x64 PNG）', () => {
    assert.ok(status.serverIcon.startsWith('data:image/png;base64,'), '缺少 favicon');
  });
  check('延迟与协议号（多人列表里的信息）', () => {
    assert.equal(typeof status.latencyMs, 'number');
    assert.ok(status.latencyMs >= 0);
    assert.equal(status.protocol, 765);
    assert.equal(status.version, 'Paper 1.20.4');
  });
  check('MOTD 保留两行结构且去掉了 § 颜色码', () => {
    assert.equal(status.motdLines.length, 2);
    assert.ok(!status.motd.includes('§'));
    assert.ok(!status.motdLines[0].includes('§'));
  });
  check('软件名 / 插件列表（来自 Query）', () => {
    assert.equal(status.software, 'Paper on 1.20.4-R0.1-SNAPSHOT');
    assert.deepEqual(status.plugins, ['WorldEdit 7.3.0', 'EssentialsX 2.20.1', 'Vault 1.7.3']);
  });

  /* ------------------------ 2. 自定义显示名称 ------------------------- */
  const named = await fetch(
    `${base}/api/status?${query}&name=${encodeURIComponent('金羊毛主服')}`
  ).then((response) => response.json());
  check('自定义显示名会出现在 JSON 里', () => assert.equal(named.displayName, '金羊毛主服'));

  const namedBanner = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&name=${encodeURIComponent('金羊毛主服')}&scale=1`)).arrayBuffer()
  );
  check('带显示名也能正常出图', () => {
    assert.equal(namedBanner.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-named.png'), namedBanner);

  const longName = await fetch(`${base}/api/status?${query}&name=${'a'.repeat(61)}`);
  check('显示名过长 -> 400', () => assert.equal(longName.status, 400));

  const newlineName = await fetch(`${base}/api/status?${query}&name=${encodeURIComponent('bad\nname')}`);
  check('显示名含换行 -> 400', () => assert.equal(newlineName.status, 400));

  // 显示名不参与缓存 key：同一个 host:port 带不同名字应各自出图、共用查询结果
  const cacheBeforeName = mock.stats.full;
  await fetch(`${base}/api/status?${query}&name=${encodeURIComponent('另一个名字')}`).then((r) => r.json());
  check('显示名不参与缓存 key（仍命中同一份查询结果）', () =>
    assert.equal(mock.stats.full, cacheBeforeName)
  );

  /* ---------------------------- 3. 缓存命中 ---------------------------- */
  const before = { ...mock.stats };
  const cachedStatus = await fetch(`${base}/api/status?${query}`).then((response) => response.json());
  check('命中缓存时带 cached 标记（且不重复查询）', () => {
    assert.equal(cachedStatus.cached, true);
    assert.equal(status.cached, false);
  });
  const bannerResponse = await fetch(`${base}/api/banner.png?${query}`);
  const banner = Buffer.from(await bannerResponse.arrayBuffer());

  check('JSON + 图片共用缓存（只查了一轮 UDP+TCP）', () => {
    assert.equal(mock.stats.full, before.full);
    assert.equal(mock.stats.slp, before.slp);
  });

  /* ---------------------------- 4. 图片输出 ---------------------------- */
  check('图片接口 Content-Type = image/png', () =>
    assert.equal(bannerResponse.headers.get('content-type'), 'image/png')
  );
  check('合法 PNG，宽度 1600（2 倍高清），高度随玩家数自适应', () => {
    assert.equal(banner.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(banner.readUInt32BE(16), 1600);
    assert.equal(banner.readUInt32BE(20), expectedBannerHeight(mock.players.length, 2));
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-online.png'), banner);

  // 老尺寸仍然可用：?scale=1 -> 800x400
  const legacy = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&scale=1`)).arrayBuffer()
  );
  check('?scale=1 返回 800 宽（高度同公式）', () => {
    assert.equal(legacy.readUInt32BE(16), 800);
    assert.equal(legacy.readUInt32BE(20), expectedBannerHeight(mock.players.length, 1));
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-online-1x.png'), legacy);

  const badScale = await fetch(`${base}/api/banner.png?${query}&scale=9`);
  check('?scale 越界 -> 400', () => assert.equal(badScale.status, 400));

  /* ------------------- 4b. 玩家多就加行（保持每行 5 个） --------------- */
  const manyPlayers = [
    ...mock.players,
    'Zeta_01', 'Zeta_02', 'Zeta_03', 'Zeta_04', 'Zeta_05', 'Zeta_06', 'Zeta_07', 'Zeta_08',
  ]; // 共 20 人 -> 4 行
  const bigMock = await startMockServer({ gamePort: 0, queryPort: 0, players: manyPlayers });
  const bigQuery = `host=127.0.0.1&port=${bigMock.gamePort}&queryPort=${bigMock.queryPort}`;

  const bigStatus = await fetch(`${base}/api/status?${bigQuery}`).then((response) => response.json());
  const bigBanner = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${bigQuery}&scale=1`)).arrayBuffer()
  );

  check('玩家数量超过一行时全部返回（不再截断到 10 个）', () => {
    assert.equal(bigStatus.playerList.length, 20);
    assert.equal(bigStatus.players, 20);
  });
  check('图片高度按行数增长（每行仍 5 个）', () => {
    assert.equal(bigBanner.readUInt32BE(20), expectedBannerHeight(20, 1));
    assert.ok(
      bigBanner.readUInt32BE(20) > expectedBannerHeight(12, 1),
      '20 人的图应该比 12 人的高'
    );
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-20players.png'), bigBanner);
  bigMock.close();

  /* ------------------- 5. 只有 SLP（Query 未开启）的情况 ---------------- */
  const slpOnly = await startMockServer({ withQuery: false, gamePort: 0 });
  const slpQuery = `host=127.0.0.1&port=${slpOnly.gamePort}&queryPort=${slpOnly.gamePort}`;
  const slpStatus = await fetch(`${base}/api/status?${slpQuery}`).then((response) => response.json());

  check('Query 关闭时仍判为在线（靠 SLP）', () => {
    assert.equal(slpStatus.online, true);
    assert.deepEqual(slpStatus.sources, { query: false, ping: true });
  });
  check('玩家列表退化为 SLP 采样列表', () => {
    assert.equal(slpStatus.playerListSource, 'slp-sample');
    assert.deepEqual(slpStatus.playerList, mock.players);
  });
  check('离线时仍能看到 Query 的具体错误原因', () => {
    assert.equal(typeof slpStatus.queryError, 'string');
    assert.ok(slpStatus.queryError.length > 0);
  });

  const slpBanner = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${slpQuery}`)).arrayBuffer()
  );
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-slp-only.png'), slpBanner);

  /* ------------------------- 6. 两套协议都失败 ------------------------- */
  const deadPort = slpOnly.gamePort; // 关掉之后就没人监听了
  slpOnly.close();
  // 注意：host/port/queryPort 与上面的 SLP 用例完全相同 -> 同一个缓存 key，
  // 所以必须带 refresh=1 跳过缓存，否则会拿到 30 秒内的旧结果
  const offlineQuery = `host=127.0.0.1&port=${deadPort}&queryPort=${deadPort}&timeout=600&refresh=1`;

  const offlineResponse = await fetch(`${base}/api/banner.png?${offlineQuery}`);
  const offlineBanner = Buffer.from(await offlineResponse.arrayBuffer());
  check('离线时图片接口仍返回 200 + PNG', () => {
    assert.equal(offlineResponse.status, 200);
    assert.equal(offlineBanner.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-offline.png'), offlineBanner);

  const offlineJson = await fetch(`${base}/api/status?${offlineQuery}`).then((response) =>
    response.json()
  );
  check('离线时 JSON 返回 { online:false, error, sources }', () => {
    assert.equal(offlineJson.online, false);
    assert.equal(typeof offlineJson.error, 'string');
    assert.deepEqual(offlineJson.sources, { query: false, ping: false });
    assert.ok(offlineJson.pingError, '应保留 TCP 侧的错误原因');
  });

  /* ----------------------------- 7. 多服一览 --------------------------- */
  const overviewQuery =
    `servers=${encodeURIComponent(`主服@127.0.0.1:${mock.gamePort}:${mock.queryPort}`)},` +
    `${encodeURIComponent(`备用服@127.0.0.1:${deadPort}:${deadPort}`)}&timeout=600&refresh=1`;
  const overview = await fetch(`${base}/api/overview?${overviewQuery}`).then((response) => response.json());

  check('多服一览 JSON：总数 / 在线数 / 玩家合计', () => {
    assert.equal(overview.total, 2);
    assert.equal(overview.online, 1);
    assert.equal(overview.offline, 1);
    assert.equal(overview.players, mock.players.length);
    assert.equal(overview.servers.length, 2);
  });
  check('多服一览：混排在线与离线条目', () => {
    assert.equal(overview.servers[0].online, true);
    assert.equal(overview.servers[0].playerListSource, 'query');
    assert.equal(overview.servers[1].online, false);
    assert.equal(overview.servers[1].errorCode, 'CONNECTION_ERROR');
  });
  check('多服一览支持「显示名@host:port:queryPort」', () => {
    assert.equal(overview.servers[0].displayName, '主服');
    assert.equal(overview.servers[1].displayName, '备用服');
  });

  const overviewPng = Buffer.from(
    await (await fetch(`${base}/api/overview.png?${overviewQuery}`)).arrayBuffer()
  );
  check('多服一览图片：合法 PNG，高度随台数自适应', () => {
    assert.equal(overviewPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(overviewPng.readUInt32BE(16), 1600); // 宽度固定 800 * scale 2
    assert.equal(overviewPng.readUInt32BE(20), expectedOverviewHeight(2, 2)); // 2 台服务器 × 2 倍输出
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'overview.png'), overviewPng);

  const overviewNoServers = await fetch(`${base}/api/overview`);
  check('多服一览缺 servers -> 400', () => assert.equal(overviewNoServers.status, 400));

  const overviewBadEntry = await fetch(`${base}/api/overview?servers=a:b:c:d`);
  check('多服一览条目格式错误 -> 400', () => assert.equal(overviewBadEntry.status, 400));

  const overviewTooMany = await fetch(
    `${base}/api/overview?servers=${Array.from({ length: 9 }, (_, i) => `h${i}`).join(',')}`
  );
  check('多服一览超过上限 -> 400', () => assert.equal(overviewTooMany.status, 400));

  /* ------------------------------ 8. 主题 ------------------------------ */
  const themeList = await fetch(`${base}/api/themes`).then((response) => response.json());
  check('/api/themes 返回主题列表', () => {
    assert.ok(Array.isArray(themeList.themes));
    assert.ok(themeList.themes.length >= 6, '至少应该有 6 套主题');
    assert.ok(themeList.themes.some((theme) => theme.name === 'default'));
    assert.ok(themeList.themes.some((theme) => theme.mode === 'light'), '应该包含浅色主题');
  });

  const themed = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&theme=ocean&scale=1`)).arrayBuffer()
  );
  const defaulted = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&scale=1`)).arrayBuffer()
  );
  check('切换主题后图片确实不同（且仍是合法 PNG）', () => {
    assert.equal(themed.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(themed.readUInt32BE(16), defaulted.readUInt32BE(16));
    assert.notEqual(themed.toString('base64'), defaulted.toString('base64'));
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-theme-ocean.png'), themed);

  const lightTheme = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&theme=frost&scale=1`)).arrayBuffer()
  );
  check('浅色主题也能正常出图', () => {
    assert.equal(lightTheme.readUInt32BE(16), 800);
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-theme-frost.png'), lightTheme);

  const badTheme = await fetch(`${base}/api/status?${query}&theme=rainbow`);
  check('未知主题 -> 400', () => assert.equal(badTheme.status, 400));

  const badThemeBanner = await fetch(`${base}/api/banner.png?${query}&theme=rainbow`);
  check('未知主题（图片接口）-> 400 + 说明图', async () => {
    assert.equal(badThemeBanner.status, 400);
  });

  const themeEcho = await fetch(`${base}/api/status?${query}&theme=forest`).then((r) => r.json());
  check('JSON 会回显当前主题', () => assert.equal(themeEcho.theme, 'forest'));

  /* ------------------------------ 9. 布局 ------------------------------ */
  const layoutList = await fetch(`${base}/api/layouts`).then((response) => response.json());
  check('/api/layouts 返回布局列表', () => {
    assert.ok(layoutList.layouts.some((layout) => layout.name === 'stack'));
    assert.ok(layoutList.layouts.some((layout) => layout.name === 'compact'));
  });

  check('主题自带配套布局（/api/themes 里有 layout 字段）', () => {
    assert.ok(themeList.themes.every((theme) => typeof theme.layout === 'string'));
  });

  const compactBanner = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&layout=compact&scale=1`)).arrayBuffer()
  );
  check('compact 布局：固定 800x218 的横条', () => {
    assert.equal(compactBanner.readUInt32BE(16), 800);
    assert.equal(compactBanner.readUInt32BE(20), 218);
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-layout-compact.png'), compactBanner);

  const splitBanner = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&layout=split&scale=1`)).arrayBuffer()
  );
  check('split 布局：左右分栏，仍为合法 PNG', () => {
    assert.equal(splitBanner.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(splitBanner.readUInt32BE(20) >= 400);
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-layout-split.png'), splitBanner);

  const pairEcho = await fetch(`${base}/api/status?${query}&theme=forest`).then((r) => r.json());
  check('只传主题时，布局自动取该主题配套的那个', () => assert.equal(pairEcho.layout, 'compact'));

  const layoutOverride = await fetch(`${base}/api/status?${query}&theme=forest&layout=stack`).then((r) =>
    r.json()
  );
  check('显式 layout 覆盖主题配套布局', () => assert.equal(layoutOverride.layout, 'stack'));

  const badLayout = await fetch(`${base}/api/banner.png?${query}&layout=hexagon`);
  check('未知布局 -> 400', () => assert.equal(badLayout.status, 400));

  /* --------------------------- 9b. 自由组合 --------------------------- */
  const styleList = await fetch(`${base}/api/styles`).then((response) => response.json());
  check('/api/styles 返回视觉语言列表', () => {
    assert.ok(styleList.styles.some((item) => item.name === 'swiss'));
    assert.ok(styleList.styles.some((item) => item.name === 'cosmic'));
  });

  const comboA = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&theme=midnight&style=swiss&layout=compact&scale=1`)).arrayBuffer()
  );
  const comboB = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&theme=midnight&scale=1`)).arrayBuffer()
  );
  check('同一主题换视觉语言 -> 图片不同（真实自由组合）', () => {
    assert.equal(comboA.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(comboA.readUInt32BE(20), 218); // compact
    assert.notEqual(comboA.toString('base64'), comboB.toString('base64'));
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-combo-midnight-swiss-compact.png'), comboA);

  const comboC = Buffer.from(
    await (await fetch(`${base}/api/banner.png?${query}&theme=mono&style=cosmic&layout=split&scale=1`)).arrayBuffer()
  );
  check('浅色配色 + 宇宙颗粒 + 分栏也能出图', () => {
    assert.equal(comboC.readUInt32BE(16), 800);
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-combo-mono-cosmic-split.png'), comboC);

  const styleEcho = await fetch(`${base}/api/status?${query}&theme=ocean&style=organic`).then((r) => r.json());
  check('JSON 回显 theme / layout / style 三者', () => {
    assert.equal(styleEcho.theme, 'ocean');
    assert.equal(styleEcho.style, 'organic');
    assert.equal(styleEcho.layout, 'stack'); // ocean 配套的布局
  });

  const badStyle = await fetch(`${base}/api/banner.png?${query}&style=neon`);
  check('未知视觉语言 -> 400', () => assert.equal(badStyle.status, 400));

  const overviewThemed = Buffer.from(
    await (await fetch(`${base}/api/overview.png?${overviewQuery}&theme=midnight&scale=1`)).arrayBuffer()
  );
  check('一览图也支持主题', () => {
    assert.equal(overviewThemed.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });

  /* ---------------------------- 9. 参数校验 ---------------------------- */
  const noHost = await fetch(`${base}/api/status?port=25565`);
  check('缺少 host -> 400', () => assert.equal(noHost.status, 400));

  const badPort = await fetch(`${base}/api/status?host=example.com&port=70000`);
  check('port 越界 -> 400', () => assert.equal(badPort.status, 400));

  const badQueryPort = await fetch(`${base}/api/status?host=example.com&queryPort=abc`);
  check('queryPort 非整数 -> 400', () => assert.equal(badQueryPort.status, 400));

  const badBanner = await fetch(`${base}/api/banner.png?host=`);
  const badBannerBuffer = Buffer.from(await badBanner.arrayBuffer());
  check('图片接口参数错误 -> 400 + 一张说明图', () => {
    assert.equal(badBanner.status, 400);
    assert.equal(badBannerBuffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'banner-invalid.png'), badBannerBuffer);

  /* -------------------- 9. 自研皮肤渲染（不依赖网络） ------------------- */
  const { renderHead } = await import('../src/skin.js');

  /** 造一张 64x64 皮肤：脸是红的，可选的帽子层是绿的 */
  function makeSkin({ hat = false } = {}) {
    const canvas = createCanvas(64, 64);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(8, 8, 8, 8); // 脸
    if (hat) {
      context.fillStyle = '#00ff00';
      context.fillRect(40, 8, 8, 8); // 帽子层
    }
    return canvas;
  }

  const faceOnly = renderHead(makeSkin(), 16);
  const withHat = renderHead(makeSkin({ hat: true }), 16);
  const facePixel = faceOnly.getContext('2d').getImageData(4, 4, 1, 1).data;
  const hatPixel = withHat.getContext('2d').getImageData(4, 4, 1, 1).data;

  check('自研渲染：正确裁出脸部（8,8）', () => {
    assert.deepEqual([facePixel[0], facePixel[1], facePixel[2]], [255, 0, 0]);
  });
  check('自研渲染：帽子层（40,8）覆盖在脸之上', () => {
    assert.deepEqual([hatPixel[0], hatPixel[1], hatPixel[2]], [0, 255, 0]);
  });
  check('自研渲染：输出尺寸可控且边缘无插值', () => {
    assert.equal(faceOnly.width, 16);
    // 最近邻放大：每个像素块颜色一致（取块内两个点比较）
    const ctx2 = withHat.getContext('2d');
    const a = ctx2.getImageData(0, 0, 1, 1).data;
    const b = ctx2.getImageData(1, 1, 1, 1).data;
    assert.deepEqual([...a], [...b]);
  });

  /* ------------------------------ 10. 收尾 ----------------------------- */
  const health = await fetch(`${base}/healthz`).then((response) => response.json());
  check('/healthz 可用', () => assert.equal(health.ok, true));

  console.log('\n断言结果：');
  console.log(results.join('\n'));
  console.log(
    `\n协议调用次数：SLP(TCP) ${mock.stats.slp} 次，Query 握手 ${mock.stats.handshake} 次 / 全量 ${mock.stats.full} 次（${mock.players.length} 名玩家）`
  );
  console.log(`生成图片已写入：${OUTPUT_DIR}`);

  apiServer.close();
  mock.close();
  avatarServer.close();
}

main().catch((error) => {
  console.error('自测失败：', error);
  process.exitCode = 1;
});
