/**
 * src/skin.js
 * ---------------------------------------------------------------------------
 * 自己获取皮肤并渲染头像，不再依赖第三方的头像服务。
 *
 * 链路（全部是 Mojang 官方接口）：
 *   1) 名字 -> UUID      https://api.mojang.com/users/profiles/minecraft/<name>
 *                        查不到返回 404 —— 这就是「离线服 / 非正版账号」的判定依据
 *   2) UUID -> profile   https://sessionserver.mojang.com/session/minecraft/profile/<uuid>
 *                        properties[0].value 是 base64 的 JSON，里面有皮肤地址
 *   3) 下载皮肤          http://textures.minecraft.net/texture/<hash>（强制走 https）
 *   4) 渲染头像          从 64x64 皮肤里裁「脸(8,8)」+「帽子层(40,8)」，
 *                        用最近邻放大 —— Minecraft 皮肤是像素画，保持硬边才好看
 *
 * 皮肤文件本身只有几百字节到几 KB，比拉一张现成头像图更轻，而且完全自主可控：
 * 不经过任何第三方，头像的裁剪 / 缩放 / 圆角都由我们自己决定。
 * ---------------------------------------------------------------------------
 */

import { createCanvas, loadImage } from 'canvas';

const PROFILE_API = 'https://api.mojang.com/users/profiles/minecraft';
const SESSION_API = 'https://sessionserver.mojang.com/session/minecraft/profile';

/** 单次网络请求超时 */
const REQUEST_TIMEOUT_MS = 3500;
/** 名字 -> UUID：基本不变，缓存久一点 */
const UUID_TTL_MS = 60 * 60 * 1000;
/** 皮肤：玩家可能换皮肤，缓存短一点 */
const SKIN_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

/** 皮肤里各部位在 64x64 贴图中的位置（legacy 64x32 同样适用） */
const FACE_BOX = { x: 8, y: 8, size: 8 };
const HAT_BOX = { x: 40, y: 8, size: 8 };

/** @type {Map<string, { uuid: string|null, expiresAt: number }>} */
const uuidCache = new Map();
/** @type {Map<string, { image: object|null, expiresAt: number }>} */
const skinCache = new Map();

/* ------------------------------ 网络 ------------------------------------ */

/** 带超时的 fetch，返回 Buffer（失败返回 null） */
async function fetchBuffer(url, { accept = 'application/json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'mcstatus-api/1.0', accept },
    });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- 名字 -> UUID ------------------------------- */

/**
 * 解析玩家 UUID。
 * @returns {{ uuid: string } | { notFound: true } | null} null 表示网络错误（可换下一个数据源）
 */
export async function resolveUuid(playerName) {
  const key = String(playerName).toLowerCase();
  const cached = uuidCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.uuid ? { uuid: cached.uuid } : { notFound: true };
  }

  const response = await fetchBuffer(`${PROFILE_API}/${encodeURIComponent(playerName)}`);
  if (!response) return null; // 网络问题，交给上层换数据源

  if (response.status === 404 || response.status === 204) {
    // Mojang 明确表示没有这个账号 -> 不会再有皮肤了
    uuidCache.set(key, { uuid: null, expiresAt: Date.now() + UUID_TTL_MS });
    return { notFound: true };
  }
  if (!response.ok) return null;

  try {
    const data = await response.json();
    if (!data || typeof data.id !== 'string') return null;
    if (uuidCache.size >= MAX_CACHE_ENTRIES) uuidCache.clear();
    uuidCache.set(key, { uuid: data.id, expiresAt: Date.now() + UUID_TTL_MS });
    return { uuid: data.id };
  } catch {
    return null;
  }
}

/* ---------------------------- UUID -> 皮肤 ------------------------------- */

/** 从 profile 响应里取出皮肤贴图地址 */
function extractSkinUrl(profile) {
  const encoded = profile?.properties?.find((entry) => entry?.name === 'textures')?.value;
  if (typeof encoded !== 'string') return null;

  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const url = decoded?.textures?.SKIN?.url;
    if (typeof url !== 'string') return null;
    // Mojang 给的是 http，改成 https 免得被中间设备拦
    return url.replace(/^http:\/\//i, 'https://');
  } catch {
    return null;
  }
}

/**
 * 取玩家皮肤贴图（已解码的 Image）。
 * @returns {{ image: object } | { notFound: true } | null}
 */
