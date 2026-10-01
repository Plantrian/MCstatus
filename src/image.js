/**
 * src/image.js
 * ---------------------------------------------------------------------------
 * 用 node-canvas 画 800x400 的状态图。视觉语言参考 Apple 的设计语言：
 *
 *   - 材质与层次：内容放在一块「半透明材质」卡片里（淡填充 + 顶部亮边 + 柔和投影），
 *     背景以服务器图标的平均色做一层极淡的环境光晕，让画面与内容自然关联
 *   - 排版：字距随字号变化（大字号收紧、小字号放宽），层级由「字号 + 字重 + 行距」
 *     共同建立，而不是只堆字号；字号用 system-ui 一类无衬线
 *   - 分隔：不用生硬的一条线，改用两端淡出的软分隔
 *   - 克制：只在少数地方用颜色（状态点 / 延迟 / 环境色），其余交给灰阶层级
 *
 * 字体：assets/fonts 下放了一套 HarmonyOS Sans SC（6 个字重，中英文全覆盖，
 * 实测 cmap 中文 27/27、拉丁 10/10），层级直接靠字重表达（Thin/Light/Regular/Medium/Bold/Black）。
 * 字体栈为 "HarmonyOS Sans X", "MCBannerCJK", sans-serif：
 * 前两个若都缺少某字形，仍会由系统 CJK 字体兜底（Pango 逐字形回退），不会出现方框。
 *
 * 清晰度：内部按 2x 超采样栅格化（圆角、文字、描边都在双倍分辨率下画），
 * 再降采样到 800x400 —— 等效于 SSAA，边缘和字形明显更干净。
 * 想要更高清的输出可以用 ?scale=2 直接拿 1600x800。
 *
 * 另外这里修掉了几个已知问题：
 *   1. emoji 不能靠字体回退：NotoColorEmoji 会把 ASCII 数字当键帽 emoji 渲染，
 *      实测 "25575" 宽度从 44.1px 变 99.6px，字距被撑开。
 *      现在按「绘制单元」分别设置字体：emoji 段用 emoji 字体，其余用主字体。
 *   2. emoji 字体必须先自检再用：彩色 emoji（NotoColorEmoji）是 CBDT 位图字体，
 *      部分 cairo/FreeType 组合根本栅格化不出来 —— 画出来是空白或豆腐块，表现就是「emoji 显示不正常」。
 *      所以候选字体逐个试画，真能画出来的才采用（彩色不合格就退到 Symbola / Noto Emoji 这类单色字体）。
 *   3. 没有可用字体时不再画方框：U+1F000 以上的 emoji 整段丢掉；
 *      ☀ ⚡ ✨ ⭐ ✅ 这类 BMP 符号交回主字体栈（DejaVu 等）回退，不会白白丢掉。
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, registerFont } from 'canvas';
import { fetchSkinImage, renderHead, renderHead3D, renderHeadMinimal } from './skin.js';

/** 项目自带字体目录（可用 BANNER_FONT_DIR 覆盖） */
const UI_FONT_DIR =
  process.env.BANNER_FONT_DIR ?? fileURLToPath(new URL('../assets/fonts/', import.meta.url));

/**
 * 字重 → 字体文件。HarmonyOS Sans 每个字重是独立文件，
 * 而 node-canvas 的 registerFont 只能按「字体族」注册，所以这里把每个字重
 * 注册成独立族名，再用族名切换字重。
 */
const UI_FONTS = {
  // files 按优先级排列：SC 版（含中文，约 8MB/个）优先，退回纯拉丁子集（约 145KB）
  thin: { files: ['HarmonyOS_Sans_SC_Thin.ttf', 'HarmonyOS_Sans_Thin.ttf'], family: 'HarmonyOS Sans Thin' },
  light: { files: ['HarmonyOS_Sans_SC_Light.ttf', 'HarmonyOS_Sans_Light.ttf'], family: 'HarmonyOS Sans Light' },
  normal: {
    files: ['HarmonyOS_Sans_SC_Regular.ttf', 'HarmonyOS_Sans_Regular.ttf'],
    family: 'HarmonyOS Sans Regular',
  },
  medium: {
    files: ['HarmonyOS_Sans_SC_Medium.ttf', 'HarmonyOS_Sans_Medium.ttf'],
    family: 'HarmonyOS Sans Medium',
  },
  bold: { files: ['HarmonyOS_Sans_SC_Bold.ttf', 'HarmonyOS_Sans_Bold.ttf'], family: 'HarmonyOS Sans Bold' },
  black: { files: ['HarmonyOS_Sans_SC_Black.ttf', 'HarmonyOS_Sans_Black.ttf'], family: 'HarmonyOS Sans Black' },
};

/** 某个字重缺失时的降级顺序 */
const WEIGHT_FALLBACK = {
  thin: ['thin', 'light', 'normal'],
  light: ['light', 'normal'],
  normal: ['normal', 'medium', 'bold'],
  medium: ['medium', 'normal', 'bold'],
  bold: ['bold', 'medium', 'black', 'normal'],
  black: ['black', 'bold', 'medium', 'normal'],
};

/* -------------------------------- 尺寸 ---------------------------------- */

export const BANNER_WIDTH = 800;
export const BANNER_HEIGHT = 400;

/** 内部超采样倍数（BANNER_SUPERSAMPLE 可调，1 关闭） */
const SUPERSAMPLE = Math.min(Math.max(Number(process.env.BANNER_SUPERSAMPLE ?? 2) || 1, 1), 4);
/** 允许的最大输出倍数（?scale=） */
export const MAX_OUTPUT_SCALE = 3;
/**
 * 默认输出倍数（1 = 800x400，2 = 1600x800，默认 2）。
 * 800x400 在 HiDPI 屏或聊天窗里被放大显示时一定会发虚，所以默认直接出 1600x800；
 * 需要老尺寸时用 ?scale=1，或用 BANNER_DEFAULT_SCALE 固定默认值。
 */
const DEFAULT_OUTPUT_SCALE = Math.min(
  Math.max(Number(process.env.BANNER_DEFAULT_SCALE ?? 2) || 2, 1),
  MAX_OUTPUT_SCALE
);

const CARD = { x: 24, y: 24, width: BANNER_WIDTH - 48, height: 336, radius: 28 };
const INSET = 28; // 卡片内边距

/** 每行显示几个玩家（保持不变，玩家多就加行） */
const CHIPS_PER_ROW = 5;
/** 每行占位高度（头像 + 6 行距） */
const CHIP_ROW_HEIGHT = 34;
/** 头像槽位：3D 头要装下顶面+侧面，所以比纯正面时给得大一些 */
const CHIP_AVATAR = 28;
const CONTENT_X = CARD.x + INSET; // 52
const CONTENT_RIGHT = CARD.x + CARD.width - INSET; // 748
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_X; // 696

/** 统一的纵向节奏（一次定义，改版式只改这里） */
const RHYTHM = {
  iconSize: 56,
  iconY: 48,
  addressBaseline: 76,
  sublineBaseline: 98,
  statusBaseline: 152,
  dividerTop: 178,
  motdBaseline: 206,
  motdLineHeight: 25,
  dividerBottom: 254,
  captionBaseline: 276,
  chipRowTop: 284,
  chipRowHeight: CHIP_ROW_HEIGHT,
  footerBaseline: BANNER_HEIGHT - 16,
};

/**
 * 最多渲染多少个玩家头像（安全上限，避免超大服把图撑得过长）。
 * 默认 100，可用 BANNER_MAX_PLAYERS 调整；超过上限时显示「显示 x / y 人」。
 */
const MAX_PLAYERS_RENDERED = Math.max(5, Number(process.env.BANNER_MAX_PLAYERS ?? 100) || 100);
/** 头像分批拉取大小，避免一次打出去太多请求（Mojang 有速率限制） */
const AVATAR_BATCH_SIZE = 10;
const AVATAR_TIMEOUT_MS = 3500;
const AVATAR_CACHE_TTL_MS = 5 * 60 * 1000;
const AVATAR_CACHE_MAX = 300;
/** 探针结果的缓存时长（mc-heads 的默认头像不会频繁变） */
const DEFAULT_HEAD_PROBE_TTL_MS = 60 * 60 * 1000;

/**
 * 玩家没有皮肤时怎么画：
 *   letter（默认）—— 用我们自己的字母头像（按名字取色，每个玩家都不一样）
 *   plain         —— 直接显示头像源返回的默认头像（mc-heads 会给一张默认脸，多人会重复）
 */
const AVATAR_FALLBACK = (process.env.BANNER_AVATAR_FALLBACK || 'letter').toLowerCase();

/**
 * 头像数据源链，从左到右依次尝试，第一个成功的就用：
 *   mojang   自己从 Mojang 取皮肤 + canvas 渲染（默认，无第三方依赖）
 *   mccag    本机 mccag 头像服务（BANNER_MCCAG_BASE，渲染带立体感）
 *   mc-heads 第三方头像服务（兜底；同时用于识别「默认脸」）
 * 用 BANNER_AVATAR_PROVIDERS=mojang 可以只用自研那条。
 */
const AVATAR_PROVIDERS = (process.env.BANNER_AVATAR_PROVIDERS || 'mojang,mccag,mc-heads')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => name.length > 0);

/**
 * 头像渲染风格（BANNER_AVATAR_STYLE）：
 *   minimal（默认）—— 对齐 mccag 的 minimal：平面脸 + 比脸大 9.3% 的帽子层 + 柔和投影，透明底
 *   3d              —— 带透明背景的立体头（正面 + 顶面 + 右侧面）
 *   flat            —— 最朴素的平面方形头像（脸 + 同尺寸帽子层，铺满图片）
 */
const AVATAR_STYLE = (process.env.BANNER_AVATAR_STYLE || 'minimal').toLowerCase();

