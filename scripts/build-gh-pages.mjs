#!/usr/bin/env node
/**
 * 壁纸工坊 · GitHub Pages 静态导出构建
 *
 * 用法（项目根目录执行）：
 *   node scripts/build-gh-pages.mjs /bizhi    # 子路径托管（本仓库 Pages 地址为 /bizhi/）
 *
 * 产物：
 * - github-pages-dist/（部署版：basePath=/bizhi，绝对路径，供 GitHub Pages）
 * - release/WallpaperWorkshop-Web-v<版本>.zip（离线版：根路径构建 + 相对路径改写，
 *   解压后双击 index.html 即可离线浏览，无需任何服务器）
 *
 * 原理：
 * 1. 临时移走 src/app/api（output: 'export' 不支持路由处理器）
 * 2. 构建 A（basePath=/bizhi，独立 distDir .gh-pages-build，不影响 dev 的 .next）
 *    → 拷到 github-pages-dist（部署用，绝对路径在 http 下正常）
 * 3. 构建 B（无 basePath，独立 distDir .gh-pages-offline）
 *    → 相对路径改写（HTML 的 "/_next/ → "_next/、href="/" → "./"、
 *      运行时 chunk 内部拼路径的 "/_next/" → "_next/"）→ zip 到 release/
 *    （双击 file:// 打开也能完整水合、正常加载壁纸 —— 已实测）
 * 4. 无论成败都恢复 api 目录与 tsconfig（finally）
 *
 * 静态版运行时行为（见 src/lib/workshop-source.ts）：
 * - 浏览器直连哲风源站抓取（源站 CORS 全开）解析壁纸列表
 * - 图片直连 CDN（页面全局 no-referrer 绕过防盗链）
 * - 下载：CDN 取图 blob → 浏览器另存；记录存 localStorage（永久、可屏蔽）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const API_DIR = path.join(ROOT, "src", "app", "api");
const API_STASH = path.join(ROOT, ".api-stash");
const DIST_DIR_NAME = ".gh-pages-build";
const OFFLINE_DIR_NAME = ".gh-pages-offline";
const OUT_DIR = path.join(ROOT, "github-pages-dist");
const RELEASE_DIR = path.join(ROOT, "release");
const ZIP_PATH = path.join(RELEASE_DIR, `WallpaperWorkshop-Web-v${APP_VERSION}.zip`);

const step = (msg) => console.log(`\n[gh-pages] ${msg}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    // 抛异常而非 process.exit：确保外层 finally 恢复 api 目录与 tsconfig
    throw new Error(`命令失败: ${cmd} ${args.join(" ")}（exit ${r.status}）`);
  }
}

function moveDir(from, to) {
  if (fs.existsSync(to)) {
    throw new Error(
      `目标已存在: ${to}（上次构建异常残留，请先确认后手动删除再试）`
    );
  }
  fs.renameSync(from, to);
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return (total / 1024 / 1024).toFixed(2);
}

const basePath = process.argv[2] || "";
if (basePath && !basePath.startsWith("/")) {
  console.error("[gh-pages] 子路径必须以 / 开头，例如：node scripts/build-gh-pages.mjs /bizhi");
  process.exit(1);
}

/** 导出构建期间给 tsconfig 追加 exclude：陈旧的构建产物类型
 *（.next 里旧 dev 构建生成的路由类型）会引用被移走的 src/app/api
 * 导致 TS2307；它们是产物目录，本就不该参与类型检查。 */
function patchTsconfigForExport() {
  const TSCONFIG = path.join(ROOT, "tsconfig.json");
  const raw = fs.readFileSync(TSCONFIG, "utf8");
  const json = JSON.parse(raw);
  const extra = [".next", ".gh-pages-build", ".gh-pages-offline", "out", ".api-stash", "tool-results"];
  const exclude = new Set([...(json.exclude ?? []), ...extra]);
  json.exclude = [...exclude];
  fs.writeFileSync(TSCONFIG, JSON.stringify(json, null, 2) + "\n");
  return raw; // 原文返回，构建后恢复
}

