#!/usr/bin/env node
/**
 * 壁纸工坊 · GitHub Pages 静态导出构建
 *
 * 用法（项目根目录执行）：
 *   node scripts/build-gh-pages.mjs                # 根路径托管（username.github.io 仓库）
 *   node scripts/build-gh-pages.mjs /wallpaper     # 子路径托管（项目仓库，Pages 地址为 /wallpaper）
 *
 * 产物：github-pages-dist/（完整静态站点，含 .nojekyll）
 *
 * 原理：
 * 1. 临时移走 src/app/api（output: 'export' 不支持路由处理器）与
 *    src/instrumentation.ts（服务器启动钩子，动态引入 Prisma，静态包不应带）
 * 2. 以 NEXT_OUTPUT_EXPORT=1 + 独立 distDir 构建（不影响 dev:3000 的 .next）
 * 3. 找到导出目录（out / <distDir>/export / <distDir>）→ 拷到 github-pages-dist
 * 4. 无论成败都恢复 api 目录（finally）
 *
 * 静态版运行时行为（见 src/lib/workshop-source.ts）：
 * - 浏览器直连哲风源站抓取（源站 CORS 全开）解析壁纸列表
 * - 图片直连 CDN（页面全局 no-referrer 绕过防盗链）
 * - 下载：CDN 取图 → 画布转 JPG → 浏览器另存；记录存 localStorage（永久、可屏蔽）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const API_DIR = path.join(ROOT, "src", "app", "api");
const API_STASH = path.join(ROOT, ".api-stash");
/** instrumentation.ts：服务器启动钩子（Prisma 动态引入 + SQLite 修补），静态包不应包含 */
const INSTR_FILE = path.join(ROOT, "src", "instrumentation.ts");
const INSTR_STASH = path.join(ROOT, ".instrumentation-stash.ts");
/** 桌面安装包不入静态站点（173MB 超 GitHub 单文件 100MB 限制，也无意义） */
const DESKTOP_DIR = path.join(ROOT, "public", "desktop");
const DESKTOP_STASH = path.join(ROOT, ".desktop-stash");
/** 网页版 zip 不入静态站点（避免 zip 套 zip 递归膨胀）；每次构建后放回 public/ */
const ZIP_STASH = path.join(ROOT, ".zip-stash");
const DIST_DIR_NAME = ".gh-pages-build";
const OUT_DIR = path.join(ROOT, "github-pages-dist");

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

const basePath = process.argv[2] || "";
if (basePath && !basePath.startsWith("/")) {
  console.error("[gh-pages] 子路径必须以 / 开头，例如：node scripts/build-gh-pages.mjs /wallpaper");
  process.exit(1);
}

/** 导出构建期间给 tsconfig 追加 exclude：陈旧的构建产物类型
 *（.next-desktop / .next 里旧 dev/桌面构建生成的路由类型）会引用被移走的
 * src/app/api 导致 TS2307；它们是产物目录，本就不该参与类型检查。 */
function patchTsconfigForExport() {
  const TSCONFIG = path.join(ROOT, "tsconfig.json");
  const raw = fs.readFileSync(TSCONFIG, "utf8");
  const json = JSON.parse(raw);
  const extra = [".next", ".next-desktop", ".gh-pages-build", "out", ".api-stash", ".instrumentation-stash.ts"];
  const exclude = new Set([...(json.exclude ?? []), ...extra]);
  json.exclude = [...exclude];
  fs.writeFileSync(TSCONFIG, JSON.stringify(json, null, 2) + "\n");
  return raw; // 原文返回，构建后恢复
}

step("① 移走 src/app/api 与 src/instrumentation.ts（静态导出不支持路由处理器 / 服务器钩子）、public/desktop（安装包）与 public/*.zip（避免递归嵌套）");
moveDir(API_DIR, API_STASH);
if (fs.existsSync(INSTR_FILE)) fs.renameSync(INSTR_FILE, INSTR_STASH);
if (fs.existsSync(DESKTOP_DIR)) moveDir(DESKTOP_DIR, DESKTOP_STASH);
fs.mkdirSync(ZIP_STASH, { recursive: true });
const zippedBack = [];
for (const e of fs.readdirSync(path.join(ROOT, "public"))) {
  if (e.endsWith(".zip")) {
    fs.renameSync(path.join(ROOT, "public", e), path.join(ZIP_STASH, e));
    zippedBack.push(e);
  }
}