/** mccag 服务地址（本机的话就是隔壁 3000 端口那个） */
const MCCAG_BASE = (process.env.BANNER_MCCAG_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');

/**
 * 当前渲染倍率。头像按「设备像素」渲染（2x 输出就渲染 2 倍大），
 * 这样画上去是 1:1，不会因为缩放把像素画糊掉。
 */
let activeRenderScale = SUPERSAMPLE;

/* ------------------------------ 调色板 ---------------------------------- */

/** 颜色用 alpha 表达层级（Apple 的 vibrancy：文字不用死灰，留出材质透出的层次） */
/**
 * 主题表。前 6 套取自 theme-factory 的预设（色值来自各自的 theme 文件），
 * `default` 就是之前一直用的深色靛蓝，保证不切主题时观感不变。
 *
 * 每个主题只需要给出「底色 + 状态色 + 强调色 + 明暗模式」，
 * 其余表面色（卡片、胶囊、分隔线、文字灰阶）由 buildPalette() 按明暗模式推导。
 */
const THEMES = {
  default: {
    label: 'Default · 深色靛蓝',
    source: '本项目默认',
    mode: 'dark',
    background: '#1a1a2e',
    online: '#30d158',
    warning: '#ffd60a',
    offline: '#ff453a',
    danger: '#ff8a80',
    glow: 'auto',
    accent: null,
    layout: 'stack',
    style: 'material',
  },
  midnight: {
    label: 'Midnight Galaxy · 星空紫',
    source: 'theme-factory: midnight-galaxy',
    mode: 'dark',
    background: '#2b1e3e',
    online: '#7ee787',
    warning: '#e9c46a',
    offline: '#ff7b72',
    danger: '#ffb3ab',
    glow: { r: 164, g: 144, b: 194 },
    accent: '#a490c2',
    layout: 'split',
    style: 'cosmic',
  },
  ocean: {
    label: 'Ocean Depths · 深海青',
    source: 'theme-factory: ocean-depths',
    mode: 'dark',
    background: '#1a2332',
    online: '#4fd1c5',
    warning: '#e9c46a',
    offline: '#ff7b72',
    danger: '#ffb3ab',
    glow: { r: 45, g: 139, b: 139 },
    accent: '#a8dadc',
    layout: 'stack',
    style: 'swiss',
  },
  forest: {
    label: 'Forest Canopy · 林间绿',
    source: 'theme-factory: forest-canopy',
    mode: 'dark',
    background: '#2d4a2b',
    online: '#a4c86a',
    warning: '#e9c46a',
    offline: '#e07a5f',
    danger: '#ffb3a0',
    glow: { r: 125, g: 132, b: 113 },
    accent: '#a4ac86',
    layout: 'compact',
    style: 'organic',
  },
  sunset: {
    label: 'Sunset Boulevard · 落日橘',
    source: 'theme-factory: sunset-boulevard',
    mode: 'dark',
    background: '#264653',
    online: '#a3b565',
    warning: '#e9c46a',
    offline: '#e76f51',
    danger: '#ffb59e',
    glow: { r: 231, g: 111, b: 81 },
    accent: '#f4a261',
    layout: 'split',
    style: 'editorial',
  },
  frost: {
    label: 'Arctic Frost · 霜蓝（浅色）',
    source: 'theme-factory: arctic-frost',
    mode: 'light',
    background: '#e8f1fa',
    online: '#2f9e6b',
    warning: '#c8891f',
    offline: '#c94f4f',
    danger: '#b85450',
    glow: { r: 74, g: 111, b: 165 },
    accent: '#4a6fa5',
    layout: 'stack',
    style: 'material',
  },
  mono: {
    label: 'Modern Minimalist · 极简灰（浅色）',
    source: 'theme-factory: modern-minimalist',
    mode: 'light',
    background: '#f4f5f7',
    online: '#4f9d69',
    warning: '#c8891f',
    offline: '#c0504d',
    danger: '#a94a47',
    glow: { r: 112, g: 128, b: 144 },
    accent: '#708090',
    layout: 'compact',
    style: 'swiss',
  },
};

/**
 * 视觉语言（style）：主题之间的差别不只是颜色，而是整套页面处理方式。
 * 每个 style 决定 4 件事：背景怎么铺、卡片是什么材质、分隔线怎么画、小标签的排版。
 * 这些方向来自 canvas-design 的「视觉哲学」思路，各自成立、互不相似。
 */
const STYLES = {
  /** 材质卡片：半透明材质 + 顶部亮边 + 柔和投影（本项目原来的做法） */
  material: {
    label: '材质卡片',
    cardRadius: 'card',
    cardMaterial: 'translucent',
    cardEdge: 'gradient',
    cardShadow: 'soft',
    divider: 'fade',
    uppercaseLabels: false,
    background: 'glow',
    cardRadiusValue: CARD.radius,
  },
  /** 瑞士网格：平面色块、全宽发丝线、无投影、小标签强制大写 + 宽字距 */
  swiss: {
    label: '瑞士网格',
    cardMaterial: 'flat',
    cardEdge: 'hairline',
    cardShadow: 'none',
    divider: 'hairline',
    uppercaseLabels: true,
    background: 'grid',
    cardRadiusValue: 10,
  },
  /** 宇宙颗粒：密集微粒背景 + 强调色外发光 + 虚线分隔 + 更大的标题 */
  cosmic: {
    label: '宇宙颗粒',
    cardMaterial: 'translucent',
    cardEdge: 'accent',
    cardShadow: 'glow',
    divider: 'dashed',
    uppercaseLabels: true,
    background: 'grain',
    cardRadiusValue: 26,
    displayScale: 1.12,
  },
  /** 有机圆润：大圆角、柔和色斑背景、圆点分隔、无边框 */
  organic: {
    label: '有机圆润',
    cardMaterial: 'soft',
    cardEdge: 'none',
    cardShadow: 'soft',
    divider: 'dots',
    uppercaseLabels: false,
    background: 'blobs',
    cardRadiusValue: 36,
  },
  /** 社论横幅：顶部色带、左侧粗规线、扁平卡片、发丝分隔 */
  editorial: {
    label: '社论横幅',
    cardMaterial: 'flat',
    cardEdge: 'none',
    cardShadow: 'none',
    divider: 'rule',
    uppercaseLabels: true,
    background: 'band',
    cardRadiusValue: 8,
    displayScale: 1.08,
  },
};

/** hex -> rgba() 字符串 */
function rgba(hex, alpha) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const int = Number.parseInt(full, 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

/**
 * 由主题推导出完整的调色板。
 * 深色主题用白色系灰阶，浅色主题用深色系灰阶 —— 这就是主题能自由切换明暗的关键。
 */
function buildPalette(theme) {
  const light = theme.mode === 'light';
  const inkBase = light ? '23, 32, 46' : '255, 255, 255';
  const surface = (alpha) => (light ? `rgba(23, 32, 46, ${alpha})` : `rgba(255, 255, 255, ${alpha})`);

  return {
    mode: theme.mode,
    layout: theme.layout ?? 'stack',
    background: theme.background,
    accent: theme.accent,
    online: theme.online,
    warning: theme.warning,
    offline: theme.offline,
    danger: theme.danger,

    ink: {
      primary: `rgba(${inkBase}, 0.95)`,
      secondary: `rgba(${inkBase}, 0.62)`,
      tertiary: `rgba(${inkBase}, 0.44)`,
      quaternary: `rgba(${inkBase}, 0.30)`,
      faint: surface(light ? 0.14 : 0.16),
    },

    cardFill: light ? 'rgba(255, 255, 255, 0.78)' : 'rgba(255, 255, 255, 0.045)',
    cardEdgeTop: light
      ? 'rgba(255, 255, 255, 0.95)'
      : theme.accent
        ? rgba(theme.accent, 0.34)
        : 'rgba(255, 255, 255, 0.20)',
    cardEdgeMid: surface(light ? 0.05 : 0.06),
    cardEdgeBottom: surface(light ? 0.04 : 0.03),
    cardShadow: light ? 'rgba(31, 45, 61, 0.16)' : 'rgba(0, 0, 0, 0.55)',

    chipFill: surface(light ? 0.05 : 0.06),
    chipStroke: surface(light ? 0.08 : 0.10),
    tileBg: surface(light ? 0.06 : 0.07),
    tileStroke: light ? 'rgba(255, 255, 255, 0.85)' : surface(0.16),
    tileShadow: light ? 'rgba(31, 45, 61, 0.16)' : 'rgba(0, 0, 0, 0.40)',

    barTrack: surface(light ? 0.16 : 0.15),
    divider: surface(light ? 0.14 : 0.10),
    shade: light ? 'rgba(23, 32, 46, 0.05)' : 'rgba(0, 0, 0, 0.22)',
    glowAlpha: light ? [0.20, 0.07] : [0.30, 0.10],
    /** 环境光晕颜色：null = 跟着服务器图标平均色走 */
    glowColor: theme.glow === 'auto' || !theme.glow ? null : theme.glow,
  };
}

/** 当前生效的主题（每次渲染开始时设置） */
let activeTheme = THEMES.default;
let activePalette = buildPalette(activeTheme);
let activeStyle = STYLES.material;
let activeStyleName = 'material';

/**
 * 设置本次渲染的三层：
 *   theme  —— 配色（必给，默认 default）
 *   style  —— 视觉语言；不传就用该主题配套的那个（?style= 可自由覆盖）
 */
function setTheme(name, styleName) {
  activeTheme = THEMES[name] ?? THEMES.default;
  activePalette = buildPalette(activeTheme);
  activeStyleName = styleName && STYLES[styleName] ? styleName : (activeTheme.style ?? 'material');
  activeStyle = STYLES[activeStyleName] ?? STYLES.material;
}

/** 取某主题配套的视觉语言 */
function themeStyle(name) {
  return THEMES[name]?.style ?? 'material';
}

/** 可用视觉语言列表（给 /api/styles 与参数报错用） */
function listStyles() {
  return Object.entries(STYLES).map(([styleName, style]) => ({
    name: styleName,
    label: style.label,
  }));
}

/** 主题的完整描述（配色 + 版式 + 视觉语言），给 /api/themes 用 */
function describeTheme(name) {
  const theme = THEMES[name];
  if (!theme) return null;
  return {
    name,
    label: theme.label,
    source: theme.source,
    mode: theme.mode,
    layout: theme.layout ?? DEFAULT_LAYOUT,
    style: theme.style ?? 'material',
    styleLabel: (STYLES[theme.style] ?? STYLES.material).label,
  };
}

/**
 * INK / PALETTE 用 getter 暴露给绘制代码：所有旧调用（INK.tertiary、PALETTE.online …）
 * 都会自动读到当前主题的颜色，无需改动上百处调用点。
 */
const INK = {
  get primary() { return activePalette.ink.primary; },
  get secondary() { return activePalette.ink.secondary; },
  get tertiary() { return activePalette.ink.tertiary; },
  get quaternary() { return activePalette.ink.quaternary; },
  get faint() { return activePalette.ink.faint; },
};

const PALETTE = {
  get background() { return activePalette.background; },
  get online() { return activePalette.online; },
  get warning() { return activePalette.warning; },
  get offline() { return activePalette.offline; },
  get danger() { return activePalette.danger; },
  get cardFill() { return activePalette.cardFill; },
  get chipFill() { return activePalette.chipFill; },
  get chipStroke() { return activePalette.chipStroke; },
  get iconBg() { return activePalette.tileBg; },
  get tileStroke() { return activePalette.tileStroke; },
  get tileShadow() { return activePalette.tileShadow; },
  get barTrack() { return activePalette.barTrack; },
  get divider() { return activePalette.divider; },
};

/** 默认主题：可用 BANNER_THEME 固定，或每个请求用 ?theme= 指定 */
const DEFAULT_THEME = process.env.BANNER_THEME || 'default';

/** 可用主题列表（给 /api/themes 与参数报错用） */
function listThemes() {
  return Object.keys(THEMES).map((name) => describeTheme(name));
}

/** 没有图标时的环境色（偏冷的靛蓝，和底色同族） */
const DEFAULT_AMBIENT = { r: 84, g: 104, b: 158 };

/* --------------------------- 字体 / 文案 --------------------------------- */

const CJK_FONT_ALIAS = 'MCBannerCJK';
/** emoji / 符号字体的族名前缀：每个候选注册成 MCBannerEmoji0 / 1 / …，便于逐个自检 */
const EMOJI_FONT_ALIAS = 'MCBannerEmoji';
const FALLBACK_FONT = 'sans-serif';

const CJK_FONT_PATHS = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/truetype/arphic/ukai.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
];

/**
 * emoji 字体候选（顺序即优先级：彩色在前，单色兜底）。
 * 各发行版把字体放在哪一层并不一致，所以除这些写死的路径外还会扫 EMOJI_FONT_DIRS。
 */
const EMOJI_FONT_PATHS = [
  '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
  '/usr/share/fonts/opentype/noto/NotoColorEmoji.ttf',
  '/usr/share/fonts/noto/NotoColorEmoji.ttf',
  '/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf',
  '/usr/share/fonts/opentype/noto/NotoEmoji-Regular.ttf',
  '/usr/share/fonts/noto/NotoEmoji-Regular.ttf',
  // Debian/Ubuntu 的 fonts-symbola：单色轮廓字体，覆盖面很广，cairo 一定画得出来
  '/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf',
  '/usr/share/fonts/truetype/ancient-scripts/Symbola.ttf',
  // fonts-noto-core 里的 Noto Sans Symbols 2：同样是单色轮廓字体
  '/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf',
  '/System/Library/Fonts/Apple Color Emoji.ttc',
  'C:\\Windows\\Fonts\\seguiemj.ttf',
];

/** 兜底：扫这些目录找 emoji / 符号字体 */
const EMOJI_FONT_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/System/Library/Fonts',
  'C:\\Windows\\Fonts',
];

/** 目录扫描时认这些文件名（`symlink` 也算，所以只按名字判） */
const EMOJI_FONT_NAME_RE = /(emoji|symbola|symbols).*\.(ttf|ttc|otf)$/i;

/**
 * emoji 片段（含变体选择符与 ZWJ 组合序列）分两类，因为「没有对应字体」时处理方式不同：
 *   - ASTRAL：U+1F000 以上（🔮🎮🐍🇨🇳…）。文本字体基本没有这些字形，缺字体时必须整段丢掉
 *   - BMP：☀ ⚡ ❤ ✨ ⭐ ✅ ⛏ ⚔ 这类符号，以及键帽序列。主字体（含 DejaVu）往往有字形，
 *     所以没有专属字体时只是回到主字体栈，不会白丢
 */
const EMOJI_ASTRAL_RE =
  /[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F000}-\u{1FAFF}](?:\u{FE0F}|\u{200D}[\u{1F000}-\u{1FAFF}])*/gu;
/**
 * BMP 里的 emoji 只有两种合法写法（依据 Unicode emoji-data）：
 *   1. 默认即 emoji 呈现（Emoji_Presentation=Yes）：✨ ⚡ ⭐ ✅ ⌚ ⏰ …
 *   2. 默认文本呈现，必须再跟一个变体选择符 U+FE0F 才算 emoji：☀️ ❤️ ⚔️ ⛏️ ↔️ ✂️ …
 *   3. 键帽序列 1️⃣ #️⃣
 * 不在清单里的符号（★ ✂ ™ ※ ♥ ✦）**本来就不是 emoji**，一律留给主字体栈：
 * 塞给 emoji 字体反而会画成「里面写着码位的方框」（emoji 字体没有这些字形），
 * 实测 seguiemj 就没有 U+2605 ★。
 */