/** 定位某个导出构建的产物目录（Next 16 自定义 distDir 时导出产物就是 distDir 本身） */
function locateExport(dirName) {
  const candidates = [
    path.join(ROOT, dirName),
    path.join(ROOT, "out"),
    path.join(ROOT, dirName, "export"),
  ];
  const found = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
  if (!found) {
    throw new Error(
      `未找到导出 index.html，尝试过: ${candidates.join(" , ")}（Next 版本导出目录行为变化，请检查构建日志）`
    );
  }
  return found;
}

/**
 * 离线版相对路径改写：让根路径构建在 file://（双击 index.html）下可用。
 * - HTML："/_next/ → "_next/（script/link 引用 + 内联 flight 数据）；
 *   href="/" → href="./"（站点 Logo 链接，避免跳到文件系统根）
 * - JS chunk："/_next/" → "_next/"（Next 运行时拼接动态 chunk / 预取的
 *   绝对路径，不改写则 file:// 下解析到文件系统根 → 动态 import 失败 →
 *   水合永远停滞；已实测改写后 file:// 完整可用）
 * - CSS 字体已是相对路径（url(../media/…)），无需处理
 */
function rewriteForOffline(dir) {
  let htmlCount = 0;
  let jsCount = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (e.name.endsWith(".html")) {
        let s = fs.readFileSync(full, "utf8");
        const before = s;
        // 注意：JS 的 replace(字符串) 只替换第一处，必须 replaceAll
        s = s.replaceAll('"/_next/', '"_next/').replaceAll("('/_next/", "('_next/");
        s = s.replaceAll('href="/"', 'href="./"');
        if (s !== before) {
          fs.writeFileSync(full, s);
          htmlCount += 1;
        }
      } else if (e.name.endsWith(".js")) {
        let s = fs.readFileSync(full, "utf8");
        if (s.includes('"/_next/"')) {
          s = s.replaceAll('"/_next/"', '"_next/"');
          fs.writeFileSync(full, s);
          jsCount += 1;
        }
      }
    }
  };
  walk(dir);
  console.log(`    改写 ${htmlCount} 个 HTML、${jsCount} 个运行时 chunk → 相对路径`);
}

step("① 移走 src/app/api（静态导出不支持路由处理器）");
moveDir(API_DIR, API_STASH);

