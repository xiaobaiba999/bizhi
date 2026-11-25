#!/usr/bin/env node
/**
 * 壁纸工坊 · 桌面版图标生成
 *
 * 用法：node scripts/make-desktop-icon.mjs
 *
 * 设计：玫瑰红渐变圆角方块 + 白色「壁」字（与网页版顶栏徽标一致的品牌语言），
 *       右上叠一层柔光、底部一抹雪山水纹，呼应「壁纸」属性。
 *
 * 产物：
 * - desktop/build/icon.png   512×512（Linux 运行 / BrowserWindow 图标 / 打包回退）
 * - desktop/build/icon.ico   多尺寸（16/24/32/48/64/128/256，PNG-in-ICO，
 *                             Vista+ 原生支持，electron-builder 直接可用）
 *
 * 依赖：项目根 node_modules 的 sharp（librsvg 渲染 SVG；中文字体用系统
 *       Noto Sans SC Bold —— 沙箱已装；其他环境需自备 CJK 字体）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(ROOT, "desktop", "build");
const PNG_PATH = path.join(BUILD_DIR, "icon.png");
const ICO_PATH = path.join(BUILD_DIR, "icon.ico");

/** 应用图标 SVG（512 画布；「壁」用 Noto Sans SC，缺字体时回退文泉驿） */
const ICON_SVG = String.raw`
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fb7185"/>
      <stop offset="0.45" stop-color="#f43f5e"/>
      <stop offset="1" stop-color="#9f1239"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.72" cy="0.2" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="round"><rect x="16" y="16" width="480" height="480" rx="112"/></clipPath>
  </defs>

  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <g clip-path="url(#round)">
    <rect x="16" y="16" width="480" height="480" fill="url(#sheen)"/>
    <!-- 底部雪山剪影（壁纸意象） -->
    <path d="M16 402 L142 302 L232 372 L318 286 L418 380 L496 322 L496 496 L16 496 Z"
          fill="#ffffff" fill-opacity="0.13"/>
    <path d="M16 448 L150 356 L262 434 L372 362 L496 438 L496 496 L16 496 Z"
          fill="#ffffff" fill-opacity="0.10"/>
  </g>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="none"
        stroke="#ffffff" stroke-opacity="0.22" stroke-width="6"/>

  <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
        font-family="Noto Sans SC, WenQuanYi Zen Hei, sans-serif" font-weight="700"
        font-size="296" fill="#ffffff">壁</text>
</svg>
`;

/** ICO 组装：PNG-in-ICO（Vista+ 支持，electron-builder/资源管理器通用） */
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  const datas = [];
  let offset = 6 + 16 * count;
  for (const { size, png } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 宽（0 = 256）
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // 高
    entry.writeUInt8(0, 2); // 调色板数
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // 数据长度
    entry.writeUInt32LE(offset, 12); // 数据偏移
    entries.push(entry);
    datas.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const svg = Buffer.from(ICON_SVG);

  // 512 主图
  const png512 = await sharp(svg, { density: 96 }).resize(512, 512).png().toBuffer();
  fs.writeFileSync(PNG_PATH, png512);
  console.log(`[icon] ${path.relative(ROOT, PNG_PATH)}（512×512，${(png512.length / 1024).toFixed(1)}KB）`);

  // 多尺寸 ICO
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const png = await sharp(svg, { density: Math.max(96, Math.round((size / 512) * 384)) })
      .resize(size, size)
      .png()
      .toBuffer();
    pngs.push({ size, png });
    process.stdout.write(`    ${size}px:${(png.length / 1024).toFixed(1)}KB  `);
  }
  console.log();
  const ico = buildIco(pngs);
  fs.writeFileSync(ICO_PATH, ico);
  console.log(`[icon] ${path.relative(ROOT, ICO_PATH)}（${sizes.join("/")}px，${(ico.length / 1024).toFixed(1)}KB）`);
  console.log("[icon] 完成 ✔（建议肉眼核对 desktop/build/icon.png）");
}

main().catch((e) => {
  console.error(`[icon] 失败：${e.message}`);
  process.exit(1);
});
