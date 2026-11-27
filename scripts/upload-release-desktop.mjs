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

const RELEASE_NOTES = `## 壁纸工坊 v2.0.0 —— v2.0 架构重构：功能少而稳定，原图真实完整

### 六大核心功能（v2.0 产品定位）

1. 对接哲风壁纸官网，实时获取壁纸（电脑 / 手机双分类，独立分页）
2. 只展示静态壁纸，动态壁纸双层过滤（列表级 + 官网元数据级）
3. 下载官网授权的完整高清原图（与官网逐项一致，75/75 项断言全过）
4. SQLite 永久下载历史（应用数据目录，升级不清空，支持备份/恢复）
5. 隐藏已下载壁纸（默认关闭，基于真实下载记录判定）
6. 本地下载管理（查看记录 / 打开文件 / 文件删除检测）

### v2.0 架构重构要点

- **OriginalDownloadService 统一链路**：本地记录检查（重复下载明确提示）→ 登录检查 → 官网元数据（动态拒绝）→ ALTCHA → 签名直链 → 原始字节 → 质量硬校验 → 原始字节直存（零裁切/零缩放/零重编码）→ 写 SQLite 历史
- **SQLite 永久下载历史**：每条记录保存 wallpaperId（唯一约束）/ 名称 / 分类 / 实际宽高 / 文件大小 / SHA-256 / 保存路径 / 下载时间；文件被手动删除仅标记「文件已不存在」，记录永不丢失；一键备份 / 恢复（整库 .db 文件）
- **限流与错误处理**（针对「下载功能暂时受限，预计恢复时间 2027-xx」问题）：
  - 实测确认为官网服务端风控（绑定账号/设备，非应用故障）
  - Retry-After 识别 + 官网恢复时间本地时区解析 + 90 天可信窗口保护（官网返回异常日期时不展示具体时间，绝不伪造恢复时间）
  - 受限期间自动熔断（零官网请求），串行下载 2.5s 拟人节奏
  - 移除批量勾选下载（正是触发官网风控的直接诱因）
- **界面精简**：电脑壁纸 / 手机壁纸 / 下载历史三标签；卡片只有预览、名称、分辨率、下载按钮、已下载状态

### 原图质量防线（v1.4.13 起保留，v2.0 全面继承）

- 未登录拿不到原图（官网机制实测取证：CDN 只回 890px webp 预览，getCompleteUrl 未登录 401）
- 官方元数据期望宽高逐一硬比对（裁切 / 缩放 / 拉伸 / 改比例全拒，无硬编码尺寸）
- 魔数识别真实格式（webp 不冒充 png），体积下限拦截重压缩
- 校验不过绝不落盘、绝不写下载记录

### 完整性校验

| 文件 | SHA-256 |
|---|---|
| WallpaperWorkshop-Setup-v2.0.0.exe | c6188a5fd7de1d6316d0d531eee97a2a10ec21347b72f2994d19222712867899 |

下载后请核对大小与 SHA-256（PowerShell： Get-FileHash -Algorithm SHA256 文件名）。
`;

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