export async function fetchSkinImage(playerName) {
  const resolved = await resolveUuid(playerName);
  if (!resolved) return null;
  if (resolved.notFound) return { notFound: true };

  const cached = skinCache.get(resolved.uuid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.image ? { image: cached.image } : null;
  }

  const profileResponse = await fetchBuffer(`${SESSION_API}/${resolved.uuid}`);
  if (!profileResponse || !profileResponse.ok) return null;

  let skinUrl = null;
  try {
    skinUrl = extractSkinUrl(await profileResponse.json());
  } catch {
    return null;
  }
  if (!skinUrl) return null;

  const skinResponse = await fetchBuffer(skinUrl, { accept: 'image/png' });
  if (!skinResponse || !skinResponse.ok) return null;

  try {
    const image = await loadImage(Buffer.from(await skinResponse.arrayBuffer()));
    if (skinCache.size >= MAX_CACHE_ENTRIES) skinCache.clear();
    skinCache.set(resolved.uuid, { image, expiresAt: Date.now() + SKIN_TTL_MS });
    return { image };
  } catch {
    return null;
  }
}


/* ---------------------------- 3D 头部渲染 -------------------------------- */

/** 头部立方体用到的三个面在贴图里的位置（基础层 / 帽子层，64x32 与 64x64 通用） */
const HEAD_FACES = {
  top: { base: [8, 0], hat: [40, 0] },
  right: { base: [0, 8], hat: [32, 8] },
  front: { base: [8, 8], hat: [40, 8] },
};

/**
 * 把一个面（8x8 贴图区域）按仿射矩阵画到目标位置。
 * 矩阵把「单位正方形的三个角」映射到平行四边形的三个角上。
 */
