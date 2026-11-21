#!/usr/bin/env node
/**
 * 壁纸工坊 · Windows 桌面版构建编排
 *
 * 用法：
 *   node scripts/build-desktop.mjs render   # 只构建渲染层 → desktop/renderer/
 *   node scripts/build-desktop.mjs dist     # 只打包（需先 render）
 *   node scripts/build-desktop.mjs          # render + dist 一条龙
 *
 * render 阶段（复用 gh-pages 构建的成熟模式）：
 *   1. 暂移 src/app/api（静态导出不支持路由处理器）
 *   2. next build 静态导出（无 basePath、NEXT_PUBLIC_DESKTOP=1、独立 distDir，
 *      不影响 dev 服务器的 .next）
 *   3. 产物拷贝 desktop/renderer/，恢复 api 与 tsconfig（finally 兜底）
 *
 * dist 阶段：
 *   desktop/ 下 npm install（首次）+ electron-builder --win nsis --x64
 *   → release/desktop/WallpaperWorkshop-Setup-v<版本>.exe
 *
 * 网络说明（沙箱实测）：
 *   - npm 走 npmmirror registry（快）
 *   - Electron 二进制 / electron-builder 的 NSIS 工具链走 npmmirror 镜像
 *     （ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const DESKTOP_DIR = path.join(ROOT, "desktop");
const RENDERER_DIR = path.join(DESKTOP_DIR, "renderer");
const API_DIR = path.join(ROOT, "src", "app", "api");
const API_STASH = path.join(ROOT, ".api-stash");
const DIST_DIR_NAME = ".desktop-render-build";
const RELEASE_DIR = path.join(ROOT, "release", "desktop");
const EXE_PATH = path.join(RELEASE_DIR, `WallpaperWorkshop-Setup-v${APP_VERSION}.exe`);

/** npmmirror 镜像环境（Electron / electron-builder 二进制下载） */
const MIRROR_ENV = {
  ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

const mode = process.argv[2] || "all";
const step = (msg) => console.log(`\n[desktop] ${msg}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    throw new Error(`命令失败: ${cmd} ${args.join(" ")}（exit ${r.status}）`);
  }
}

function moveDir(from, to) {
  if (fs.existsSync(to)) {
    throw new Error(`目标已存在: ${to}（上次构建异常残留，请确认后手动删除再试）`);
  }
  fs.renameSync(from, to);
}

/** 导出构建期间给 tsconfig 追加 exclude（同 build-gh-pages.mjs 的处理） */
function patchTsconfigForExport() {
  const TSCONFIG = path.join(ROOT, "tsconfig.json");
  const raw = fs.readFileSync(TSCONFIG, "utf8");
  const json = JSON.parse(raw);
  const extra = [".next", DIST_DIR_NAME, "out", ".api-stash", "tool-results", "desktop"];
  json.exclude = [...new Set([...(json.exclude ?? []), ...extra])];
  fs.writeFileSync(TSCONFIG, JSON.stringify(json, null, 2) + "\n");
  return raw;
}

/* ------------------------------ 渲染层构建 ------------------------------ */

function buildRenderer() {
  step(`① 移走 src/app/api（静态导出不支持路由处理器）`);
  moveDir(API_DIR, API_STASH);

  let tsconfigOriginal;
  try {
    tsconfigOriginal = patchTsconfigForExport();

    step(`② Next.js 静态导出（无 basePath · NEXT_PUBLIC_DESKTOP=1 · v${APP_VERSION}）`);
    fs.rmSync(path.join(ROOT, DIST_DIR_NAME), { recursive: true, force: true });
    run("node", [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
      env: {
        ...process.env,
        NEXT_OUTPUT_EXPORT: "1",
        NEXT_DIST_DIR: DIST_DIR_NAME,
        NEXT_PUBLIC_DESKTOP: "1",
      },
    });

    step(`③ 拷贝产物 → desktop/renderer/`);
    const out = [path.join(ROOT, DIST_DIR_NAME), path.join(ROOT, "out")].find((p) =>
      fs.existsSync(path.join(p, "index.html"))
    );
    if (!out) throw new Error(`未找到导出 index.html（检查构建日志）`);
    fs.rmSync(RENDERER_DIR, { recursive: true, force: true });
    fs.cpSync(out, RENDERER_DIR, { recursive: true });
    const n = fs.readdirSync(path.join(RENDERER_DIR, "_next")).length;
    console.log(`    desktop/renderer/ 就绪（_next 下 ${n} 项，index.html ${(fs.statSync(path.join(RENDERER_DIR, "index.html")).size / 1024).toFixed(1)}KB）`);
  } finally {
    step(`④ 恢复 src/app/api 与 tsconfig.json`);
    if (fs.existsSync(API_STASH)) {
      fs.rmSync(API_DIR, { recursive: true, force: true });
      fs.renameSync(API_STASH, API_DIR);
    }
    if (tsconfigOriginal !== undefined) {
      fs.writeFileSync(path.join(ROOT, "tsconfig.json"), tsconfigOriginal);
    }
  }
}

/* -------------------------------- 打包 -------------------------------- */

function buildDist() {
  if (!fs.existsSync(path.join(RENDERER_DIR, "index.html"))) {
    throw new Error(`缺少 ${path.relative(ROOT, RENDERER_DIR)}/index.html，请先执行 render 阶段`);
  }
  if (!fs.existsSync(path.join(DESKTOP_DIR, "build", "icon.ico"))) {
    step(`⓪ 生成应用图标（首次）`);
    run("node", [path.join(ROOT, "scripts", "make-desktop-icon.mjs")]);
  }

  step(`⑤ desktop/ 安装依赖（首次较慢：Electron + electron-builder）`);
  if (!fs.existsSync(path.join(DESKTOP_DIR, "node_modules"))) {
    run("npm", ["install", "--no-audit", "--no-fund", "--registry=https://registry.npmmirror.com"], {
      cwd: DESKTOP_DIR,
      env: { ...process.env, ...MIRROR_ENV },
    });
  } else {
    console.log("    node_modules 已存在，跳过（删除后重跑可强制更新）");
  }

  if (process.platform !== "win32") {
    step(`⑤½ 修补 electron-builder：Linux 无 wine 时的卸载程序提取`);
    run("node", [path.join(ROOT, "scripts", "patch-electron-builder-linux.mjs")]);
  }

  step(`⑥ electron-builder 构建 Windows NSIS 安装包（x64）`);
  run(
    process.platform === "win32" ? "node_modules\\.bin\\electron-builder.cmd" : "node_modules/.bin/electron-builder",
    ["--win", "nsis", "--x64"],
    { cwd: DESKTOP_DIR, env: { ...process.env, ...MIRROR_ENV } }
  );

  if (!fs.existsSync(EXE_PATH)) {
    // 容错：找一下 release/desktop 下的实际 exe
    const found = fs
      .readdirSync(RELEASE_DIR)
      .filter((f) => f.endsWith(".exe"))
      .map((f) => path.join(RELEASE_DIR, f));
    if (found.length === 0) throw new Error(`未找到产物 exe（期望 ${EXE_PATH}）`);
    console.log(`    产物: ${found.join(" , ")}`);
    return;
  }
  const mb = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\n[desktop] 完成 ✔  ${path.relative(ROOT, EXE_PATH)}（约 ${mb} MB）`);
  console.log(`后续：node scripts/upload-release-desktop.mjs <token>  → Release v${APP_VERSION}`);
}

/* -------------------------------- 入口 -------------------------------- */

if (mode === "render" || mode === "all") buildRenderer();
if (mode === "dist" || mode === "all") buildDist();
