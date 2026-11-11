#!/usr/bin/env node
/**
 * 壁纸工坊 · 桌面版打包流水线
 *
 * 用法（在项目根目录执行）：
 *   node scripts/build-desktop.mjs --assemble   生产构建 Next(standalone) + 组装 release/resources
 *   node scripts/build-desktop.mjs --linux      组装 + Linux 解包版（本地冒烟测试）
 *   node scripts/build-desktop.mjs --win        组装 + Windows NSIS 安装包（exe）
 *
 * 环境说明：沙箱通过 npmmirror 镜像下载 Electron 与 NSIS 工具链
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, ".next-desktop");
const SERVER_OUT = path.join(ROOT, "release", "resources", "server");
const EMPTY_DB = path.join(ROOT, "release", "resources", "empty.db");

const MIRROR_ENV = {
  ELECTRON_MIRROR: "https://registry.npmmirror.com/-/binary/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://registry.npmmirror.com/-/binary/electron-builder-binaries/",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
};

const step = (msg) => console.log(`\n\x1b[35m[desktop-build]\x1b[0m ${msg}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`\x1b[31m[desktop-build] 命令失败: ${cmd} ${args.join(" ")}\x1b[0m`);
    process.exit(r.status ?? 1);
  }
}

function sizeMB(p) {
  const walk = (dir) => {
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += walk(full);
      else total += fs.statSync(full).size;
    }
    return total;
  };
  const stat = fs.statSync(p);
  return (stat.isDirectory() ? walk(p) : stat.size) / 1024 / 1024;
}

/* ---------- ① 生产构建（standalone，独立 distDir，不影响 dev:3000） ---------- */

function buildNext() {
  step("Next.js 生产构建（standalone → .next-desktop）");
  run("node", [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
    env: {
      ...process.env,
      NEXT_OUTPUT_STANDALONE: "1",
      NEXT_DIST_DIR: ".next-desktop",
    },
  });
}

/* ---------- ② 组装 release/resources ---------- */

function assemble() {
  step("组装桌面版资源（Next 服务器 + 静态资源 + Prisma 引擎 + 空数据库模板）");

  fs.rmSync(path.join(ROOT, "release", "resources"), { recursive: true, force: true });
  fs.mkdirSync(SERVER_OUT, { recursive: true });

  // 精简 app 壳（独立 package.json、无 dependencies → asar 不打进 node_modules）
  const appDir = path.join(ROOT, "release", "app");
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(appDir, "desktop"), { recursive: true });
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        name: rootPkg.name,
        productName: "壁纸工坊",
        version: rootPkg.version,
        description: rootPkg.description,
        author: rootPkg.author,
        license: "MIT",
        main: "desktop/main.js",
      },
      null,
      2
    )
  );
  fs.copyFileSync(path.join(ROOT, "desktop", "main.js"), path.join(appDir, "desktop", "main.js"));
  fs.copyFileSync(
    path.join(ROOT, "desktop", "preload.js"),
    path.join(appDir, "desktop", "preload.js")
  );

  // Next standalone 服务器
  fs.cpSync(path.join(DIST, "standalone"), SERVER_OUT, { recursive: true });
  // 客户端静态资源：自定义 distDir 为 .next-desktop → static 须放在 server/.next-desktop/static
  // （standalone 服务器按 next.config 里烘焙的 distDir 解析 /_next/static 的磁盘位置）
  fs.cpSync(path.join(DIST, "static"), path.join(SERVER_OUT, ".next-desktop", "static"), {
    recursive: true,
  });
  // public 静态资源（排除 desktop/ —— 桌面版无需内嵌自己的安装包，避免 167MB 递归膨胀）
  if (fs.existsSync(path.join(ROOT, "public"))) {
    const publicSrc = path.join(ROOT, "public");
    fs.cpSync(publicSrc, path.join(SERVER_OUT, "public"), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(publicSrc, src);
        return !(rel === "desktop" || rel.startsWith("desktop" + path.sep));
      },
    });
  }

  // 清掉可能被带进去的 .env（数据库路径由桌面主进程以环境变量注入）
  for (const f of fs.readdirSync(SERVER_OUT)) {
    if (f.startsWith(".env")) fs.rmSync(path.join(SERVER_OUT, f), { force: true });
  }

  // 确保 Prisma 双平台引擎在服务器 node_modules 内（含 Windows dll）
  const srcClient = path.join(ROOT, "node_modules", ".prisma", "client");
  const destClient = path.join(SERVER_OUT, "node_modules", ".prisma", "client");
  if (!fs.existsSync(destClient)) fs.mkdirSync(destClient, { recursive: true });
  for (const f of fs.readdirSync(srcClient)) {
    if (/engine|schema\.prisma|\.wasm|package\.json/.test(f)) {
      fs.copyFileSync(path.join(srcClient, f), path.join(destClient, f));
    }
  }
  console.log(
    "  Prisma 引擎:",
    fs
      .readdirSync(destClient)
      .filter((f) => f.includes("engine"))
      .join(", ")
  );

  // 全新空数据库模板（仅表结构）：用 prisma db push 生成
  step("生成空数据库模板 empty.db");
  fs.rmSync(EMPTY_DB, { force: true });
  run("node", [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: `file:${EMPTY_DB.replace(/\\/g, "/")}` },
  });

  console.log(`  服务器体积: ${sizeMB(SERVER_OUT).toFixed(1)} MB`);
}