const EMOJI_BMP_RE = new RegExp(
  [
    // 1) Emoji_Presentation=Yes
    '[\\u{231A}-\\u{231B}\\u{23E9}-\\u{23EC}\\u{23F0}\\u{23F3}\\u{25FD}-\\u{25FE}',
    '\\u{2614}-\\u{2615}\\u{2648}-\\u{2653}\\u{267F}\\u{2693}\\u{26A1}\\u{26AA}-\\u{26AB}',
    '\\u{26BD}-\\u{26BE}\\u{26C4}-\\u{26C5}\\u{26CE}\\u{26D4}\\u{26EA}\\u{26F2}-\\u{26F3}',
    '\\u{26F5}\\u{26FA}\\u{26FD}\\u{2705}\\u{270A}-\\u{270B}\\u{2728}\\u{274C}\\u{274E}',
    '\\u{2753}-\\u{2755}\\u{2757}\\u{2795}-\\u{2797}\\u{27B0}\\u{27BF}\\u{2B1B}-\\u{2B1C}',
    '\\u{2B50}\\u{2B55}]',
    // 2) 默认文本呈现，必须带 U+FE0F
    '|[\\u{00A9}\\u{00AE}\\u{203C}\\u{2049}\\u{2122}\\u{2139}\\u{2194}-\\u{2199}',
    '\\u{21A9}-\\u{21AA}\\u{2328}\\u{23CF}\\u{23ED}-\\u{23EF}\\u{23F1}-\\u{23F2}\\u{23F8}-\\u{23FA}',
    '\\u{24C2}\\u{25AA}-\\u{25AB}\\u{25B6}\\u{25C0}\\u{25FB}-\\u{25FC}\\u{2600}-\\u{2604}',
    '\\u{260E}\\u{2611}\\u{2618}\\u{261D}\\u{2620}\\u{2622}-\\u{2623}\\u{2626}\\u{262A}',
    '\\u{262E}-\\u{262F}\\u{2638}-\\u{263A}\\u{2640}\\u{2642}\\u{265F}-\\u{2660}\\u{2663}',
    '\\u{2665}-\\u{2666}\\u{2668}\\u{267B}\\u{267E}\\u{2692}\\u{2694}-\\u{2697}\\u{2699}',
    '\\u{269B}-\\u{269C}\\u{26A0}\\u{26B0}-\\u{26B1}\\u{26C8}\\u{26CF}\\u{26D1}\\u{26D3}',
    '\\u{26E9}\\u{26F0}-\\u{26F1}\\u{26F4}\\u{26F7}-\\u{26F9}\\u{2702}\\u{2708}-\\u{2709}',
    '\\u{270C}-\\u{270D}\\u{270F}\\u{2712}\\u{2714}\\u{2716}\\u{271D}\\u{2721}',
    '\\u{2733}-\\u{2734}\\u{2744}\\u{2747}\\u{2763}-\\u{2764}\\u{27A1}\\u{2934}-\\u{2935}',
    '\\u{2B05}-\\u{2B07}\\u{3030}\\u{303D}\\u{3297}\\u{3299}]\\u{FE0F}',
    // 3) 键帽
    '|[0-9#*]\\u{FE0F}?\\u{20E3}',
  ].join(''),
  'gu'
);

/** 字体自检用的样本：一个星体面 emoji、一个 BMP 符号 */
const EMOJI_PROBE_ASTRAL = '\u{1F52E}'; // 🔮
const EMOJI_PROBE_BMP = '\u2B50'; // ⭐

const LABELS = {
  zh: {
    online: '在线',
    offline: '离线',
    players: '在线玩家',
    version: '版本',
    queried: '查询耗时',
    cacheHit: '命中缓存',
    cached: '缓存 30s',
    sourceQuery: '完整列表',
    sourceSample: '采样列表（SLP）',
    showingOf: (shown, total) => `显示 ${shown} / ${total} 人`,
    playersCount: (count) => `${count} 人`,
    noPlayers: '当前没有玩家在线',
    noList: '未获取到玩家列表（服务端未开启 Query）',
    hint: '请确认服务器在线；Query 需要 enable-query=true 并放行 UDP 端口',
    protocol: '协议',
    overviewTitle: '服务器一览',
    serversOnline: (online, total) => `${online}/${total} 台在线`,
    serversOffline: (count) => `${count} 台离线`,
    playersTotal: (count) => `${count} 名玩家在线`,
    invalid: '参数错误',
    renderError: '生成图片失败',
  },
  en: {
    online: 'ONLINE',
    offline: 'OFFLINE',
    players: 'PLAYERS',
    version: 'version',
    queried: 'queried in',
    cacheHit: 'cache hit',
    cached: 'cache 30s',
    sourceQuery: 'full list',
    sourceSample: 'sample (SLP)',
    showingOf: (shown, total) => `showing ${shown} / ${total}`,
    playersCount: (count) => `${count} players`,
    noPlayers: 'No players online',
    noList: 'No player list returned (query is disabled on the server)',
    hint: 'Make sure the server is up; query needs enable-query=true and an open UDP port',
    protocol: 'protocol',
    overviewTitle: 'Server overview',
    serversOnline: (online, total) => `${online}/${total} online`,
    serversOffline: (count) => `${count} offline`,
    playersTotal: (count) => `${count} players`,
    invalid: 'Invalid request',
    renderError: 'Render failed',
  },
};

let fontsInitialized = false;
let cjkFamily = null;
/** 能画星体面 emoji（🔮）的字体族；null = 没有可用的 */
let emojiFamily = null;
/** 能画 BMP 符号（⭐）的字体族；null = 交给主字体栈回退 */
let symbolFamily = null;
/** 实际选中的字体文件（写启动日志 / 排查用） */
let emojiFontFile = null;
let symbolFontFile = null;
/** 已成功注册的 UI 字重（key 为 UI_FONTS 的键） */
const uiFamilies = new Map();
/** 自带的 UI 字体本身是否含中文（容器里没有系统中文字体时靠它判断） */
let uiFontHasCjk = false;

function initFonts() {
  if (fontsInitialized) return;
  fontsInitialized = true;

  const explicitPath = process.env.BANNER_FONT_PATH;
  const explicitFamily = process.env.BANNER_FONT_FAMILY;
  const cjkCandidates = explicitPath ? [explicitPath] : CJK_FONT_PATHS;

  for (const file of cjkCandidates) {
    try {
      if (!fs.existsSync(file)) continue;
      registerFont(file, { family: CJK_FONT_ALIAS });
      cjkFamily = explicitFamily || CJK_FONT_ALIAS;
      break;
    } catch {
      /* 换下一个 */
    }
  }

  // 项目自带的 UI 字体（逐字重注册，SC 版优先）
  for (const [weight, { files, family }] of Object.entries(UI_FONTS)) {
    for (const file of files) {
      const fullPath = `${UI_FONT_DIR}/${file}`;
      try {
        if (!fs.existsSync(fullPath)) continue;
        registerFont(fullPath, { family });
        uiFamilies.set(weight, family);
        if (!uiFontHasCjk) uiFontHasCjk = fontSupportsCjk(fullPath);
        break;
      } catch {
        /* 换下一个候选文件 */
      }
    }
  }

  initEmojiFont();
}

/**
 * 挑出「真的能把 emoji / 符号画出来」的字体。
 *
 * 彩色 emoji 字体（NotoColorEmoji / Apple Color Emoji / Segoe UI Emoji）是 CBDT / sbix 位图字体，
 * 部分 cairo + FreeType 组合压根栅格化不出来 —— 画出来是空白或豆腐块，表现就是「emoji 显示不正常」。
 * 所以候选字体逐个注册成独立族名并试画一遍，合格的才采用；彩色不行就退到单色轮廓字体
 * （Symbola / Noto Emoji 之类），后者任何 cairo 都画得出来。
 *
 * 分成两份，因为两者的覆盖面并不重合：
 *   - emojiFamily ：能画 U+1F000 以上的星体面 emoji（🔮🎮）
 *   - symbolFamily：能画 ☀ ⚡ ✨ ⭐ ✅ 这类 BMP 符号
 * 彩色 emoji 字体通常两者都能画，那就共用同一份；只拿到符号字体时，至少符号不会变成方框。
 */
function initEmojiFont() {
  const candidates = listEmojiFontFiles();
  for (let index = 0; index < candidates.length; index += 1) {
    const file = candidates[index];
    const family = `${EMOJI_FONT_ALIAS}${index}`;
    try {
      registerFont(file, { family });
    } catch {
      continue; // 这个字体文件读不了，换下一个
    }

    if (!emojiFamily && fontRenders(family, EMOJI_PROBE_ASTRAL)) {
      emojiFamily = family;
      emojiFontFile = file;
    }
    if (!symbolFamily && fontRenders(family, EMOJI_PROBE_BMP)) {
      symbolFamily = family;
      symbolFontFile = file;
    }
    if (emojiFamily && symbolFamily) return;
  }
}

/** 列出机器上可能是 emoji / 符号字体的文件（写死的路径优先，其次是目录扫描） */
function listEmojiFontFiles() {
  const files = [];
  const seen = new Set();
  const push = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    try {
      if (fs.existsSync(file)) files.push(file);
    } catch {
      /* 读不了的路径直接忽略 */
    }
  };

  for (const file of EMOJI_FONT_PATHS) push(file);

  const scanned = [];
  for (const dir of EMOJI_FONT_DIRS) walkEmojiFonts(dir, scanned);
  // 彩色优先（好看），单色兜底
  scanned.sort((a, b) => Number(/color/i.test(b)) - Number(/color/i.test(a)));
  for (const file of scanned) push(file);

  return files;
}

/** 递归收集文件名里带 emoji / symbola / symbols 的字体文件 */
function walkEmojiFonts(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      // 目录继续往下走；字体文件可能是 symlink，所以只要不是目录就按名字判断
      if (entry.isDirectory()) walkEmojiFonts(full, out);
      else if (EMOJI_FONT_NAME_RE.test(entry.name)) out.push(full);
    } catch {
      /* 忽略读不了的条目 */
    }
  }
}

/**
 * 试画一个样本字符，判断这个字体族是不是真的能画出来。三种坏情况都要挡掉：
 *   1. 什么都没画出来 —— 彩色位图字体不被 cairo 支持时就是这样
 *   2. 和「必然缺字的私有区码位」画出来一模一样 —— 说明拿到的是豆腐块
 *   3. 步进宽度离谱 —— 位图字体只提供一个像素尺寸时，字距会被撑开
 */
function fontRenders(family, sample) {
  const size = 20;
  try {
    const canvas = createCanvas(64, 64);
    const ctx = canvas.getContext('2d');
    ctx.font = `${size}px "${family}"`;
    ctx.textBaseline = 'top';

    const shot = (text) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, 2, 2);
      return canvas.toBuffer('image/png').toString('base64');
    };

    const painted = shot(sample);
    if (painted === shot(' ') || painted === shot('\u{10FFFD}')) return false;

    const advance = ctx.measureText(sample).width;
    return Number.isFinite(advance) && advance > 0 && advance <= size * 3;
  } catch {
    return false;
  }
}

/** 字体自检信息：启动时打一行日志，方便在容器里排查「中文 / emoji 画成方框」 */
function getFontDiagnostics() {
  initFonts();
  return {
    uiWeights: [...uiFamilies.keys()],
    uiHasCjk: uiFontHasCjk,
    cjk: cjkFamily,
    emoji: emojiFamily,
    emojiFile: emojiFontFile,
    symbol: symbolFamily,
    symbolFile: symbolFontFile,
  };
}

/** 取某字重实际可用的字体族（缺失时按 WEIGHT_FALLBACK 降级） */
function resolveUiFamily(weight) {
  const chain = WEIGHT_FALLBACK[weight] ?? WEIGHT_FALLBACK.normal;
  for (const key of chain) {
    const family = uiFamilies.get(key);
    if (family) return family;
  }
  return null;
}

/**
 * 读字体文件的 cmap 表，判断它是否包含中文字形（format 4 与 12 都支持）。
 * 用来回答「项目自带的字体到底能不能画中文」—— HarmonyOS Sans SC 能，纯拉丁子集不能。
 */
function fontSupportsCjk(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const numTables = buf.readUInt16BE(4);
    let cmapOffset = 0;
    for (let i = 0; i < numTables; i += 1) {
      const off = 12 + i * 16;
      if (buf.toString('ascii', off, off + 4) === 'cmap') cmapOffset = buf.readUInt32BE(off + 8);
    }
    if (!cmapOffset) return false;

    const numSub = buf.readUInt16BE(cmapOffset + 2);
    const ranges = [];
    for (let i = 0; i < numSub; i += 1) {
      const record = cmapOffset + 4 + i * 8;
      const sub = cmapOffset + buf.readUInt32BE(record + 4);
      const format = buf.readUInt16BE(sub);
      if (format === 4) {
        const segCountX2 = buf.readUInt16BE(sub + 6);
        const endBase = sub + 14;
        const startBase = endBase + segCountX2 + 2;
        for (let seg = 0; seg < segCountX2 / 2; seg += 1) {
          ranges.push([buf.readUInt16BE(startBase + seg * 2), buf.readUInt16BE(endBase + seg * 2)]);
        }
      } else if (format === 12) {
        const groups = buf.readUInt32BE(sub + 12);
        for (let group = 0; group < groups; group += 1) {
          const base = sub + 16 + group * 12;
          ranges.push([buf.readUInt32BE(base + 4), buf.readUInt32BE(base + 8)]);
        }
      }
    }

    const probes = [...'金羊毛在线玩家服'].map((char) => char.codePointAt(0));
    return probes.every((codePoint) => ranges.some(([start, end]) => codePoint >= start && codePoint <= end));
  } catch {
    return false;
  }
}

/** 是否使用中文标签 */
function isChinese() {
  const mode = (process.env.BANNER_LABELS || 'auto').toLowerCase();
  if (mode === 'zh') return true;
  if (mode === 'en') return false;
  // 自带字体（HarmonyOS Sans SC）或系统 CJK 字体，任意一个有中文字形即可
  return Boolean(cjkFamily || uiFontHasCjk);
}

function labels() {
  return isChinese() ? LABELS.zh : LABELS.en;
}

/* ---------------------------- 排版（字距/字号） -------------------------- */

/**
 * Apple 的排版规则：字距随字号变化。
 * 大字号收紧（避免越大越松散），小字号放宽（提升可读性），正文接近 0。
 */
function trackingFor(size) {
  if (size >= 24) return -0.5;
  if (size >= 19) return -0.2;
  if (size >= 15) return 0;
  return 0.5;
}

function baseFont(weight, size) {
  const uiFamily = resolveUiFamily(weight);
  const families = [
    uiFamily ? `"${uiFamily}"` : null,
    cjkFamily ? `"${cjkFamily}"` : null,
    FALLBACK_FONT,
  ]
    .filter(Boolean)
    .join(', ');
  // 字重由具体字体文件承担（字体栈里不再用 bold 关键字，避免触发合成加粗）
  return `${size}px ${families}`;
}