function drawFace(ctx, skinImage, source, size, matrix, shade = 0) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  ctx.drawImage(skinImage, source[0], source[1], 8, 8, 0, 0, size, size);
  if (shade > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${shade})`;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.restore();
}

/** 画一个「头立方体」：正面 + 顶面 + 右侧面（顶面/侧面带一点明暗，做出体积感） */
function drawHeadCube(ctx, skinImage, { left, frontTop, size, depth, layer, shading }) {
  const dx = size * depth;
  const dy = size * depth;

  // 顶面：从正面上边往右上方拉出深度
  drawFace(
    ctx,
    skinImage,
    HEAD_FACES.top[layer],
    size,
    [1, 0, dx / size, -dy / size, left, frontTop],
    shading ? 0.08 : 0
  );

  // 右侧面：从正面右边往右上方拉出深度
  drawFace(
    ctx,
    skinImage,
    HEAD_FACES.right[layer],
    size,
    [dx / size, -dy / size, 0, 1, left + size, frontTop],
    shading ? 0.18 : 0
  );

  // 正面
  drawFace(ctx, skinImage, HEAD_FACES.front[layer], size, [1, 0, 0, 1, left, frontTop], 0);
}

/**
 * 把皮肤渲染成**带透明背景的 3D 头像**（类似各大皮肤站的头像效果）：
 *   - 透视方向：右上方（能看到正面 + 顶面 + 右侧面）
 *   - 帽子层按原版规则略微外扩（inflate），所以轮廓会带一点起伏
 *   - 背景完全透明，不再是「一块方形皮肤」
 *
 * @param {object} skinImage 皮肤贴图
 * @param {number} boxSize   输出边长（头像会等比放进这个正方形）
 * @param {object} [options]
 * @param {number} [options.depth]   深度比例（0.2~0.6，默认 0.42）
 * @param {number} [options.inflate] 帽子层外扩比例（默认 1.08）
 * @param {boolean} [options.shading] 是否加明暗，默认 true
 */
export function renderHead3D(skinImage, boxSize, { depth = 0.42, inflate = 1.08, shading = true } = {}) {
  const canvas = createCanvas(boxSize, boxSize);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // 基础层立方体：正面边长 S，整体占 (S + dx) x (S + dy)
  const baseSize = boxSize / (1 + depth);
  const baseDx = baseSize * depth;
  const baseDy = baseSize * depth;
  const baseLeft = (boxSize - (baseSize + baseDx)) / 2;
  const baseTop = (boxSize - (baseSize + baseDy)) / 2;

  // 1) 基础层
  drawHeadCube(ctx, skinImage, {
    left: baseLeft,
    frontTop: baseTop + baseDy,
    size: baseSize,
    depth,
    layer: 'base',
    shading,
  });

  // 2) 帽子层：以同一个中心略微放大后叠在上面（原版就是这么做的）
  //    只有 64x64 皮肤才有帽子层 —— legacy 皮肤叠上去会糊成黑块
  if (inflate !== 1 && hasHatLayer(skinImage)) {
    const hatSize = baseSize * inflate;
    const hatDx = hatSize * depth;
    const hatDy = hatSize * depth;
    const centerX = baseLeft + (baseSize + baseDx) / 2;
    const centerY = baseTop + (baseSize + baseDy) / 2;
    const hatLeft = centerX - (hatSize + hatDx) / 2;
    const hatTop = centerY - (hatSize + hatDy) / 2;

    drawHeadCube(ctx, skinImage, {
      left: hatLeft,
      frontTop: hatTop + hatDy,
      size: hatSize,
      depth,
      layer: 'hat',
      shading,
    });
  }

  return canvas;
}


/* ------------------------- minimal 风格（对齐 mccag） ---------------------- */

/**
 * 复刻 mccag 的 `minimal` 头像构图（参数取自它的 Scripts/Data.js）：
 *
 *   画布 1000x1000，透明底
 *   脸   ：贴图 (8,8,8,8)，放大到 600，贴在 (200,200)
 *   帽子层：贴图 (40,8,8,8)，放大到 656，贴在 (175,175)   ← 比脸大 9.3%，轮廓因此有起伏
 *   投影 ：rgba(0,0,0,0.2) / blur 15 / 无偏移（shadow 参数控制）
 *
 * 与 mccag 的区别（有意为之）：legacy 64x32 皮肤**不叠帽子层**。
 * 那种皮肤在 (40,8) 一带不是帽子层，mccag 会直接糊成黑块（拿 Notch 测就能复现）。
 */
const MINIMAL_LAYOUT = {
  face: { x: 200, y: 200, size: 600 },
  hat: { x: 175, y: 175, size: 656 },
  shadow: { color: 'rgba(0, 0, 0, 0.2)', blur: 15 },
};

/**
 * 渲染 minimal 风格头像：头会自动缩放填满整个方框（原版四周的留白裁掉）。
 *
 * @param {object} skinImage 皮肤贴图
 * @param {number} boxSize   输出边长
 * @param {object} [options]
 * @param {boolean} [options.shadow] 是否画柔和投影（默认 true）
 * @param {number}  [options.fill]   内容占方框的比例（默认 0.96，留一点边给投影）
 */
export function renderHeadMinimal(skinImage, boxSize, { shadow = true, fill = 0.96 } = {}) {
  const canvas = createCanvas(boxSize, boxSize);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const hasHat = hasHatLayer(skinImage);
  // 有帽子层时以「帽子层」为内容边界（它最大），否则就用脸
  const content = hasHat ? MINIMAL_LAYOUT.hat : MINIMAL_LAYOUT.face;
  const scale = (boxSize * fill) / content.size;
  const offset = (boxSize * (1 - fill)) / 2;

  const parts = hasHat ? [MINIMAL_LAYOUT.face, MINIMAL_LAYOUT.hat] : [MINIMAL_LAYOUT.face];

  for (const part of parts) {
    const x = offset + (part.x - content.x) * scale;
    const y = offset + (part.y - content.y) * scale;
    const size = part.size * scale;
    const source = part === MINIMAL_LAYOUT.face ? FACE_BOX : HAT_BOX;

    ctx.save();
    if (shadow) {
      ctx.shadowColor = MINIMAL_LAYOUT.shadow.color;
      ctx.shadowBlur = MINIMAL_LAYOUT.shadow.blur * scale;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(skinImage, source.x, source.y, source.size, source.size, x, y, size, size);
    ctx.restore();
  }

  return canvas;
}

/* ------------------------------ 渲染头像 --------------------------------- */

/**
 * 把皮肤渲染成头像：脸 + 帽子层（第二层），最近邻放大。
 *
 * @param {object} skinImage 64x64（或 legacy 64x32）的皮肤图
 * @param {number} size      输出尺寸（像素）
 * @returns {object} node-canvas 的 Canvas，可直接被 drawImage 使用
 */
/** 是否带帽子层（第二层）：只有现代 64x64 皮肤才有 */
export function hasHatLayer(skinImage) {
  return Boolean(skinImage) && skinImage.height >= 64;
}

export function renderHead(skinImage, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false; // 像素画：放大不要插值

  // 脸
  ctx.drawImage(skinImage, FACE_BOX.x, FACE_BOX.y, FACE_BOX.size, FACE_BOX.size, 0, 0, size, size);

  // 帽子层：**只有 64x64 皮肤才有**。
  // legacy 64x32 皮肤在 (40,8) 那一带往往是老的胳膊/腿部贴图甚至纯黑像素，
  // 无条件叠上去会把整张脸糊成黑色方块。
  if (hasHatLayer(skinImage)) {
    ctx.drawImage(skinImage, HAT_BOX.x, HAT_BOX.y, HAT_BOX.size, HAT_BOX.size, 0, 0, size, size);
  }

  return canvas;
}

/** 缓存概况（调试用） */
export function skinStats() {
  return { uuids: uuidCache.size, skins: skinCache.size };
}

export { FACE_BOX, HAT_BOX };