/* ---------- ③ electron-builder ---------- */

/** 给 electron-builder 打补丁：Linux 上用原生 UninstallerReader 提取卸载器（免 wine，幂等） */
function patchElectronBuilder() {
  const file = path.join(
    ROOT,
    "node_modules",
    "app-builder-lib",
    "out",
    "targets",
    "nsis",
    "NsisTarget.js"
  );
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  const marker = "PATCH(desktop-build)";
  if (src.includes(marker)) return;
  const target = `if ((0, macosVersion_1.isMacOsCatalina)()) {`;
  if (!src.includes(target)) {
    console.warn("[desktop-build] 警告: 未找到 NsisTarget wine 分支，补丁未应用（electron-builder 版本可能已变化）");
    return;
  }
  src = src.replace(
    target,
    `// ${marker}: Linux 无 wine 环境下改用原生 UninstallerReader 提取卸载器\n        if ((0, macosVersion_1.isMacOsCatalina)() || process.platform === "linux") {`
  );
  fs.writeFileSync(file, src);
  console.log("[desktop-build] 已应用 electron-builder 免 wine 补丁");
}

function packageLinux() {
  step("打包 Linux 解包版（本地冒烟测试用）");
  patchElectronBuilder();
  run("node", [path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"), "--linux", "dir", "--x64"], {
    env: { ...process.env, ...MIRROR_ENV },
  });
}

function packageWin() {
  step("交叉打包 Windows NSIS 安装包（exe）");
  patchElectronBuilder();
  run("node", [path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"), "--win", "nsis", "--x64"], {
    env: { ...process.env, ...MIRROR_ENV },
  });
}

/* ---------- main ---------- */

const args = process.argv.slice(2);
const wantAssemble = args.includes("--assemble");
const wantLinux = args.includes("--linux");
const wantWin = args.includes("--win");

if (!wantAssemble && !wantLinux && !wantWin) {
  console.log("用法: node scripts/build-desktop.mjs --assemble | --linux | --win");
  process.exit(0);
}

// WF_SKIP_NEXT_BUILD=1：.next-desktop 已存在时跳过生产构建（分步构建用）
if (process.env.WF_SKIP_NEXT_BUILD !== "1") {
  buildNext();
} else {
  step("跳过 Next.js 生产构建（WF_SKIP_NEXT_BUILD=1）");
  if (!fs.existsSync(path.join(DIST, "standalone", "server.js"))) {
    console.error("[desktop-build] .next-desktop/standalone 不存在，无法跳过构建");
    process.exit(1);
  }
}
assemble();
if (wantLinux) packageLinux();
if (wantWin) packageWin();

step("完成 ✔");
const outDir = path.join(ROOT, "release", "out");
if (fs.existsSync(outDir)) {
  for (const f of fs.readdirSync(outDir)) {
    const full = path.join(outDir, f);
    console.log(`  产物: ${f} (${sizeMB(full).toFixed(1)} MB)`);
  }
}