/** 字号 → 行距：大字号收紧、小字号放松（CJK 额外留一点） */
function leadingFor(size) {
  return Math.round(size * 1.34);
}

/**
 * 把文本切成绘制单元：emoji 整段算一个单元（换用 emoji / 符号字体画），
 * 其余按码点切分（避免拆断代理对）。单元的 font 为 null 表示用主字体栈。
 *
 * 没有对应字体时的取舍：
 *   - 星体面 emoji（🔮）整段丢掉 —— 普通文本字体不会有这些字形，留着一定是方框
 *   - BMP 符号（⭐✨）只是回到主字体栈，由 DejaVu 等去回退，不会因为缺 emoji 字体就被抹掉
 */
function textUnits(text) {
  const value = String(text ?? '');
  const units = [];

  for (const segment of splitUnits(value, EMOJI_ASTRAL_RE)) {
    if (segment.emoji) {
      if (emojiFamily) units.push({ text: segment.text, font: emojiFamily });
      continue; // 没有可用字体：丢掉，别画方框
    }
    for (const piece of splitUnits(segment.text, EMOJI_BMP_RE)) {
      if (piece.emoji && symbolFamily) {
        units.push({ text: piece.text, font: symbolFamily });
        continue;
      }
      for (const char of piece.text) units.push({ text: char, font: null });
    }
  }

  return units;
}

/** 按正则把文本切成 { text, emoji } 段（emoji 段整体保留、不拆） */
function splitUnits(value, pattern) {
  const segments = [];
  let cursor = 0;

  pattern.lastIndex = 0;
  let match = pattern.exec(value);
  while (match !== null) {
    if (match.index > cursor) segments.push({ text: value.slice(cursor, match.index), emoji: false });
    segments.push({ text: match[0], emoji: true });
    cursor = match.index + match[0].length;
    match = pattern.exec(value);
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), emoji: false });

  return segments;
}

/** 设置某个单元对应的字体 */
function applyUnitFont(ctx, unit, size, weight) {
  ctx.font = unit.font ? `${size}px "${unit.font}"` : baseFont(weight, size);
}

/** 测量一段文本（带字距），同时把 ctx.font 留在最后一个单元上 */
function measureRichText(ctx, text, { size, weight = 'normal', tracking }) {
  const gap = tracking ?? trackingFor(size);
  const units = textUnits(text);
  let width = 0;
  for (let i = 0; i < units.length; i += 1) {
    applyUnitFont(ctx, units[i], size, weight);
    width += ctx.measureText(units[i].text).width;
    if (i < units.length - 1) width += gap;
  }
  return width;
}

/**
 * 绘制一段文本：逐单元切换字体 + 手动字距（node-canvas 不支持 ctx.letterSpacing）。
 * @returns {number} 实际绘制的宽度
 */
function drawRichText(ctx, text, x, baseline, { size, weight = 'normal', color, tracking, align = 'left' }) {
  const gap = tracking ?? trackingFor(size);
  const units = textUnits(text);
  if (units.length === 0) return 0;

  const total = measureRichText(ctx, text, { size, weight, tracking: gap });
  let cursor = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;

  ctx.fillStyle = color;
  for (const unit of units) {
    applyUnitFont(ctx, unit, size, weight);
    ctx.fillStyle = color;
    ctx.fillText(unit.text, cursor, baseline);
    cursor += ctx.measureText(unit.text).width + gap;
  }
  return total;
}

/** 按宽度截断（按码点切，避免拆断代理对） */
function truncateRich(ctx, text, maxWidth, options) {
  const value = String(text ?? '');
  if (measureRichText(ctx, value, options) <= maxWidth) return value;
  const chars = [...value];
  while (chars.length > 1) {
    chars.pop();
    const candidate = `${chars.join('')}…`;
    if (measureRichText(ctx, candidate, options) <= maxWidth) return candidate;
  }
  return '…';
}