let tsconfigOriginal;
try {
  tsconfigOriginal = patchTsconfigForExport();

  step(`② Next.js 静态导出构建（basePath: ${basePath || "/"}）`);
  run("node", [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
    env: {
      ...process.env,
      NEXT_OUTPUT_EXPORT: "1",
      NEXT_DIST_DIR: DIST_DIR_NAME,
      ...(basePath ? { GH_BASE_PATH: basePath } : {}),
    },
  });

  // 定位导出目录：Next 16 自定义 distDir 时导出产物就是 distDir 本身
  step("③ 定位并拷贝导出产物");
  const candidates = [
    path.join(ROOT, DIST_DIR_NAME),
    path.join(ROOT, "out"),
    path.join(ROOT, DIST_DIR_NAME, "export"),
  ];
  const found = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
  if (!found) {
    throw new Error(
      `未找到导出 index.html，尝试过: ${candidates.join(" , ")}（Next 版本导出目录行为变化，请检查构建日志）`
    );
  }

  copyDir(found, OUT_DIR);
  fs.rmSync(path.join(ROOT, "out"), { recursive: true, force: true });

  // GitHub Pages 跳过 Jekyll 处理（下划线开头目录 / 特殊文件需要）
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");

  // 仓库说明页（部署后在 GitHub 仓库首页展示）
  const REPO_README = `# 壁纸工坊 · 网页版（GitHub Pages 自动部署）

本仓库是「壁纸工坊」的纯静态网页版，由部署脚本自动推送，站点地址：

**https://xiaobaiba999.github.io${basePath || "/"}**

## 功能

- **电脑壁纸 / 手机壁纸**两大频道：浏览器直连哲风壁纸源站实时抓取，
  可一路滚动加载源站全部壁纸（电脑约 2 万张、手机约 1 万张）
- **下载**：直连 CDN 取原图 → 统一转存 JPG → 浏览器另存（Chrome / Edge
  可自选保存文件夹）
- **下载记录永久保存**：记录存在浏览器 localStorage，刷新 / 重装应用
  都不丢；点「隐藏已下载」自动屏蔽已下载过的壁纸
- **PWA 安装**：Chrome / Edge 地址栏「安装」即可装成独立窗口应用，
  正常卸载不留残留

## 下载桌面安装版 / 网页版压缩包

见仓库 **[Releases](https://github.com/xiaobaiba999/bizhi/releases)**：

- \`WallpaperWorkshop-Setup-v${APP_VERSION}.exe\`（约 167MB）—— Windows 桌面安装版，
  下载记录 / 屏蔽记录永久保存在用户数据目录（升级重装都自动护送恢复）
- \`WallpaperWorkshop-Web-v${APP_VERSION}.zip\`（约 0.9MB）—— 本静态网页版的离线压缩包

## 仓库结构

- \`main\` 分支：即本静态站点（\`index.html\` / \`_next/\` / \`sw.js\` 等），
  由项目源码执行 \`node scripts/build-gh-pages.mjs ${basePath || ""}\` 构建产出，
  再通过 GitHub REST API 一键推送（见源码项目 \`scripts/deploy-to-github.mjs\`）
- \`source\` 分支：完整项目源码快照（Next.js 16 + Electron + NSIS），
  由 \`node scripts/push-source-to-github.mjs\` 推送

> 本站以 \`${basePath || "/"}\` 子路径托管构建，请勿改名或移动文件，否则资源路径会失效。
`;
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), REPO_README);

  // 子路径托管：重写 PWA 清单（start_url / scope / id / 图标路径），
  // 否则安装后的 PWA 会指向根路径 404
  if (basePath) {
    const mfPath = path.join(OUT_DIR, "manifest.webmanifest");
    if (fs.existsSync(mfPath)) {
      const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
      mf.id = `${basePath}/`;
      mf.start_url = `${basePath}/`;
      mf.scope = `${basePath}/`;
      if (Array.isArray(mf.icons)) {
        for (const icon of mf.icons) {
          if (typeof icon.src === "string" && icon.src.startsWith("/")) {
            icon.src = `${basePath}${icon.src}`;
          }
        }
      }
      fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");
      step(`已重写 manifest.webmanifest（start_url / scope / 图标 → ${basePath}）`);
    }
  }

  const files = countFiles(OUT_DIR);
  const sizeMB =
    countFiles(OUT_DIR) &&
    (() => {
      let total = 0;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else total += fs.statSync(full).size;
        }
      };
      walk(OUT_DIR);
      return (total / 1024 / 1024).toFixed(1);
    })();

  step(`完成 ✔  产物: github-pages-dist/（${files} 个文件，约 ${sizeMB} MB）`);
  console.log(`
后续部署（二选一）：
  A. 网页上传：github.com 新建仓库 → 「uploading an existing file」拖入 github-pages-dist 内全部内容
  B. 命令行：
       cd github-pages-dist
       git init -b main && git add -A && git commit -m "deploy"
       git remote add origin https://github.com/<用户名>/<仓库名>.git
       git push -u origin main
  然后仓库 Settings → Pages → Deploy from a branch → main /(root)
${basePath ? `  注意：本项目以子路径 ${basePath} 托管构建，仓库须同名或 Pages 地址一致` : "  提示：仓库命名为 <用户名>.github.io 可从根路径访问，效果最佳"}
`);
} finally {
  step("④ 恢复 src/app/api、src/instrumentation.ts、public/desktop、public/*.zip 与 tsconfig.json");
  if (fs.existsSync(API_STASH)) {
    fs.rmSync(API_DIR, { recursive: true, force: true });
    fs.renameSync(API_STASH, API_DIR);
  }
  if (fs.existsSync(INSTR_STASH)) {
    fs.rmSync(INSTR_FILE, { force: true });
    fs.renameSync(INSTR_STASH, INSTR_FILE);
  }
  if (fs.existsSync(DESKTOP_STASH)) {
    fs.rmSync(DESKTOP_DIR, { recursive: true, force: true });
    fs.renameSync(DESKTOP_STASH, DESKTOP_DIR);
  }
  for (const e of zippedBack) {
    fs.renameSync(path.join(ZIP_STASH, e), path.join(ROOT, "public", e));
  }
  if (fs.existsSync(ZIP_STASH)) fs.rmSync(ZIP_STASH, { recursive: true, force: true });
  if (tsconfigOriginal !== undefined) {
    fs.writeFileSync(path.join(ROOT, "tsconfig.json"), tsconfigOriginal);
  }
}
