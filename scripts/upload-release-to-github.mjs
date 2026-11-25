#!/usr/bin/env node
/**
 * 壁纸工坊 · GitHub Release 上传（REST API 版）
 *
 * 用途：把网页版离线压缩包（WallpaperWorkshop-Web-v<版本>.zip，约 2MB）
 * 作为 Release 附件上传到仓库，并写入该版本的发布说明。
 *
 * 流程：读 package.json 版本 → 找/建 v{version} Release → 删除同名旧附件
 * → 上传新附件（失败自动整档重试 3 次）。
 *
 * 用法（项目根目录执行）：
 *   node scripts/upload-release-to-github.mjs <token>
 *   node scripts/upload-release-to-github.mjs          # 读 env GITHUB_TOKEN、~/.bizhi-token
 *   node scripts/upload-release-to-github.mjs <token> <zip路径>  # 自定义附件路径
 *
 * 前置：先执行 node scripts/build-gh-pages.mjs /bizhi 生成 release/WallpaperWorkshop-Web-v<版本>.zip
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
const ASSET_NAME = `WallpaperWorkshop-Web-v${VERSION}.zip`;
/** zip 位置（build-gh-pages.mjs 产出在 release/，脚本参数可覆盖） */
function resolveLocalZip() {
  const arg = process.argv[3];
  if (arg && !arg.startsWith("-")) return arg;
  const def = path.join(ROOT, "release", ASSET_NAME);
  return def;
}
const LOCAL_ZIP = resolveLocalZip();

if (!fs.existsSync(LOCAL_ZIP)) {
  console.error(`[release] 未找到网页版压缩包: ${LOCAL_ZIP}`);
  console.error(`        请先执行: node scripts/build-gh-pages.mjs /bizhi`);
  process.exit(1);
}
const ZIP_SIZE = fs.statSync(LOCAL_ZIP).size;
if (ZIP_SIZE < 1024) {
  console.error(`[release] 压缩包体积异常（${ZIP_SIZE} 字节），中止上传`);
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

/** 附件整档上传（可重试） */
async function uploadAsset(uploadBase, name, filePath) {
  const url = `${uploadBase}${uploadBase.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}`;
  const buf = fs.readFileSync(filePath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      process.stdout.write(`    上传中（第 ${attempt} 次，${(buf.length / 1024 / 1024).toFixed(2)}MB）…\n`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bizhi-release-uploader",
          "Content-Type": "application/zip",
          "Content-Length": String(buf.length),
        },
        body: buf,
        // 给足 10 分钟（含慢速网络兜底）
        signal: AbortSignal.timeout(10 * 60 * 1000),
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

const RELEASE_NOTES = `## 壁纸工坊 v${VERSION} —— 刷新强化 + 死链图片秒级兜底

### 本次更新（v1.4.6 优化专项）

**刷新真正「刷出新东西」**
- 刷新现在**强制回源**：绕过服务端 10 分钟页缓存，直接从哲风壁纸源站拿最新内容
- 刷新**空轮自动续扫**：下载记录特别多时，单轮 40 页可能仍全被过滤，现在自动续扫（最多 5 轮 / 200 页），刷新必出图
- 刷新过程逐轮上屏，能直观看到扫描进度；跳过 / 载入张数提示更准确

**死链图片处理（源自线上日志实证）**
- CDN 上部分缩略图变体是**永久 404**（源站没生成）：旧版每张要白等 ~1.9 秒重试注定失败的请求
- 现在 404/410/403 判定为永久失败：**不重试、透传状态码**，前端回退链（缩略图 → s240 小图 → 原图）立即切换
- 永久失败进 **5 分钟负缓存**：同批后续请求 0ms 出结果，不再拖慢健康图片

**网络抖动自愈加强**
- 图片整条回退链失败后的自动重试从 2 轮（4s / 12s）扩到 **3 轮（4s / 12s / 30s）**，
  批量下载挤占带宽 / CDN 限流稍长的窗口也能自己缓过来，不再过早定格「加载失败」
- 每一轮重试都换**全新破缓存参数**（rr 递增），浏览器 / 代理不可能把上一轮的
  失败响应当成本轮结果返回，重试必发真实网络请求

**其他**
- 预览弹窗补充无障碍描述（aria）
- 版本标识统一升级

### v1.4.5 核心修复（上一版，此处保留说明）
- **图片经常不显示**：改为游标深度扫描（4 页一组并行、单轮最多 40 页、自动续扫），
  无论下载过多少张，永远能扫到未下载的新壁纸，网格不再整页空白
- **刷新没用**：刷新 = 从源站第 1 页深度重扫（跳过所有已下载/屏蔽），
  失败图片重试带全新破缓存参数，不再命中旧的失败响应

### 使用
- **在线版**：https://xiaobaiba999.github.io/bizhi/
- **离线版**：下载下方 \`WallpaperWorkshop-Web-v${VERSION}.zip\` 解压后任意浏览器打开
  \`index.html\` 即可（需联网加载壁纸）
- 数据说明：网页版下载 / 屏蔽记录存在浏览器 localStorage，换浏览器 / 隐身模式不共享`;

async function main() {
  console.log(`[release] 目标：${OWNER}/${REPO} 的 ${TAG} Release`);
  console.log(`    本地压缩包: ${LOCAL_ZIP}`);
  console.log(`    附件名: ${ASSET_NAME}（${(ZIP_SIZE / 1024 / 1024).toFixed(2)}MB）`);

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

  console.log(`[release] ④ 上传压缩包附件`);
  const uploadBase = rel.data.upload_url.replace(/\{[^}]*\}$/, "");
  const asset = await uploadAsset(uploadBase, ASSET_NAME, LOCAL_ZIP);

  console.log(`\n[release] 完成 ✔`);
  console.log(`    Release: ${rel.data.html_url}`);
  console.log(`    附件直链: ${asset.browser_download_url}`);
}

main().catch((e) => {
  console.error(`\n[release] 失败：${e.message}`);
  process.exit(1);
});