/** 折行（最多 maxLines 行，超出补省略号；超长词按字符硬切） */
function wrapRich(ctx, text, maxWidth, maxLines, options) {
  const input = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!input) return [];

  const atoms = [];
  for (const word of input.split(' ')) {
    if (measureRichText(ctx, word, options) <= maxWidth) {
      atoms.push(word);
      continue;
    }
    let chunk = '';
    for (const char of word) {
      if (chunk && measureRichText(ctx, chunk + char, options) > maxWidth) {
        atoms.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    if (chunk) atoms.push(chunk);
  }

  const lines = [];
  let current = '';
  for (let i = 0; i < atoms.length; i += 1) {
    const candidate = current ? `${current} ${atoms[i]}` : atoms[i];
    if (measureRichText(ctx, candidate, options) <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current || atoms[i]);
    current = current ? atoms[i] : '';
    if (lines.length === maxLines) {
      const leftover = Boolean(current) || i + 1 < atoms.length;
      if (leftover) lines[maxLines - 1] = truncateRich(ctx, `${lines[maxLines - 1]} …`, maxWidth, options);
      return lines;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

/** 自适应字号：把文本压进 maxWidth（只缩小） */
function fitSize(ctx, text, { weight = 'normal', startSize, minSize = 13, maxWidth, tracking }) {
  let size = startSize;
  while (size > minSize) {
    if (measureRichText(ctx, text, { size, weight, tracking: tracking ?? trackingFor(size) }) <= maxWidth) return size;
    size -= 1;
  }
  return minSize;
}

/* ------------------------------ 形状 ------------------------------------ */

/** 圆角矩形路径（优先 ctx.roundRect） */
function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * 材质卡片：淡填充 + 柔和投影 + 顶部亮边。
 * 亮边用上下渐变描边模拟「光打在材质上边缘」，这是让平面图有厚度感的关键。
 */
function drawCard(ctx, card = CARD) {
  const radius = activeStyle.cardRadiusValue ?? card.radius;
  const accent = activePalette.accent;

  // 材质：半透明 / 平面 / 更软
  const fill =
    activeStyle.cardMaterial === 'flat'
      ? activePalette.mode === 'light'
        ? 'rgba(255, 255, 255, 0.92)'
        : 'rgba(255, 255, 255, 0.035)'
      : activeStyle.cardMaterial === 'soft'
        ? activePalette.mode === 'light'
          ? 'rgba(255, 255, 255, 0.70)'
          : 'rgba(255, 255, 255, 0.055)'
        : activePalette.cardFill;

  // 投影：柔和 / 无 / 强调色外发光
  if (activeStyle.cardShadow !== 'none') {
    ctx.save();
    if (activeStyle.cardShadow === 'glow') {
      ctx.shadowColor = accent ? rgba(accent, 0.28) : activePalette.cardShadow;
      ctx.shadowBlur = 42;
      ctx.shadowOffsetY = 6;
    } else {
      ctx.shadowColor = activePalette.cardShadow;
      ctx.shadowBlur = activeStyle.cardMaterial === 'soft' ? 34 : 26;
      ctx.shadowOffsetY = 10;
    }
    roundRectPath(ctx, card.x, card.y, card.width, card.height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  } else {
    roundRectPath(ctx, card.x, card.y, card.width, card.height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // 边界：渐变亮边 / 发丝线 / 强调色细线 / 无
  if (activeStyle.cardEdge === 'gradient') {
    const edge = ctx.createLinearGradient(0, card.y, 0, card.y + card.height);
    edge.addColorStop(0, activePalette.cardEdgeTop);
    edge.addColorStop(0.4, activePalette.cardEdgeMid);
    edge.addColorStop(1, activePalette.cardEdgeBottom);
    ctx.save();
    roundRectPath(ctx, card.x + 0.5, card.y + 0.5, card.width - 1, card.height - 1, radius);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  } else if (activeStyle.cardEdge === 'hairline' || activeStyle.cardEdge === 'accent') {
    ctx.save();
    roundRectPath(ctx, card.x + 0.5, card.y + 0.5, card.width - 1, card.height - 1, radius);
    ctx.strokeStyle =
      activeStyle.cardEdge === 'accent' && accent
        ? rgba(accent, 0.42)
        : activePalette.mode === 'light'
          ? 'rgba(23, 32, 46, 0.12)'
          : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // 社论风格：卡片左侧一条粗规线
  if (activeStyle.divider === 'rule' && accent) {
    ctx.save();
    roundRectPath(ctx, card.x, card.y + 24, 5, card.height - 48, 2.5);
    ctx.fillStyle = rgba(accent, 0.92);
    ctx.fill();
    ctx.restore();
  }
}

/** 两端淡出的软分隔（不用生硬的一条实线） */
function drawSoftDivider(ctx, y, x1 = CONTENT_X, x2 = CONTENT_RIGHT, strength = 0.10) {
  const scaleAlpha = strength / 0.1;
  const base = activePalette.divider;
  const color = base.replace(/([\d.]+)\)$/, (_, alpha) => String(Math.min(1, Number(alpha) * scaleAlpha)));
  const solid = base.replace(/([\d.]+)\)$/, (_, alpha) => String(Math.min(1, Number(alpha) * 1.6)));

  ctx.save();
  switch (activeStyle.divider) {
    // 瑞士：整条发丝线，不淡出
    case 'hairline': {
      ctx.strokeStyle = solid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y + 0.5);
      ctx.lineTo(x2, y + 0.5);
      ctx.stroke();
      break;
    }
    // 宇宙：虚线
    case 'dashed': {
      ctx.strokeStyle = solid;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(x1, y + 0.5);
      ctx.lineTo(x2, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    // 有机：圆点串
    case 'dots': {
      ctx.fillStyle = solid;
      for (let x = x1; x <= x2; x += 14) {
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    // 社论：只在左侧一小段加粗
    case 'rule': {
      ctx.strokeStyle = solid;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y + 0.5);
      ctx.lineTo(x1 + (x2 - x1) * 0.22, y + 0.5);
      ctx.stroke();
      break;
    }
    default: {
      const gradient = ctx.createLinearGradient(x1, y, x2, y);
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(0.35, color);
      gradient.addColorStop(0.65, color);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y + 0.5);
      ctx.lineTo(x2, y + 0.5);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** 风格化的小节标签：瑞士/宇宙/社论风格强制大写 + 更宽字距 */
function styleLabel(text) {
  const value = String(text);
  if (!activeStyle.uppercaseLabels) return value;
  return value.toUpperCase();
}

/** 各视觉语言的小装饰（只在需要时画几笔，不喧宾夺主） */
function drawStyleDecorations(ctx, width, height) {
  const accent = activePalette.accent;
  if (!accent) return;

  // 瑞士 / 社论：卡片四角的刻线，像制图标注
  if (activeStyle.uppercaseLabels && activeStyle.divider !== 'dashed') {
    const tick = 10;
    const inset = 16;
    const light = activePalette.mode === 'light';
    ctx.save();
    ctx.strokeStyle = light ? 'rgba(23, 32, 46, 0.22)' : rgba(accent, 0.55);
    ctx.lineWidth = 1.5;
    const corners = [
      [inset, inset, 1, 1],
      [width - inset, inset, -1, 1],
    ];
    for (const [x, y, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x + tick * dx, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + tick * dy);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** 背景：底色 + 由服务器图标平均色决定的极淡环境光晕 */
function drawBackground(ctx, ambient, width = BANNER_WIDTH, height = BANNER_HEIGHT) {
  const { r, g, b } = activePalette.glowColor ?? ambient;
  const accent = activePalette.accent;

  ctx.fillStyle = activePalette.background;
  ctx.fillRect(0, 0, width, height);

  switch (activeStyle.background) {
    // 瑞士网格：平面底 + 极淡的模数网格，秩序感来自结构而不是装饰
    case 'grid': {
      ctx.save();
      ctx.strokeStyle = activePalette.mode === 'light' ? 'rgba(23, 32, 46, 0.045)' : 'rgba(255, 255, 255, 0.035)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }

    // 宇宙颗粒：确定性伪随机微粒 + 强调色外溢光
    case 'grain': {
      const glow = ctx.createRadialGradient(width * 0.22, height * 0.18, 0, width * 0.22, height * 0.18, width * 0.9);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.34)`);
      glow.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.10)`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      let seed = 20260923;
      const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      ctx.save();
      for (let i = 0; i < 520; i += 1) {
        const x = random() * width;
        const y = random() * height;
        const radius = 0.4 + random() * 1.3;
        const useAccent = random() > 0.82;
        // 浅色配色下白色颗粒会看不见，所以按明暗模式换颗粒颜色
        const grainBase = activePalette.mode === 'light' ? '23, 32, 46' : '255, 255, 255';
        const grainAlpha = activePalette.mode === 'light' ? 0.05 + random() * 0.16 : 0.04 + random() * 0.22;
        ctx.fillStyle = useAccent
          ? rgba(accent ?? '#ffffff', 0.12 + random() * 0.3)
          : `rgba(${grainBase}, ${grainAlpha})`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      break;
    }

    // 有机圆润：三个柔和色斑，边界完全融化在底色里
    case 'blobs': {
      const spots = [
        { x: width * 0.18, y: height * 0.12, radius: width * 0.55, alpha: 0.22 },
        { x: width * 0.92, y: height * 0.28, radius: width * 0.42, alpha: 0.14 },
        { x: width * 0.55, y: height * 1.02, radius: width * 0.5, alpha: 0.12 },
      ];
      spots.forEach((spot) => {
        const blob = ctx.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, spot.radius);
        blob.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${spot.alpha})`);
        blob.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = blob;
        ctx.fillRect(0, 0, width, height);
      });
      break;
    }

    // 社论横幅：顶部一条实色带 + 从左上斜下的暖光
    case 'band': {
      if (accent) {
        ctx.fillStyle = rgba(accent, 0.9);
        ctx.fillRect(0, 0, width, 8);
      }
      const wash = ctx.createLinearGradient(0, 0, width, height);
      wash.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.26)`);
      wash.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.06)`);
      wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, width, height);
      break;
    }

    // 材质卡片：柔和径向光晕（原来的做法）
    default: {
      const [glowStrong, glowSoft] = activePalette.glowAlpha;
      const radius = Math.max(520, width * 0.7);
      const glow = ctx.createRadialGradient(CONTENT_X + 40, 70, 0, CONTENT_X + 40, 70, radius);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowStrong})`);
      glow.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${glowSoft})`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      break;
    }
  }

  // 底部轻微压暗，增加纵深（瑞士网格不需要）
  if (activeStyle.background !== 'grid') {
    const shade = ctx.createLinearGradient(0, height * 0.55, 0, height);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, activePalette.shade);
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
  }
}

/* ------------------------------ 图片 ------------------------------------ */

function avatarBaseUrl() {
  return (process.env.BANNER_AVATAR_BASE || 'https://mc-heads.net').replace(/\/+$/, '');
}

function avatarsEnabled() {
  return (process.env.BANNER_AVATARS || 'on').toLowerCase() !== 'off';
}

/** @type {Map<string, { image: object, expiresAt: number }>} */
const avatarCache = new Map();
/** @type {Map<string, { key: string, image: object, color: object, expiresAt: number }>} */
const iconCache = new Map();

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'mcstatus-api/1.0', accept: 'image/*' },
    });
    if (!response.ok) return null;
    if (!(response.headers.get('content-type') || '').startsWith('image/')) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      image: await loadImage(bytes),
      hash: crypto.createHash('sha1').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * mc-heads 对「查不到的玩家名」（离线服 / 非正版账号）会返回**同一张**默认头像，
 * 于是列表里会出现一堆一模一样的「史蒂夫」。
 * 这里用一个随机探针名取一次那张默认头像的哈希，用来识别这种情况。
 */
let defaultHeadHash = null;
let defaultHeadProbedAt = 0;

async function resolveDefaultHeadHash() {
  if (Date.now() - defaultHeadProbedAt < DEFAULT_HEAD_PROBE_TTL_MS) return defaultHeadHash;
  defaultHeadProbedAt = Date.now();

  const probe = `__mcstatus_probe_${Math.random().toString(36).slice(2, 10)}__`;
  const result = await fetchImage(`${avatarBaseUrl()}/avatar/${encodeURIComponent(probe)}/50`);
  if (result) defaultHeadHash = result.hash;
  return defaultHeadHash;
}

/* ---------------------------- 头像数据源 -------------------------------- */

/**
 * 自研：名字 -> UUID -> 皮肤贴图 -> 自己裁「脸 + 帽子层」渲染。
 * @returns {{ image: object } | { notFound: true } | null}
 */
async function avatarFromMojang(playerName, size) {
  const skin = await fetchSkinImage(playerName);
  if (!skin) return null;
  if (skin.notFound) return { notFound: true };
  if (AVATAR_STYLE === 'flat') return { image: renderHead(skin.image, size) };
  if (AVATAR_STYLE === '3d') return { image: renderHead3D(skin.image, size) };
  return { image: renderHeadMinimal(skin.image, size) };
}

/** mccag 头像服务（GET /api/generate/<模型>/mojang/<用户名>） */
async function avatarFromMccag(playerName) {
  const url =
    `${MCCAG_BASE}/api/generate/minimal/mojang/${encodeURIComponent(playerName)}` +
    '?type=head&scale=50&shadow=0&border=0';
  const result = await fetchImage(url);
  if (!result) return null;
  return { image: result.image };
}

/** mc-heads（第三方，兜底）；返回哈希供「默认脸」识别 */
async function avatarFromMcHeads(playerName) {
  const result = await fetchImage(`${avatarBaseUrl()}/avatar/${encodeURIComponent(playerName)}/50`);
  if (!result) return null;
  return { image: result.image, hash: result.hash };
}

const AVATAR_PROVIDER_IMPL = {
  mojang: avatarFromMojang,
  mccag: avatarFromMccag,
  'mc-heads': avatarFromMcHeads,
};

/** 依次尝试各数据源 */
async function tryAvatarProviders(playerName, size) {
  for (const provider of AVATAR_PROVIDERS) {
    const impl = AVATAR_PROVIDER_IMPL[provider];
    if (!impl) continue;

    let result = null;
    try {
      result = await impl(playerName, size);
    } catch {
      result = null;
    }

    if (!result) continue; // 该数据源不可用，换下一个
    if (result.notFound) return { image: null, hash: null, notFound: true }; // 确认没有皮肤
    if (result.image) return { image: result.image, hash: result.hash ?? null, notFound: false };
  }
  return { image: null, hash: null, notFound: false };
}

/** 玩家头像：依次尝试数据源，全失败自动重试一轮（首次并发请求偶发超时） */
async function loadAvatar(playerName, size) {
  const cacheId = `${size}:${playerName}`;
  const cached = avatarCache.get(cacheId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let result = await tryAvatarProviders(playerName, size);
  if (!result.image && !result.notFound) {
    result = await tryAvatarProviders(playerName, size);
  }

  if (avatarCache.size >= AVATAR_CACHE_MAX) {
    let dropped = 0;
    for (const key of avatarCache.keys()) {
      avatarCache.delete(key);
      if ((dropped += 1) >= 50) break;
    }
  }

  const entry = { ...result, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS };
  avatarCache.set(cacheId, entry);
  return entry;
}

/** 取图片平均色（缩到 1x1 再读像素），用作背景环境色 */
function averageColor(image) {
  try {
    const canvas = createCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  } catch {
    return DEFAULT_AMBIENT;
  }
}

/** 服务器图标（SLP favicon，data URL），同时给出平均色 */
async function loadServerIcon(status) {
  const favicon = status.serverIcon;
  const cacheId = `${status.host}:${status.port}`;
  const cached = iconCache.get(cacheId);
  if (cached && cached.key === favicon && cached.expiresAt > Date.now()) return cached;

  if (!favicon || !favicon.startsWith('data:image/')) return null;

  try {
    const base64 = favicon.slice(favicon.indexOf(',') + 1);
    const image = await loadImage(Buffer.from(base64, 'base64'));
    const entry = {
      key: favicon,
      image,
      color: averageColor(image),
      expiresAt: Date.now() + AVATAR_CACHE_TTL_MS,
    };
    // 环境色饱和度压低一些，避免喧宾夺主
    const gray = (entry.color.r + entry.color.g + entry.color.b) / 3;
    entry.color = {
      r: Math.round(gray + (entry.color.r - gray) * 0.7),
      g: Math.round(gray + (entry.color.g - gray) * 0.7),
      b: Math.round(gray + (entry.color.b - gray) * 0.7),
    };
    iconCache.set(cacheId, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * 并发拉取头像。
 * 返回与玩家一一对应的 Image 数组；没有皮肤（或加载失败）的位置是 null，
 * 由绘制层画成字母头像。
 */
async function loadAvatars(playerList, baseSize = CHIP_AVATAR) {
  if (!avatarsEnabled()) return [];

  // 按设备像素渲染/请求，画上去才是 1:1
  const size = Math.round(baseSize * activeRenderScale);
  const targets = playerList;
  const probeHashPromise =
    AVATAR_FALLBACK === 'letter' ? resolveDefaultHeadHash() : Promise.resolve(null);

  // 分批并发：一次打出去几十上百个请求容易被限流
  const entries = [];
  for (let index = 0; index < targets.length; index += AVATAR_BATCH_SIZE) {
    const batch = targets.slice(index, index + AVATAR_BATCH_SIZE);
    entries.push(...(await Promise.all(batch.map((name) => loadAvatar(name, size)))));
  }

  const probeHash = await probeHashPromise;
  return entries.map((entry) => {
    if (!entry || !entry.image) return null; // 加载失败 -> 字母头像
    if (probeHash && entry.hash === probeHash) return null; // 这是「查不到玩家」的默认脸 -> 字母头像
    return entry.image;
  });
}

/* ------------------------------ 组件 ------------------------------------ */

/** 名字 -> 稳定色相：让没有皮肤的玩家彼此可区分，同时保持低饱和不抢戏 */
function nameHue(name) {
  let hash = 0;
  for (const char of String(name ?? '')) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

/** 圆角图标 / 头像：材质填充 + 顶部亮边（没有图时画名字首字母） */
function drawTile(ctx, image, label, x, y, size, radius, { letter, crop = true } = {}) {
  // 图像源比目标大（缩小）→ 开平滑更好看；比目标小（放大）→ 关平滑保持像素感
  const deviceSize = size * activeRenderScale;
  const sourceWidth = image && typeof image.width === 'number' ? image.width : deviceSize;

  if (image && crop) {
    // 图标：圆角 + 描边，像一块有厚度的材质
    ctx.save();
    roundRectPath(ctx, x, y, size, size, radius);
    ctx.clip();
    ctx.imageSmoothingEnabled = sourceWidth >= deviceSize;
    try {
      ctx.drawImage(image, x, y, size, size);
    } catch {
      /* 单张图失败不影响整张图 */
    }
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, x + 0.5, y + 0.5, size - 1, size - 1, radius);
    ctx.strokeStyle = activePalette.tileStroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (image) {
    // 头像：不裁剪、不加边框，完整画出来（游戏里的皮肤头本来就是整块方形）
    ctx.save();
    ctx.imageSmoothingEnabled = sourceWidth >= deviceSize;
    try {
      ctx.drawImage(image, x, y, size, size);
    } catch {
      /* 单张图失败不影响整张图 */
    }
    ctx.restore();
    return;
  }

  // 没有皮肤：按名字取色的方块 + 首字母（同样保持方形，与头像一致）
  ctx.save();
  if (crop) {
    roundRectPath(ctx, x, y, size, size, radius);
  } else {
    ctx.beginPath();
    ctx.rect(x, y, size, size);
  }
  // 浅色主题用亮底色 + 深色首字母，深色主题反过来
  ctx.fillStyle =
    activePalette.mode === 'light'
      ? `hsl(${nameHue(label)}, 45%, 84%)`
      : `hsl(${nameHue(label)}, 30%, 30%)`;
  ctx.fill();
  ctx.restore();

  if (letter) {
    const previousBaseline = ctx.textBaseline;
    ctx.textBaseline = 'middle';
    drawRichText(ctx, (label || '?').slice(0, 1).toUpperCase(), x + size / 2, y + size / 2, {
      size: Math.round(size * 0.46),
      weight: 'bold',
      color: INK.secondary,
      align: 'center',
      tracking: 0,
    });
    ctx.textBaseline = previousBaseline;
  }
}

/** 胶囊标签（版本 / 延迟）：半透明填充 + 细描边，宽高自适应 */
function drawChip(ctx, rightX, centerY, { text, size = 12.5, bars = null }) {
  const height = 24;
  const paddingX = 10;
  const gap = 7;

  const textWidth = measureRichText(ctx, text, { size, weight: 'normal', tracking: 0.3 });
  const barsWidth = bars ? 4 * 2.5 + 3 * 2 : 0;
  const innerWidth = (bars ? barsWidth + gap : 0) + textWidth;
  const width = innerWidth + paddingX * 2;
  const x = rightX - width;
  const y = centerY - height / 2;

  ctx.save();
  roundRectPath(ctx, x, y, width, height, height / 2);
  ctx.fillStyle = PALETTE.chipFill;
  ctx.fill();
  ctx.strokeStyle = PALETTE.chipStroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  let cursor = x + paddingX;
  if (bars) {
    const heights = [4, 6.5, 9, 11.5];
    for (let i = 0; i < heights.length; i += 1) {
      const barHeight = heights[i];
      const barX = cursor + i * 4.5;
      roundRectPath(ctx, barX, centerY + 5.5 - barHeight, 2.5, barHeight, 1.25);
      ctx.fillStyle = i < bars.level ? bars.color : INK.faint;
      ctx.fill();
    }
    cursor += barsWidth + gap;
  }

  drawRichText(ctx, text, cursor, centerY + 4.5, {
    size,
    color: INK.secondary,
    tracking: 0.3,
    align: 'left',
  });

  return width;
}

/** 延迟分档：与游戏里信号格一致（绿→黄→红） */
function pingLevel(latencyMs) {
  if (typeof latencyMs !== 'number') return { level: 0, color: PALETTE.offline };
  if (latencyMs < 80) return { level: 4, color: PALETTE.online };
  if (latencyMs < 150) return { level: 4, color: PALETTE.online };
  if (latencyMs < 300) return { level: 3, color: PALETTE.warning };
  if (latencyMs < 600) return { level: 2, color: PALETTE.warning };
  return { level: 1, color: PALETTE.offline };
}

/** 状态点：带柔光，像 iOS 的状态指示 */
function drawStatusDot(ctx, x, y, radius, color) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/* ------------------------------ 版面 ------------------------------------ */

/** 头部：图标 + 地址 + 软件信息；右侧版本 / 延迟胶囊 */
function drawHeader(ctx, status, text, iconEntry) {
  const { iconSize, iconY, addressBaseline, sublineBaseline } = RHYTHM;
  const iconX = CONTENT_X;

  drawTile(ctx, iconEntry ? iconEntry.image : null, status.displayName || status.host, iconX, iconY, iconSize, 14, {
    letter: true,
  });

  const addressX = iconX + iconSize + 16;
  // 有自定义名称时，名称完全取代地址（图上不会出现 IP:端口）
  const address = `${status.host}:${status.port}`;
  const title = status.displayName || address;

  // 右侧胶囊先算宽度，给地址留出空间
  const pingChipWidth = 60; // 估算占位，实际绘制时再精确
  const maxAddressWidth = CONTENT_RIGHT - addressX - pingChipWidth - 150;

  const addressSize = fitSize(ctx, title, {
    weight: 'bold',
    startSize: 25,
    minSize: 15,
    maxWidth: maxAddressWidth,
  });
  drawRichText(ctx, truncateRich(ctx, title, maxAddressWidth, { size: addressSize, weight: 'bold' }), addressX, addressBaseline, {
    size: addressSize,
    weight: 'bold',
    color: INK.primary,
  });

  // 次要行：只放软件 / 插件。有自定义名称时，地址完全不出现在图上。
  const subline = [
    status.software,
    status.software && status.plugins.length > 0 ? `${status.plugins.length} plugins` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  if (subline) {
    drawRichText(ctx, truncateRich(ctx, subline, maxAddressWidth, { size: 12.5 }), addressX, sublineBaseline, {
      size: 12.5,
      color: INK.tertiary,
      tracking: 0.2,
    });
  }

  // 右侧：延迟胶囊 + 版本胶囊（从右往左排）
  const centerY = iconY + iconSize / 2 - 8;
  let cursorRight = CONTENT_RIGHT;

  const ping = pingLevel(status.latencyMs);
  cursorRight -=
    drawChip(ctx, cursorRight, centerY, {
      text: typeof status.latencyMs === 'number' ? `${status.latencyMs} ms` : '--',
      size: 12.5,
      bars: ping,
    }) + 8;

  if (status.version) {
    drawChip(ctx, cursorRight, centerY, { text: status.version, size: 12.5 });
  }
}

/** 状态行：状态点 + 状态文字（左），玩家数（右） */
function drawStatusRow(ctx, status, text) {
  const isOnline = Boolean(status.online);
  const color = isOnline ? PALETTE.online : PALETTE.offline;
  const baseline = RHYTHM.statusBaseline;

  drawStatusDot(ctx, CONTENT_X + 6, baseline - 6, 5.5, color);

  drawRichText(ctx, isOnline ? text.online : text.offline, CONTENT_X + 22, baseline, {
    size: 19,
    weight: 'bold',
    color,
  });

  if (isOnline) {
    // 玩家数：数字做主，上限做次（层级靠透明度而不是字号）
    const max = ` / ${status.maxPlayers}`;
    const maxWidth = measureRichText(ctx, max, { size: 24, weight: 'medium' });
    drawRichText(ctx, max, CONTENT_RIGHT, baseline, {
      size: 24,
      weight: 'medium',
      color: INK.tertiary,
      align: 'right',
    });

    const playersWidth = measureRichText(ctx, String(status.players), { size: 24, weight: 'black' });
    drawRichText(ctx, String(status.players), CONTENT_RIGHT - maxWidth, baseline, {
      size: 24,
      weight: 'black',
      color: INK.primary,
      align: 'right',
    });

    drawRichText(ctx, text.players, CONTENT_RIGHT - maxWidth - playersWidth - 10, baseline - 1, {
      size: 13,
      color: INK.tertiary,
      // 注意：必须右对齐，否则标签会从左往右画、正好压在数字上
      align: 'right',
    });
  }
}

/** 在线：两行 MOTD（保留原版的两行结构） */
function drawMotd(ctx, status) {
  ctx.textBaseline = 'alphabetic';
  const size = 19;
  const options = { size, weight: 'light', color: INK.primary, tracking: 0.2 };

  const source = (Array.isArray(status.motdLines) && status.motdLines.length > 0
    ? status.motdLines
    : [status.motd || (status.online ? 'A Minecraft Server' : '')]
  ).filter((line) => String(line).trim().length > 0);

  const lines = [];
  for (const line of source) {
    for (const wrapped of wrapRich(ctx, line, CONTENT_WIDTH, 2 - lines.length, options)) {
      lines.push(wrapped);
      if (lines.length >= 2) break;
    }
    if (lines.length >= 2) break;
  }

  lines.forEach((line, index) => {
    drawRichText(ctx, line, CONTENT_X, RHYTHM.motdBaseline + index * RHYTHM.motdLineHeight, options);
  });
}

/** 在线：玩家区（标签 + 头像/名字网格） */
async function drawPlayers(ctx, status, text) {
  const playerList = Array.isArray(status.playerList) ? status.playerList : [];
  // 默认把所有人都画出来（每行个数不变，玩家多就加行），超过安全上限才截断
  const shown = playerList.slice(0, MAX_PLAYERS_RENDERED);
  const images = await loadAvatars(shown);

  const sourceLabel =
    status.playerListSource === 'query'
      ? text.sourceQuery
      : status.playerListSource === 'slp-sample'
        ? text.sourceSample
        : '';

  // 小节标签：小字号 + 放宽字距（Apple 的小字排版规则）
  const labelText = styleLabel(`${text.players}${sourceLabel ? `  ·  ${sourceLabel}` : ''}`);
  drawRichText(ctx, labelText, CONTENT_X, RHYTHM.captionBaseline, {
    size: 11,
    weight: 'medium',
    color: INK.quaternary,
    tracking: 0.9,
  });

  if (playerList.length > 0) {
    // 全部画得下就只报总数，被安全上限截断时才说「显示 x / y」
    const countLabel =
      shown.length < playerList.length
        ? text.showingOf(shown.length, playerList.length)
        : text.playersCount(playerList.length);
    drawRichText(ctx, countLabel, CONTENT_RIGHT, RHYTHM.captionBaseline, {
      size: 11,
      weight: 'medium',
      color: INK.quaternary,
      tracking: 0.9,
      align: 'right',
    });
  }

  if (shown.length === 0) {
    drawRichText(ctx, status.playerListSource ? text.noPlayers : text.noList, CONTENT_X, RHYTHM.chipRowTop + 18, {
      size: 14,
      color: INK.tertiary,
    });
    return;
  }

  const columnWidth = CONTENT_WIDTH / CHIPS_PER_ROW;
  shown.forEach((name, index) => {
    const row = Math.floor(index / CHIPS_PER_ROW);
    const column = index % CHIPS_PER_ROW;
    const x = CONTENT_X + column * columnWidth;
    const y = RHYTHM.chipRowTop + row * RHYTHM.chipRowHeight;

    // crop: false —— 头像不裁剪、不加边框，完整渲染（皮肤头本来就是方块）
    drawTile(ctx, images[index], name, x, y, CHIP_AVATAR, 7, { letter: true, crop: false });

    drawRichText(ctx, truncateRich(ctx, name, columnWidth - CHIP_AVATAR - 14, { size: 12.5 }), x + CHIP_AVATAR + 8, y + 19, {
      size: 12.5,
      color: INK.secondary,
      tracking: 0.1,
    });
  });
}

/** 离线：原因 + 排查提示（排版与在线版共用同一套节奏） */
function drawOfflineBody(ctx, status, text) {
  ctx.textBaseline = 'alphabetic';
  const size = 18;
  const options = { size, color: PALETTE.danger, tracking: 0.1 };

  wrapRich(ctx, describeError(status.errorCode, status.error), CONTENT_WIDTH, 2, options).forEach((line, index) => {
    drawRichText(ctx, line, CONTENT_X, RHYTHM.motdBaseline + index * leadingFor(size), options);
  });

  drawRichText(ctx, truncateRich(ctx, text.hint, CONTENT_WIDTH, { size: 13 }), CONTENT_X, RHYTHM.dividerBottom - 4, {
    size: 13,
    color: INK.tertiary,
  });
}

/** 底部小字：查询耗时 / 缓存 / 数据来源（放在卡片外的背景上，像图注） */
function drawFooter(ctx, status, text, canvasHeight = BANNER_HEIGHT) {
  const baseline = canvasHeight - 16;

  const timing = status.cached
    ? `${text.cacheHit}  ·  ${text.cached}`
    : `${text.queried} ${status.durationMs}ms  ·  ${text.cached}`;
  drawRichText(ctx, timing, CONTENT_X, baseline, {
    size: 11,
    color: INK.quaternary,
    tracking: 0.4,
  });

  if (status.online) {
    const sources = [
      status.protocol ? `${text.protocol} ${status.protocol}` : null,
      `Query ${status.sources.query ? '✓' : '✗'}  ·  SLP ${status.sources.ping ? '✓' : '✗'}`,
    ]
      .filter(Boolean)
      .join('  ·  ');
    drawRichText(ctx, sources, CONTENT_RIGHT, baseline, {
      size: 11,
      color: INK.quaternary,
      tracking: 0.4,
      align: 'right',
    });
  }
}

/* ------------------------------ 多服一览 -------------------------------- */

/** 一览图的版式（卡片高度随服务器数量变化） */
const OVERVIEW = {
  width: BANNER_WIDTH,
  cardY: 24,
  headerBlock: 118, // 卡片顶到第一行的距离
  rowHeight: 70, // 每台服务器占的高度（名称/MOTD + 一排头像）
  bottomPad: 18,
  rowIcon: 32,
  maxRows: 8,
  /** 每台服务器最多展示几个头像（只铺一排，不需要全量） */
  maxAvatars: 15,
  /** 一览里的头像尺寸 */
  avatarSize: 20,
  /** 头像之间的间距 */
  avatarGap: 3,
};

/** 多台服务器的环境色取平均；全离线时用默认色 */
function averageOfColors(colors) {
  if (colors.length === 0) return DEFAULT_AMBIENT;
  const sum = colors.reduce(
    (acc, color) => ({ r: acc.r + color.r, g: acc.g + color.g, b: acc.b + color.b }),
    { r: 0, g: 0, b: 0 }
  );
  return {
    r: Math.round(sum.r / colors.length),
    g: Math.round(sum.g / colors.length),
    b: Math.round(sum.b / colors.length),
  };
}

/** 行内的小信号格（3 格，比单服版更紧凑） */
function drawMiniBars(ctx, rightX, baseline, ping) {
  const widths = 2;
  const gap = 2;
  const heights = [4, 7, 10];
  const total = heights.length * widths + (heights.length - 1) * gap;

  for (let i = 0; i < heights.length; i += 1) {
    const x = rightX - total + i * (widths + gap);
    roundRectPath(ctx, x, baseline - heights[i], widths, heights[i], 1);
    ctx.fillStyle = i < Math.min(ping.level, 3) ? ping.color : INK.faint;
    ctx.fill();
  }
}

/** 一行服务器：状态点 + 图标 + 地址 + MOTD/错误 + 人数 + 延迟 */
function drawOverviewRow(ctx, status, iconEntry, rowTop, text, avatars = []) {
  const color = status.online ? PALETTE.online : PALETTE.offline;
  const textX = CONTENT_X + 18 + OVERVIEW.rowIcon + 12;
  const reserved = 104; // 右侧留给人数 / 延迟
  const maxTextWidth = CONTENT_RIGHT - textX - reserved;

  drawStatusDot(ctx, CONTENT_X + 4, rowTop + 16, 4, color);
  drawTile(
    ctx,
    iconEntry ? iconEntry.image : null,
    status.displayName || status.host,
    CONTENT_X + 18,
    rowTop + 7,
    OVERVIEW.rowIcon,
    8,
    { letter: true }
  );

  // 标题：有自定义名称就用名称（后面不再跟地址），否则用 host:port
  const address = `${status.host}:${status.port}`;
  const rowTitle = status.displayName || address;
  drawRichText(ctx, truncateRich(ctx, rowTitle, maxTextWidth, { size: 14.5, weight: 'bold' }), textX, rowTop + 20, {
    size: 14.5,
    weight: 'bold',
    color: INK.primary,
    tracking: -0.1,
  });

  const secondary = status.online
    ? status.motdLines?.[0] || status.motd || '—'
    : describeError(status.errorCode, status.error);
  drawRichText(ctx, truncateRich(ctx, secondary, maxTextWidth, { size: 12 }), textX, rowTop + 38, {
    size: 12,
    color: status.online ? INK.tertiary : PALETTE.danger,
    tracking: 0.1,
  });

  if (status.online) {
    drawRichText(ctx, `${status.players} / ${status.maxPlayers}`, CONTENT_RIGHT, rowTop + 20, {
      size: 15.5,
      weight: 'black',
      color: INK.primary,
      align: 'right',
      tracking: -0.2,
    });

    const latencyLabel = typeof status.latencyMs === 'number' ? `${status.latencyMs} ms` : '--';
    drawRichText(ctx, latencyLabel, CONTENT_RIGHT, rowTop + 38, {
      size: 11.5,
      color: INK.tertiary,
      align: 'right',
    });
    const labelWidth = measureRichText(ctx, latencyLabel, { size: 11.5 });
    drawMiniBars(ctx, CONTENT_RIGHT - labelWidth - 10, rowTop + 38, pingLevel(status.latencyMs));
  } else {
    drawRichText(ctx, text.offline, CONTENT_RIGHT, rowTop + 20, {
      size: 13,
      weight: 'bold',
      color: PALETTE.offline,
      align: 'right',
    });
  }

  // 一排头像（只铺一行、不显示玩家名）；没有皮肤的玩家画字母块，加载失败的留空
  if (avatars.length > 0) {
    const stripTop = rowTop + 44;
    avatars.forEach((avatar, index) => {
      if (!avatar) return;
      const x = textX + index * (OVERVIEW.avatarSize + OVERVIEW.avatarGap);
      // crop: false —— 和单服图一致，头像不裁剪、不加边框
      drawTile(ctx, avatar.image, avatar.name, x, stripTop, OVERVIEW.avatarSize, 0, { crop: false });
    });
  }
}

/**
 * 生成「多服一览」图：一行一台服务器，卡片高度随数量自适应。
 *
 * @param {object[]} statuses getStatus() 返回值的数组（顺序即展示顺序）
 * @param {object} [options]
 * @param {number} [options.outputScale] 输出倍数（默认 2 -> 1600 宽）
 * @returns {Promise<Buffer>} PNG 二进制
 */
export async function renderOverview(
  statuses,
  { outputScale = DEFAULT_OUTPUT_SCALE, elapsedMs = null, theme = DEFAULT_THEME, style = null } = {}
) {
  initFonts();
  setTheme(theme, style);
  const text = labels();

  const rows = statuses.slice(0, OVERVIEW.maxRows);
  const cardHeight = OVERVIEW.headerBlock + rows.length * OVERVIEW.rowHeight + OVERVIEW.bottomPad;
  const height = OVERVIEW.cardY + cardHeight + 46; // 卡片下方留出图注
  const renderScale = Math.max(SUPERSAMPLE, outputScale);

  activeRenderScale = renderScale;
  const canvas = createCanvas(OVERVIEW.width * renderScale, height * renderScale);
  const ctx = canvas.getContext('2d');
  ctx.scale(renderScale, renderScale);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // 图标与环境色：用所有在线服务器的图标平均色，整体色调跟随这批服务器
  // 头像：每台服务器只取前 N 个，铺一排（不需要全量，也不显示名字）
  const [icons, avatarRows] = await Promise.all([
    Promise.all(rows.map((status) => (status.online ? loadServerIcon(status) : null))),
    Promise.all(
      rows.map(async (status) => {
        if (!status.online || !avatarsEnabled()) return [];
        const list = Array.isArray(status.playerList) ? status.playerList : [];
        const picked = list.slice(0, OVERVIEW.maxAvatars);
        const images = await loadAvatars(picked, OVERVIEW.avatarSize);
        return images.map((image, index) => ({ image, name: picked[index] }));
      })
    ),
  ]);
  const ambient = averageOfColors(icons.filter(Boolean).map((entry) => entry.color));

  const card = {
    x: CARD.x,
    y: OVERVIEW.cardY,
    width: CARD.width,
    height: cardHeight,
    radius: CARD.radius,
  };

  drawBackground(ctx, ambient, OVERVIEW.width, height);
  drawCard(ctx, card);

  // 标题 + 汇总
  const onlineCount = rows.filter((status) => status.online).length;
  const offlineCount = rows.length - onlineCount;
  const totalPlayers = rows.reduce((sum, status) => sum + (status.online ? status.players : 0), 0);

  drawRichText(ctx, text.overviewTitle, CONTENT_X, OVERVIEW.cardY + 52, {
    size: 22,
    weight: 'bold',
    color: INK.primary,
  });

  const summary = [
    text.serversOnline(onlineCount, rows.length),
    text.playersTotal(totalPlayers),
    offlineCount > 0 ? text.serversOffline(offlineCount) : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  drawRichText(ctx, summary, CONTENT_X, OVERVIEW.cardY + 76, {
    size: 13,
    color: INK.tertiary,
    tracking: 0.2,
  });

  drawSoftDivider(ctx, OVERVIEW.cardY + OVERVIEW.headerBlock - 16);

  // 服务器行
  const rowsTop = OVERVIEW.cardY + OVERVIEW.headerBlock;
  rows.forEach((status, index) => {
    const rowTop = rowsTop + index * OVERVIEW.rowHeight;
    drawOverviewRow(ctx, status, icons[index], rowTop, text, avatarRows[index]);

    if (index < rows.length - 1) {
      drawSoftDivider(ctx, rowTop + OVERVIEW.rowHeight - 3, CONTENT_X + 18, CONTENT_RIGHT, 0.07);
    }
  });

  // 图注：这是整批查询的真实耗时（多台并行，不等于各行耗时之和）
  const elapsed =
    typeof elapsedMs === 'number'
      ? elapsedMs
      : rows.reduce((max, status) => Math.max(max, status.durationMs ?? 0), 0);
  const allCached = rows.length > 0 && rows.every((status) => status.cached);
  const timingLabel = allCached
    ? `${text.cacheHit}  ·  ${text.cached}`
    : `${text.queried} ${elapsed}ms  ·  ${text.cached}`;
  drawRichText(ctx, timingLabel, CONTENT_X, height - 16, {
    size: 11,
    weight: 'medium',
    color: INK.quaternary,
    tracking: 0.4,
  });
  drawRichText(ctx, `Query + SLP`, CONTENT_RIGHT, height - 16, {
    size: 11,
    color: INK.quaternary,
    tracking: 0.4,
    align: 'right',
  });

  return encodeCanvas(canvas, renderScale, outputScale);
}


/* ------------------------------ 布局变体 -------------------------------- */

/** 可用布局（?layout=） */
const LAYOUTS = {
  stack: { label: '标准 · 卡片堆叠（默认）' },
  compact: { label: '紧凑 · 单行头像条' },
  split: { label: '分栏 · 左信息右头像' },
};

const DEFAULT_LAYOUT = process.env.BANNER_LAYOUT || 'stack';

/** compact 的版式：卡片更矮，头像只铺一行 */
const COMPACT = {
  iconSize: 40,
  nameBaseline: 72,
  motdBaseline: 104,
  dividerY: 118,
  stripTop: 128,
  avatarSize: 22,
  avatarGap: 4,
  maxAvatars: 20,
  cardHeight: 154,
};

/**
 * 紧凑版：一行信息 + 一条头像带，高度固定 218（2 倍输出 436）。
 * 适合塞进签名、群公告这类地方。
 */
async function renderCompact(status, { outputScale = DEFAULT_OUTPUT_SCALE } = {}) {
  const text = labels();
  const height = CARD.y + COMPACT.cardHeight + 40;
  const renderScale = Math.max(SUPERSAMPLE, outputScale);
  activeRenderScale = renderScale;

  const canvas = createCanvas(BANNER_WIDTH * renderScale, height * renderScale);
  const ctx = canvas.getContext('2d');
  ctx.scale(renderScale, renderScale);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const iconEntry = status.online ? await loadServerIcon(status) : null;

  // 头像：只铺一行，按能放下的数量截断
  const playerList = Array.isArray(status.playerList) ? status.playerList : [];
  let avatars = [];
  if (status.online && playerList.length > 0) {
    const titleWidth = COMPACT.iconSize + 14 + 120;
    const maxFit = Math.floor(
      (CONTENT_RIGHT - CONTENT_X - titleWidth) / (COMPACT.avatarSize + COMPACT.avatarGap)
    );
    const picked = playerList.slice(0, Math.max(0, Math.min(COMPACT.maxAvatars, maxFit)));
    const images = await loadAvatars(picked, COMPACT.avatarSize);
    avatars = images.map((image, index) => ({ image, name: picked[index] }));
  }

  drawBackground(ctx, iconEntry ? iconEntry.color : DEFAULT_AMBIENT, BANNER_WIDTH, height);
  drawCard(ctx, { ...CARD, height: COMPACT.cardHeight });
  drawStyleDecorations(ctx, BANNER_WIDTH, height);

  // 图标
  drawTile(ctx, iconEntry ? iconEntry.image : null, status.displayName || status.host, CONTENT_X, 46, COMPACT.iconSize, 10, {
    letter: true,
  });

  // 右侧：状态点 + 状态 + 人数
  const statusColor = status.online ? PALETTE.online : PALETTE.offline;
  const countText = status.online ? `${status.players} / ${status.maxPlayers}` : text.offline;
  const countWidth = measureRichText(ctx, countText, { size: 16, weight: 'black' });
  const stateWidth = status.online ? measureRichText(ctx, text.online, { size: 14, weight: 'medium' }) : 0;
  const rightWidth = countWidth + (status.online ? stateWidth + 30 : 0);

  drawStatusDot(ctx, CONTENT_RIGHT - rightWidth + 4, COMPACT.nameBaseline - 6, 5, statusColor);
  drawRichText(ctx, countText, CONTENT_RIGHT, COMPACT.nameBaseline, {
    size: 16,
    weight: 'black',
    color: INK.primary,
    align: 'right',
    tracking: 0,
  });
  if (status.online) {
    drawRichText(ctx, text.online, CONTENT_RIGHT - countWidth - 20, COMPACT.nameBaseline - 1, {
      size: 14,
      weight: 'medium',
      color: statusColor,
      align: 'right',
    });
  }

  // 名称
  const titleX = CONTENT_X + COMPACT.iconSize + 14;
  const titleMax = CONTENT_RIGHT - titleX - rightWidth - 24;
  const title = status.displayName || `${status.host}:${status.port}`;
  const titleSize = fitSize(ctx, title, { weight: 'bold', startSize: 21, minSize: 14, maxWidth: titleMax });
  drawRichText(ctx, truncateRich(ctx, title, titleMax, { size: titleSize, weight: 'bold' }), titleX, COMPACT.nameBaseline, {
    size: titleSize,
    weight: 'bold',
    color: INK.primary,
  });

  // MOTD（一行）
  const motd = status.online
    ? status.motdLines?.[0] || status.motd || 'A Minecraft Server'
    : describeError(status.errorCode, status.error);
  drawRichText(ctx, truncateRich(ctx, motd, CONTENT_WIDTH, { size: 15 }), CONTENT_X, COMPACT.motdBaseline, {
    size: 15,
    color: status.online ? INK.secondary : PALETTE.danger,
    tracking: 0.1,
  });

  drawSoftDivider(ctx, COMPACT.dividerY);

  // 头像条
  avatars.forEach((avatar, index) => {
    const x = CONTENT_X + index * (COMPACT.avatarSize + COMPACT.avatarGap);
    drawTile(ctx, avatar.image, avatar.name, x, COMPACT.stripTop, COMPACT.avatarSize, 0, { crop: false });
  });

  // 图注
  const timing = status.cached
    ? `${text.cacheHit}  ·  ${text.cached}`
    : `${text.queried} ${status.durationMs}ms  ·  ${text.cached}`;
  drawRichText(ctx, timing, CONTENT_X, height - 16, { size: 11, color: INK.quaternary, tracking: 0.4 });

  return encodeCanvas(canvas, renderScale, outputScale);
}

/** split 的版式：左栏信息、右栏头像墙 */
const SPLIT = {
  leftRight: 356, // 左栏右边界
  dividerX: 384,
  avatarSize: 30,
  avatarGap: 6,
  minCardHeight: 336,
};

/**
 * 分栏版：左边是图标 / 名称 / MOTD / 状态，右边是玩家头像墙（不带名字，按列数换行）。
 */
async function renderSplit(status, { outputScale = DEFAULT_OUTPUT_SCALE } = {}) {
  const text = labels();
  const renderScale = Math.max(SUPERSAMPLE, outputScale);
  activeRenderScale = renderScale;

  const playerList = Array.isArray(status.playerList) ? status.playerList : [];
  const gridLeft = SPLIT.dividerX + 24;
  const columns = Math.max(1, Math.floor((CONTENT_RIGHT - gridLeft) / (SPLIT.avatarSize + SPLIT.avatarGap)));
  const shown = playerList.slice(0, MAX_PLAYERS_RENDERED);
  const rows = Math.max(1, Math.ceil(shown.length / columns));

  const cardHeight = Math.max(SPLIT.minCardHeight, 60 + rows * (SPLIT.avatarSize + SPLIT.avatarGap) + 24);
  const height = CARD.y + cardHeight + 40;

  const canvas = createCanvas(BANNER_WIDTH * renderScale, height * renderScale);
  const ctx = canvas.getContext('2d');
  ctx.scale(renderScale, renderScale);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const iconEntry = status.online ? await loadServerIcon(status) : null;
  const images = await loadAvatars(shown, SPLIT.avatarSize);

  drawBackground(ctx, iconEntry ? iconEntry.color : DEFAULT_AMBIENT, BANNER_WIDTH, height);
  drawCard(ctx, { ...CARD, height: cardHeight });
  drawStyleDecorations(ctx, BANNER_WIDTH, height);

  // 左栏：图标 + 名称 + MOTD + 状态
  drawTile(ctx, iconEntry ? iconEntry.image : null, status.displayName || status.host, CONTENT_X, 48, 56, 14, {
    letter: true,
  });

  const title = status.displayName || `${status.host}:${status.port}`;
  const leftMax = SPLIT.leftRight - CONTENT_X;
  const titleSize = fitSize(ctx, title, { weight: 'bold', startSize: 23, minSize: 14, maxWidth: leftMax });
  drawRichText(ctx, truncateRich(ctx, title, leftMax, { size: titleSize, weight: 'bold' }), CONTENT_X, 142, {
    size: titleSize,
    weight: 'bold',
    color: INK.primary,
  });

  if (status.software) {
    drawRichText(ctx, truncateRich(ctx, status.software, leftMax, { size: 12 }), CONTENT_X, 164, {
      size: 12,
      color: INK.quaternary,
      tracking: 0.2,
    });
  }

  const motdLines = status.online
    ? (Array.isArray(status.motdLines) && status.motdLines.length > 0
        ? status.motdLines
        : [status.motd || ''])
    : [describeError(status.errorCode, status.error)];
  const motdOptions = {
    size: 16,
    color: status.online ? INK.secondary : PALETTE.danger,
    tracking: 0.1,
  };
  const wrapped = [];
  for (const line of motdLines) {
    for (const item of wrapRich(ctx, line, leftMax, 3 - wrapped.length, motdOptions)) {
      wrapped.push(item);
      if (wrapped.length >= 3) break;
    }
    if (wrapped.length >= 3) break;
  }
  wrapped.forEach((line, index) => drawRichText(ctx, line, CONTENT_X, 200 + index * 24, motdOptions));

  // 状态 + 人数（左栏底部）
  const statusColor = status.online ? PALETTE.online : PALETTE.offline;
  drawStatusDot(ctx, CONTENT_X + 6, 300, 5.5, statusColor);
  drawRichText(ctx, status.online ? text.online : text.offline, CONTENT_X + 22, 306, {
    size: 17,
    weight: 'bold',
    color: statusColor,
  });

  if (status.online) {
    const maxText = ` / ${status.maxPlayers}`;
    const maxWidth = measureRichText(ctx, maxText, { size: 26, weight: 'medium' });
    drawRichText(ctx, maxText, SPLIT.leftRight - 8, 308, {
      size: 26,
      weight: 'medium',
      color: INK.tertiary,
      align: 'right',
    });
    drawRichText(ctx, String(status.players), SPLIT.leftRight - 8 - maxWidth, 308, {
      size: 26,
      weight: 'black',
      color: INK.primary,
      align: 'right',
    });
  }

  // 中间竖分隔
  ctx.save();
  const gradient = ctx.createLinearGradient(0, 60, 0, height - 80);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(0.3, activePalette.divider);
  gradient.addColorStop(0.7, activePalette.divider);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(SPLIT.dividerX + 0.5, 60);
  ctx.lineTo(SPLIT.dividerX + 0.5, height - 80);
  ctx.stroke();
  ctx.restore();

  // 右栏：头像墙（不带名字）
  if (shown.length === 0) {
    drawRichText(
      ctx,
      status.playerListSource ? text.noPlayers : text.noList,
      gridLeft,
      96,
      { size: 13, color: INK.tertiary }
    );
  } else {
    shown.forEach((name, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = gridLeft + column * (SPLIT.avatarSize + SPLIT.avatarGap);
      const y = 72 + row * (SPLIT.avatarSize + SPLIT.avatarGap);
      drawTile(ctx, images[index], name, x, y, SPLIT.avatarSize, 0, { crop: false });
    });
  }

  // 图注
  const timing = status.cached
    ? `${text.cacheHit}  ·  ${text.cached}`
    : `${text.queried} ${status.durationMs}ms  ·  ${text.cached}`;
  drawRichText(ctx, timing, CONTENT_X, height - 16, { size: 11, color: INK.quaternary, tracking: 0.4 });
  if (status.online) {
    drawRichText(ctx, text.playersCount(shown.length), CONTENT_RIGHT, height - 16, {
      size: 11,
      color: INK.quaternary,
      tracking: 0.4,
      align: 'right',
    });
  }

  return encodeCanvas(canvas, renderScale, outputScale);
}

/** 取某主题配套的布局（主题不存在时回退默认） */
function themeLayout(themeName) {
  return THEMES[themeName]?.layout ?? DEFAULT_LAYOUT;
}

/** 可用布局列表（给 /api/layouts 与参数报错用） */
function listLayouts() {
  return Object.entries(LAYOUTS).map(([name, layout]) => ({ name, label: layout.label }));
}

/* ------------------------------ 错误文案 -------------------------------- */

const ERROR_TEXT = {
  zh: {
    TIMEOUT: '连接超时：服务器没有在限定时间内响应',
    CONNECTION_ERROR: '无法建立 TCP 连接（服务器离线或端口未开放）',
    SOCKET_ERROR: 'UDP 套接字错误，无法完成查询',
    SEND_ERROR: 'UDP 数据包发送失败',
    BAD_CHALLENGE: '服务端返回了异常的 challenge token',
    BAD_RESPONSE: '服务端返回了无法解析的数据',
    UNKNOWN: '查询失败',
    HOST_REQUIRED: '缺少 host 参数，请提供服务器域名或 IP 地址',
    HOST_TOO_LONG: 'host 长度不能超过 253 个字符',
    HOST_INVALID: 'host 只能是域名或 IP，不能带协议前缀或路径',
    PORT_INVALID: 'port 必须是 1-65535 之间的整数',
    QUERYPORT_INVALID: 'queryPort 必须是 1-65535 之间的整数',
    TIMEOUT_INVALID: 'timeout 必须是 500-10000 之间的整数（毫秒）',
    SCALE_INVALID: 'scale 超出允许范围',
    THEME_INVALID: '未知主题，可用主题见 /api/themes',
    LAYOUT_INVALID: '未知布局，可用布局见 /api/layouts',
    STYLE_INVALID: '未知视觉语言，可用列表见 /api/styles',
    SERVERS_REQUIRED: '缺少 servers 参数：格式为 host[:port[:queryPort]]，多台用逗号分隔',
    TOO_MANY_SERVERS: '一次可查询的服务器数量超出上限',
    SERVER_ENTRY_INVALID: '服务器条目格式不正确',
    NAME_INVALID: '显示名称不合法（不能含换行或控制字符，最长 60 字符）',
  },
  en: {
    TIMEOUT: 'Timed out: the server did not respond in time',
    CONNECTION_ERROR: 'TCP connection failed (server offline or port closed)',
    SOCKET_ERROR: 'UDP socket error',
    SEND_ERROR: 'Failed to send UDP packet',
    BAD_CHALLENGE: 'Server returned an invalid challenge token',
    BAD_RESPONSE: 'Server returned an unparsable response',
    UNKNOWN: 'Query failed',
    HOST_REQUIRED: 'Missing required "host" parameter (domain name or IP address)',
    HOST_TOO_LONG: '"host" must not be longer than 253 characters',
    HOST_INVALID: '"host" must be a domain name or IP address (no protocol prefix, no path)',
    PORT_INVALID: '"port" must be an integer between 1 and 65535',
    QUERYPORT_INVALID: '"queryPort" must be an integer between 1 and 65535',
    TIMEOUT_INVALID: '"timeout" must be an integer between 500 and 10000 (ms)',
    SCALE_INVALID: '"scale" is out of range',
    THEME_INVALID: 'Unknown theme, see /api/themes',
    LAYOUT_INVALID: 'Unknown layout, see /api/layouts',
    STYLE_INVALID: 'Unknown visual style, see /api/styles',
    SERVERS_REQUIRED: 'Missing "servers" parameter: host[:port[:queryPort]], comma separated',
    TOO_MANY_SERVERS: 'Too many servers requested',
    SERVER_ENTRY_INVALID: 'Invalid server entry format',
    NAME_INVALID: '"name" is invalid (no newlines / control characters, max 60 characters)',
  },
};

function describeError(code, fallback = '') {
  const table = ERROR_TEXT[isChinese() ? 'zh' : 'en'];
  return table[code] || fallback || table.UNKNOWN;
}

/* ------------------------------- 对外接口 -------------------------------- */

/**
 * 生成状态图。
 * @param {object} status status.js 的 getStatus() 返回值
 * @returns {Promise<Buffer>} PNG 二进制
 */
export async function renderBanner(
  status,
  { outputScale = DEFAULT_OUTPUT_SCALE, theme = DEFAULT_THEME, layout = DEFAULT_LAYOUT, style = null } = {}
) {
  initFonts();
  setTheme(theme, style);
  const text = labels();

  // 布局派发（stack 是原来的标准版式）
  if (layout === 'compact') return renderCompact(status, { outputScale });
  if (layout === 'split') return renderSplit(status, { outputScale });

  // 高度自适应：玩家越多，行数越多，卡片和画布一起变高
  const playerCount = status.online && Array.isArray(status.playerList) ? status.playerList.length : 0;
  const playerRows = Math.max(1, Math.ceil(Math.min(playerCount, MAX_PLAYERS_RENDERED) / CHIPS_PER_ROW));
  const lastRowBottom = RHYTHM.chipRowTop + (playerRows - 1) * CHIP_ROW_HEIGHT + CHIP_AVATAR;
  const cardHeight = Math.max(CARD.height, lastRowBottom);
  const height = CARD.y + cardHeight + 40;
  const card = { ...CARD, height: cardHeight };

  // 超采样：先按 renderScale 栅格化，再降采样到目标尺寸
  const renderScale = Math.max(SUPERSAMPLE, outputScale);
  activeRenderScale = renderScale;
  const canvas = createCanvas(BANNER_WIDTH * renderScale, height * renderScale);
  const ctx = canvas.getContext('2d');
  ctx.scale(renderScale, renderScale);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const iconEntry = status.online ? await loadServerIcon(status) : null;
  drawBackground(ctx, iconEntry ? iconEntry.color : DEFAULT_AMBIENT, BANNER_WIDTH, height);
  drawCard(ctx, card);
  drawStyleDecorations(ctx, BANNER_WIDTH, height);

  drawHeader(ctx, status, text, iconEntry);
  drawStatusRow(ctx, status, text);

  if (status.online) {
    drawSoftDivider(ctx, RHYTHM.dividerTop);
    drawMotd(ctx, status);
    drawSoftDivider(ctx, RHYTHM.dividerBottom);
    await drawPlayers(ctx, status, text);
  } else {
    drawSoftDivider(ctx, RHYTHM.dividerTop);
    drawOfflineBody(ctx, status, text);
  }

  drawFooter(ctx, status, text, height);

  return encodeCanvas(canvas, renderScale, outputScale);
}

/**
 * 「错误说明」图：参数非法、渲染异常等场景，
 * 让 <img> 里始终有东西可看，而不是空白或 500。
 */
export async function renderMessageBanner(
  { kind = 'invalid', code = '', message = '', hint = '' },
  { outputScale = DEFAULT_OUTPUT_SCALE, theme = DEFAULT_THEME, style = null } = {}
) {
  initFonts();
  setTheme(theme, style);
  const text = labels();
  const title = kind === 'render-error' ? text.renderError : text.invalid;
  const body = kind === 'render-error' ? message : describeError(code, message);

  const renderScale = Math.max(SUPERSAMPLE, outputScale);
  activeRenderScale = renderScale;
  const canvas = createCanvas(BANNER_WIDTH * renderScale, BANNER_HEIGHT * renderScale);
  const ctx = canvas.getContext('2d');
  ctx.scale(renderScale, renderScale);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  drawBackground(ctx, DEFAULT_AMBIENT);
  drawCard(ctx);

  const titleColor = kind === 'render-error' ? PALETTE.offline : PALETTE.warning;
  drawStatusDot(ctx, CONTENT_X + 6, 118, 5.5, titleColor);
  drawRichText(ctx, title, CONTENT_X + 22, 124, { size: 19, weight: 'bold', color: titleColor });

  drawSoftDivider(ctx, RHYTHM.dividerTop - 10);

  const bodyOptions = { size: 17, color: INK.primary, tracking: 0.1 };
  wrapRich(ctx, body, CONTENT_WIDTH, 3, bodyOptions).forEach((line, index) => {
    drawRichText(ctx, line, CONTENT_X, 200 + index * leadingFor(17), bodyOptions);
  });

  if (hint) {
    drawRichText(ctx, truncateRich(ctx, hint, CONTENT_WIDTH, { size: 13 }), CONTENT_X, 276, {
      size: 13,
      color: INK.tertiary,
    });
  }

  drawRichText(ctx, '/api/banner.png?host=<host>&port=<port>&queryPort=<queryPort>', CONTENT_X, RHYTHM.footerBaseline, {
    size: 11,
    color: INK.quaternary,
    tracking: 0.4,
  });

  return encodeCanvas(canvas, renderScale, outputScale);
}

/**
 * 输出编码：
 *   renderScale == outputScale → 直接导出（此时是真正的高清图）
 *   否则降采样到 outputScale 倍 —— 这一步把 2x 的细节平均掉，边缘更顺滑
 */
function encodeCanvas(canvas, renderScale, outputScale) {
  if (renderScale === outputScale) return canvas.toBuffer('image/png');

  const target = createCanvas(canvas.width / renderScale * outputScale, canvas.height / renderScale * outputScale);
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, target.width, target.height);
  return target.toBuffer('image/png');
}

export {
  MAX_PLAYERS_RENDERED as MAX_AVATARS,
  OVERVIEW as OVERVIEW_LAYOUT,
  PALETTE,
  INK,
  CARD,
  DEFAULT_OUTPUT_SCALE,
  SUPERSAMPLE,
  DEFAULT_THEME,
  THEMES,
  listThemes,
  DEFAULT_LAYOUT,
  LAYOUTS,
  listLayouts,
  themeLayout,
  STYLES,
  describeTheme,
  listStyles,
  themeStyle,
  getFontDiagnostics,
};
