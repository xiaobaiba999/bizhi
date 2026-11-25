#!/usr/bin/env node
/**
 * 壁纸工坊 · GitHub Release 上传 v1.4.7（桌面版首发：exe + web zip 双附件）
 *
 * 附件：
 * - release/desktop/WallpaperWorkshop-Setup-v<版本>.exe（Windows NSIS 安装包，约 100MB）
 * - release/WallpaperWorkshop-Web-v<版本>.zip（网页离线版，约 0.5MB）
 *
 * 流程：找/建 v{version} Release → 删除同名旧附件 → 逐个上传（整档重试 3 次；
 * exe 较大，单次上传限时 20 分钟）。
 *
 * 用法：
 *   node scripts/upload-release-desktop.mjs <token>
 *   node scripts/upload-release-desktop.mjs            # 读 env GITHUB_TOKEN、~/.bizhi-token
 *
 * 前置：先执行 node scripts/build-desktop.mjs 与 node scripts/build-gh-pages.mjs /bizhi
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OWNER = "xiaobaiba999";
const REPO = "bizhi";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

/* ------------------------------- token 解析 ------------------------------- */

function resolveToken() {
  const arg = process.argv[2];
  if (arg && !arg.startsWith("-")) return arg.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const file = path.join(os.homedir(), ".bizhi-token");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return null;
}

const token = resolveToken();
if (!token) {
  console.error(
    `[release] 缺少 GitHub token。用法：\n` +
      `  node scripts/upload-release-desktop.mjs <token>\n` +
      `  或设置 env GITHUB_TOKEN，或把 token 存到 ~/.bizhi-token`
  );
  process.exit(1);
}

/* ------------------------------ 版本与产物 ------------------------------ */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

const ASSETS = [
  {
    name: `WallpaperWorkshop-Setup-v${VERSION}.exe`,
    file: path.join(ROOT, "release", "desktop", `WallpaperWorkshop-Setup-v${VERSION}.exe`),
    contentType: "application/octet-stream",
    required: true,
  },
  {
    name: `WallpaperWorkshop-Web-v${VERSION}.zip`,
    file: path.join(ROOT, "release", `WallpaperWorkshop-Web-v${VERSION}.zip`),
    contentType: "application/zip",
    required: true,
  },
];

for (const a of ASSETS) {
  if (!fs.existsSync(a.file)) {
    console.error(`[release] 缺少附件: ${a.file}`);
    console.error(`        请先执行: node scripts/build-desktop.mjs 与 node scripts/build-gh-pages.mjs /bizhi`);
    process.exit(1);
  }
  a.size = fs.statSync(a.file).size;
  if (a.size < 1024) {
    console.error(`[release] 附件体积异常（${a.size} 字节）: ${a.file}`);
    process.exit(1);
  }
}

/* ------------------------------ API 基础封装 ------------------------------ */

async function api(method, urlPath, body, { ok404 = false } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bizhi-release-uploader",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404 && ok404) return { status: 404, data: null };
  if (res.status === 401) throw new Error("token 无效或已过期（401）");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}

