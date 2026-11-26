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

const RELEASE_NOTES = `## 壁纸工坊 v${VERSION} —— 满屏加载 + 官网同步 🖼️

### 本版修复：图片只加载一小部分？

用户反馈：已屏蔽 124 张 + 隐藏已下载 56 张后，网格里只剩 7~8 张就停了。
本版彻底根治（v1.4.11）：

- **首屏满屏**：一次加载直接铺满两屏（48 张，旧版只有 12 张），
  且每收一批立即上屏 —— 首屏秒出、后续渐进填满，不用干等
- **不再被残缺页误判「到底」**：源站限流返回残缺页时，旧版会把它当成
  最后一页直接停（这就是只剩几张的根因）；现在只有「页面完全为空且
  重试后仍为空」才算到底
- **零漏图**：修复扫描游标「整批跳页」漏掉最多 36 张/轮的老问题，
  重扫贡献页时按 id 去重，不重复也不遗漏，每轮必然向前推进
- **滚动加载翻倍**：每批 24 张（旧版 12 张）+ 预取距离加倍，快速滚动不等待
- **刷新不再缩水**：旧版刷新/后台刷新会把列表缩回 12 张，
  现在刷新同样收满 48 张
- **网格加密**：电脑壁纸最多 5 列（对齐官网布局），一屏看到更多

### 新增：与官网同步

- **切回窗口自动同步**：每次切回应用（窗口聚焦）自动拉取官网第 1 页最新壁纸，
  新面孔直接插入列表顶部并轻提示「已同步官网最新 N 张」
- **定时同步**：每 5 分钟自动检查官网更新（页面隐藏时跳过）
- **不打扰浏览**：深滚浏览中不会同步（内容不会被推走），
  正在扫描/刷新时自动让路；单页请求开销极小

### 下载

| 文件 | 说明 |
|---|---|
| \`WallpaperWorkshop-Setup-v${VERSION}.exe\` | Windows 安装包（约 97 MB） |
| \`WallpaperWorkshop-Web-v${VERSION}.zip\` | 网页离线版（0.5 MB） |

- **直链**：https://github.com/xiaobaiba999/bizhi/releases/download/v${VERSION}/WallpaperWorkshop-Setup-v${VERSION}.exe
- **国内镜像直链**（ghfast.top，实测可信，支持断点续传）：
  https://ghfast.top/https://github.com/xiaobaiba999/bizhi/releases/download/v${VERSION}/WallpaperWorkshop-Setup-v${VERSION}.exe
- 下载后请核对大小 **97 MB / 101,901,952 字节**（以本 Release 实际附件为准），
  偏小 = 下载不完整请重下；也可用 \`certutil -hashfile <文件名> SHA256\` 校验
- 系统要求：Windows 10 / 11（64 位）；SmartScreen 首次运行点「仍要运行」；
  被杀软拦截时到隔离区恢复并加白名单

### 近期版本回顾

**v1.4.10 —— 修复「下载后运行不了 / 没反应」**：崩溃全面可见化（错误弹窗 +
运行日志，菜单「帮助 → 打开运行日志」一键打开）、登录模块异常自动降级、
界面崩溃一键重载

**v1.4.9 —— 扫码登录回归 + 官网原图直存**：微信扫码自动获取官网令牌，
登录后下载与官网原图完全一致（分辨率/文件大小），令牌升级不丢

**v1.4.8 —— 记录永不丢 + 保存位置自选**：屏蔽/下载记录存应用数据文件
（跨版本升级、重装都不丢），保存目录可自定义

### 网页版

- **在线版**：https://xiaobaiba999.github.io/bizhi/
- **离线版**：\`WallpaperWorkshop-Web-v${VERSION}.zip\` 解压后双击 \`index.html\`（需联网加载壁纸）

---

- 数据实时来自 [哲风壁纸](https://haowallpaper.com)，版权归原作者所有
- 源码：\`source\` 分支（Next.js 16 + Tailwind 4 网页版 / Electron 桌面版），可自行构建校验`;

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