let tsconfigOriginal;
try {
  tsconfigOriginal = patchTsconfigForExport();

  step(`② Next.js 静态导出构建 A（部署版，basePath: ${basePath || "/"}，版本 v${APP_VERSION}）`);
  run("node", [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
    env: {
      ...process.env,
      NEXT_OUTPUT_EXPORT: "1",
      NEXT_DIST_DIR: DIST_DIR_NAME,
      ...(basePath ? { GH_BASE_PATH: basePath } : {}),
    },
  });

  step("③ 定位并拷贝部署版产物");
  const found = locateExport(DIST_DIR_NAME);
  copyDir(found, OUT_DIR);
  if (found !== path.join(ROOT, "out")) fs.rmSync(path.join(ROOT, "out"), { recursive: true, force: true });

  // GitHub Pages 跳过 Jekyll 处理（下划线开头目录 / 特殊文件需要）
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");

  // 仓库说明页（部署后在 GitHub 仓库首页展示）
  const REPO_README = `# 壁纸工坊 · 网页版（GitHub Pages 自动部署）

本仓库是「壁纸工坊」的纯静态网页版，由部署脚本自动推送，站点地址：

**https://xiaobaiba999.github.io${basePath || "/"}**

## Windows 桌面版（v1.4.7 新增）

除本网页版外，还提供 **Windows 桌面安装版**（Electron，Win10/11 x64）：
见 **[Releases](https://github.com/xiaobaiba999/bizhi/releases/latest)** 下载
\`WallpaperWorkshop-Setup-v${APP_VERSION}.exe\`（约 97MB）—— 向导式安装，
壁纸自动保存到「图片 / WallpaperWorkshop」并弹系统通知，记录独立持久。

## 网页版功能

- **电脑壁纸 / 手机壁纸**两大频道：浏览器直连哲风壁纸源站实时抓取，
  可一路滚动加载源站全部壁纸（电脑约 2 万张、手机约 1 万张）
- **下载**：直连 CDN 取原图 → 浏览器另存（Chrome / Edge 可自选保存文件夹）
- **下载记录永久保存**：记录存在浏览器 localStorage，刷新页面不丢；
  「隐藏已下载」自动屏蔽已下载过的壁纸；屏蔽的永久不再显示
- **v1.4.5 核心修复**：游标深度扫描 —— 下载过几百张后依旧能自动
  越过已下载/已屏蔽内容继续出图，不再「图片经常不显示 / 刷新没用」
- **v1.4.6 优化**：刷新强制回源 + 空轮自动续扫（最多 200 页）；
  死链缩略图回退链秒级兜底

## 下载网页版离线压缩包

见仓库 **[Releases](https://github.com/xiaobaiba999/bizhi/releases)**：

- \`WallpaperWorkshop-Web-v${APP_VERSION}.zip\`（约 0.5MB）—— 本静态网页版的离线压缩包，
  解压后**双击 index.html 即可用**（无需服务器；壁纸加载需联网）

## 仓库结构

- \`main\` 分支：即本静态站点（\`index.html\` / \`_next/\` 等），
  由项目源码执行 \`node scripts/build-gh-pages.mjs ${basePath || ""}\` 构建产出，
  再通过 GitHub REST API 一键推送（见源码项目 \`scripts/deploy-to-github.mjs\`）
- \`source\` 分支：完整项目源码快照（Next.js 16 + Prisma + Tailwind 4 +
  Electron 桌面版），由 \`node scripts/push-source-to-github.mjs\` 推送

> 本站以 \`${basePath || "/"}\` 子路径托管构建，请勿改名或移动文件，否则资源路径会失效。
`;
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), REPO_README);

  const files = countFiles(OUT_DIR);
  const sizeMB = dirSizeMB(OUT_DIR);
  step(`部署版完成 ✔  产物: github-pages-dist/（${files} 个文件，约 ${sizeMB} MB）`);

  // —— 构建 B：离线版（根路径 + 相对路径改写，双击 index.html 即用） ——
  step(`④ Next.js 静态导出构建 B（离线版，根路径）`);
  fs.rmSync(path.join(ROOT, OFFLINE_DIR_NAME), { recursive: true, force: true });
  run("node", [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
    env: {
      ...process.env,
      NEXT_OUTPUT_EXPORT: "1",
      NEXT_DIST_DIR: OFFLINE_DIR_NAME,
    },
  });
  const offlineDir = locateExport(OFFLINE_DIR_NAME);
  step("⑤ 离线版相对路径改写（file:// 双击可用）");
  rewriteForOffline(offlineDir);

  step(`⑥ 打包网页版离线压缩包 → ${path.relative(ROOT, ZIP_PATH)}`);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.rmSync(ZIP_PATH, { force: true });
  run("zip", ["-r", "-q", "-9", ZIP_PATH, ".", "-x", ".DS_Store"], { cwd: offlineDir });
  const zipMB = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`    ${path.relative(ROOT, ZIP_PATH)}（约 ${zipMB} MB，解压后双击 index.html 即用）`);
  // 离线构建临时目录功成身退
  fs.rmSync(path.join(ROOT, OFFLINE_DIR_NAME), { recursive: true, force: true });

  console.log(`
后续部署（沙箱内 git push 通道被阻断，须走 REST API 脚本）：
  node scripts/deploy-to-github.mjs <token>        # → main 分支（GitHub Pages）
  node scripts/push-source-to-github.mjs <token>   # → source 分支（源码备份）
  node scripts/upload-release-to-github.mjs <token># → Release v${APP_VERSION} 附件（web zip）
  （token 也可用 env GITHUB_TOKEN 或 ~/.bizhi-token 文件提供）
`);
} finally {
  step("⑦ 恢复 src/app/api 与 tsconfig.json");
  if (fs.existsSync(API_STASH)) {
    fs.rmSync(API_DIR, { recursive: true, force: true });
    fs.renameSync(API_STASH, API_DIR);
  }
  if (tsconfigOriginal !== undefined) {
    fs.writeFileSync(path.join(ROOT, "tsconfig.json"), tsconfigOriginal);
  }
}
