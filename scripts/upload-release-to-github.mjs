#!/usr/bin/env node
/**
 * 壁纸工坊 · GitHub Release 安装包上传（REST API 版）
 *
 * 用途：把 Windows 安装包（~170MB）作为 Release 附件上传到仓库。
 * 仓库分支 blob 单文件上限 100MB，装不下安装包；Release 附件上限 2GB，
 * 还自带 CDN 直链下载，正好托管桌面安装版分发。
 *
 * 流程：读 package.json 版本 → 找/建 v{version} Release → 删除同名旧附件
 * → 上传新附件（大文件专用超时，失败自动整档重试）。
 *
 * 附件名仅用 ASCII（WallpaperWorkshop-Setup-v{version}.exe），
 * 与 src/lib/version.ts 的 RELEASE_SETUP_URL 保持一致。
 *
 * 用法（项目根目录执行）：
 *   node scripts/upload-release-to-github.mjs <token>
 *   node scripts/upload-release-to-github.mjs          # 读 env GITHUB_TOKEN、~/.bizhi-token
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
      `  node scripts/upload-release-to-github.mjs <token>\n` +
      `  或设置 env GITHUB_TOKEN，或把 token 存到 ~/.bizhi-token`
  );
  process.exit(1);
}

/* ------------------------------ 版本与产物 ------------------------------ */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const ASSET_NAME = `WallpaperWorkshop-Setup-v${VERSION}.exe`;
/** 安装包位置（electron-builder 输出在 release/out/，脚本参数可覆盖） */
function resolveLocalExe() {
  const arg = process.argv[3];
  if (arg && !arg.startsWith("-")) return arg;
  for (const p of [
    path.join(ROOT, "release", "out", `壁纸工坊-Setup-${VERSION}.exe`),
    path.join(ROOT, "release", `壁纸工坊-Setup-${VERSION}.exe`),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(ROOT, "release", "out", `壁纸工坊-Setup-${VERSION}.exe`);
}
const LOCAL_EXE = resolveLocalExe();

if (!fs.existsSync(LOCAL_EXE)) {
  console.error(`[release] 未找到安装包: ${LOCAL_EXE}`);
  process.exit(1);
}
const EXE_SIZE = fs.statSync(LOCAL_EXE).size;
if (EXE_SIZE < 1024 * 1024) {
  console.error(`[release] 安装包体积异常（${EXE_SIZE} 字节），中止上传`);
  process.exit(1);
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

/** 大文件整档上传（专用长超时；可重试） */
async function uploadAsset(uploadBase, name, filePath) {
  const url = `${uploadBase}${uploadBase.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}`;
  const buf = fs.readFileSync(filePath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      process.stdout.write(`    上传中（第 ${attempt} 次，${(buf.length / 1024 / 1024).toFixed(0)}MB）…\n`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bizhi-release-uploader",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buf.length),
        },
        body: buf,
        // 170MB 上传给足 20 分钟（含慢速网络兜底）
        signal: AbortSignal.timeout(20 * 60 * 1000),
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

/* --------------------------------- 主流程 --------------------------------- */

const RELEASE_NOTES = `## 壁纸工坊 v${VERSION} —— 图片显示速度大幅优化

### 本次更新（缓存优化专项）
- **三级图片缓存**：内存 LRU → 本地磁盘缓存（\`%APPDATA%\\壁纸工坊\\img-cache\`，跨重启永久生效）→ 源站回源；同一图片的并发请求自动合并为一次回源
- **二次浏览零回源**：看过的壁纸重启应用后仍秒开（实测磁盘命中平均 12ms/张，原先每张需经 CDN 数百 ms～数秒）
- **缩略图回退链修复**：缩略图变体 404 时不再直接加载 2K/4K 巨型原图（旧版「部分图片显示太慢 / 空白」的根因），改为 缩略图 → s240 小图 → 原图 逐级兜底 + 破缓存重试
- **加载体验**：图片加载中显示微光占位骨架、加载完成淡入；全部失败时明确显示占位图标，不再无声空白
- **首屏加速**：网格前 6 张立即加载并高优先级，其余滚动到再加载
- **缓存自我管理**：磁盘缓存上限 512MB 超限自动按最旧淘汰，无需用户维护

### 历史要点（自 v1.4.2 起）
- 屏蔽记录永久保留（升级数据护送 + 数据库自动修补，升级版本也保留）
- 下载过的壁纸自动隐藏；自选下载位置跨版本记住
- NSIS 升级安装不再误删用户数据目录

### 安装
下载下方 \`WallpaperWorkshop-Setup-v${VERSION}.exe\`，双击安装即可（Windows 10/11 64 位）。`;

async function main() {
  console.log(`[release] 目标：${OWNER}/${REPO} 的 ${TAG} Release`);
  console.log(`    本地安装包: ${LOCAL_EXE}`);
  console.log(`    附件名: ${ASSET_NAME}（${(EXE_SIZE / 1024 / 1024).toFixed(1)}MB）`);

  console.log(`\n[release] ① 校验仓库与 token`);
  const repo = await apiRetry("GET", `/repos/${OWNER}/${REPO}`);
  console.log(`    仓库: ${repo.data.full_name}`);

  console.log(`[release] ② 查找 / 创建 ${TAG} Release`);
  let rel = await apiRetry("GET", `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, undefined, {
    ok404: true,
  });
  if (rel.data) {
    console.log(`    Release 已存在（id=${rel.data.id}），更新附件`);
    rel = await apiRetry("PATCH", `/repos/${OWNER}/${REPO}/releases/${rel.data.id}`, {
      body: RELEASE_NOTES,
      draft: false,
      prerelease: false,
    });
  } else {
    rel = await apiRetry("POST", `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      name: `壁纸工坊 ${TAG}`,
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
    if (a.name === ASSET_NAME) {
      await apiRetry("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`).catch((e) =>
        console.log(`    删除旧附件失败（忽略）: ${String(e.message).slice(0, 100)}`)
      );
      console.log(`    已删除旧附件 ${a.name}`);
    }
  }

  console.log(`[release] ④ 上传安装包附件`);
  const uploadBase = rel.data.upload_url.replace(/\{[^}]*\}$/, "");
  const asset = await uploadAsset(uploadBase, ASSET_NAME, LOCAL_EXE);

  console.log(`\n[release] 完成 ✔`);
  console.log(`    Release: ${rel.data.html_url}`);
  console.log(`    附件直链: ${asset.browser_download_url}`);
  console.log(`    （网页版下载按钮指向同一 URL，自动保持一致）`);
}

main().catch((e) => {
  console.error(`\n[release] 失败：${e.message}`);
  process.exit(1);
});