async function apiRetry(method, urlPath, body, opts, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await api(method, urlPath, body, opts);
    } catch (e) {
      lastErr = e;
      const retriable = /HTTP 5\d\d|fetch failed|aborted|timeout/i.test(String(e.message));
      if (!retriable || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function uploadAsset(uploadBase, name, filePath, contentType) {
  const url = `${uploadBase}?name=${encodeURIComponent(name)}`;
  const buf = fs.readFileSync(filePath);
  const maxMin = buf.length > 20 * 1024 * 1024 ? 20 : 10; // exe 大文件放宽到 20 分钟
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      process.stdout.write(`    上传中（第 ${attempt} 次，${(buf.length / 1024 / 1024).toFixed(2)}MB）…\n`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bizhi-release-uploader",
          "Content-Type": contentType,
          "Content-Length": String(buf.length),
        },
        body: buf,
        signal: AbortSignal.timeout(maxMin * 60 * 1000),
        duplex: "half",
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`    失败重试：${String(e.message).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  throw new Error("unreachable");
}

/* ------------------------------ 发布说明 ------------------------------ */

const RELEASE_NOTES = `## 壁纸工坊 v${VERSION} —— Windows 桌面版首发 🖼️

### 新增：Windows 桌面安装版（推荐）

下载 **\`WallpaperWorkshop-Setup-v${VERSION}.exe\`**（约 97MB，含 Chromium 运行时），
双击按向导安装即可使用：

- **向导式安装**：可选安装位置，自动创建桌面 / 开始菜单快捷方式（「壁纸工坊」）
- **壁纸自动保存**：下载自动存到「图片 / WallpaperWorkshop」文件夹，
  同名不覆盖（自动加序号）；保存完成弹系统通知，点通知直达文件夹
  （菜单「文件 → 打开保存文件夹」随时可进）
- **记录独立持久**：下载 / 屏蔽记录存在应用本地（不依赖浏览器 localStorage），
  重装、换浏览器都不丢；「隐藏已下载」照常自动屏蔽
- **桌面级体验**：记忆窗口位置大小、单实例运行、外链走系统默认浏览器、
  菜单支持缩放 / 全屏 / 开发者工具
- 系统要求：Windows 10 / 11（64 位）；无签名证书，SmartScreen 首次运行
  需点「仍要运行」（源码见 \`source\` 分支，可自行构建校验）

### 网页版同步 v${VERSION}

- **在线版**：https://xiaobaiba999.github.io/bizhi/
- **离线版**：\`WallpaperWorkshop-Web-v${VERSION}.zip\`（0.5MB）解压后双击
  \`index.html\` 即可（需联网加载壁纸）

### v1.4.6 核心优化（上一版，此处保留说明）

- **刷新真正「刷出新东西」**：强制回源（绕过 10 分钟页缓存）+ 空轮自动续扫
  最多 200 页，刷新必出图
- **死链图片秒级兜底**：404/403 永久失败不重试 + 5 分钟负缓存，
  回退链（缩略图 → s240 小图 → 原图）立即切换
- **网络抖动自愈**：回退链失败自动重试扩到 3 轮（4s / 12s / 30s），
  每轮换全新破缓存参数

### v1.4.5 核心修复（更早版本，此处保留说明）

- **图片经常不显示**：游标深度扫描（4 页一组并行、单轮最多 40 页、自动续扫），
  下载再多也能扫到新壁纸，网格不再整页空白
- **刷新没用**：刷新 = 从源站第 1 页深度重扫（跳过所有已下载/屏蔽）

---

- 数据实时来自 [哲风壁纸](https://haowallpaper.com)，版权归原作者所有
- 源码：\`source\` 分支（Next.js 16 + Tailwind 4 网页版 / Electron 桌面版）`;

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  console.log(`[release] 目标：${OWNER}/${REPO} 的 ${TAG} Release（桌面版首发）`);
  for (const a of ASSETS) {
    console.log(`    附件: ${a.name}（${(a.size / 1024 / 1024).toFixed(2)}MB）`);
  }

  console.log(`\n[release] ① 校验仓库与 token`);
  const repo = await apiRetry("GET", `/repos/${OWNER}/${REPO}`);
  console.log(`    仓库: ${repo.data.full_name}`);

  console.log(`[release] ② 查找 / 创建 ${TAG} Release`);
  let rel = await apiRetry("GET", `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, undefined, {
    ok404: true,
  });
  if (rel.data) {
    console.log(`    Release 已存在（id=${rel.data.id}），更新说明与附件`);
    rel = await apiRetry("PATCH", `/repos/${OWNER}/${REPO}/releases/${rel.data.id}`, {
      body: RELEASE_NOTES,
      draft: false,
      prerelease: false,
    });
  } else {
    rel = await apiRetry("POST", `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      target_commitish: "main",
      name: `壁纸工坊 ${TAG} · Windows 桌面版`,
      body: RELEASE_NOTES,
      draft: false,
      prerelease: false,
    });
    console.log(`    Release 已创建（id=${rel.data.id}，tag=${TAG}）`);
  }
  const releaseId = rel.data.id;

  console.log(`[release] ③ 清理同名旧附件（如有）`);
  const assets = await apiRetry("GET", `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`);
  for (const a of assets.data) {
    if (ASSETS.some((x) => x.name === a.name)) {
      await apiRetry("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`).catch((e) =>
        console.log(`    删除旧附件失败（忽略）: ${String(e.message).slice(0, 100)}`)
      );
      console.log(`    已删除旧附件 ${a.name}`);
    }
  }

  const uploadBase = rel.data.upload_url.replace(/\{[^}]*\}$/, "");
  const uploaded = [];
  for (const a of ASSETS) {
    console.log(`[release] ④ 上传 ${a.name}`);
    const asset = await uploadAsset(uploadBase, a.name, a.file, a.contentType);
    uploaded.push(asset);
    console.log(`    完成 ✔  ${asset.browser_download_url}`);
  }

  console.log(`\n[release] 全部完成 ✔`);
  console.log(`    Release: ${rel.data.html_url}`);
  for (const a of uploaded) {
    console.log(`    附件直链: ${a.browser_download_url}`);
  }
}

main().catch((e) => {
  console.error(`\n[release] 失败：${e.message}`);
  process.exit(1);
});
