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

const RELEASE_NOTES = `## 壁纸工坊 v${VERSION} —— 原图下载质量硬闸门 🔍

### 本版核心：下载到的必须是官网原图，否则宁可不给

**根因（实测取证，20/20 断言全过）**：未登录状态下，即使访问的是原图 \`.png\` 直链，
官网 CDN 也只返回 **890×556 / 约 25KB 的 webp 预览小图**；官网自己的 1100px 预览
（previewFileImg）也是 webp。4K/7K 原图（几 MB～几十 MB）仅对**登录用户**通过
「ALTCHA 人机验证 + getCompleteUrl 签名直链」开放（未登录实测 401）。
旧版在无令牌时**静默回退**保存预览小图 —— 这就是「下载的图片模糊、只有几十 KB」。

**v1.4.13 质量硬保证（三重防线）**：

1. **拿不到原图就不保存**
   - 未登录点下载 → 明确引导「扫码登录」，**扫码成功自动继续刚才那一张/那一整批**
   - 令牌失效 → 引导重新扫码，同样自动续传
   - 在线网页版（无登录能力）→ 只引导安装桌面版，**不再保存 890px 预览小图**
   - 服务器自部署版 → 无令牌返回 401 引导登录，**移除了静默预览回退**
2. **下载后字节级质量校验（新增 image-quality 模块）**
   - 按魔数识别真实格式（PNG/JPEG/WebP/GIF），解析真实宽高
   - 官方预览上限 1100px：长边 ≤1100px 或「<60KB 且低分辨率」→ 判定
     \`DOWNLOAD_QUALITY_MISMATCH\`，**拒绝保存、不留任何模糊图**
   - 扩展名按字节真实内容定（webp 就存 .webp），**杜绝 preview.webp 改名 .png**
   - 官网限流（429）明确提示稍后重试
3. **自动质量测试（scripts/original-download-quality-test.mjs）**
   - 每次发版前可复跑：官网实时取样 3 张 + 未登录行为取证 + 校验器双生断言
   - 本版实测 20/20 全过（3 张直链均为 webp 890px 6.5~24.5KB；getCompleteUrl 未登录 401；
     890px/1100px 真实预览字节必被拒绝；3840×2160 真像素 PNG / SOF0 JPEG / VP8X WebP 必放行）

### 为什么需要扫码登录？

哲风壁纸官网的原图下载本身就需要登录（人机验证 + 会话令牌）。
本应用的扫码登录 = 用你自己的微信扫官网登录码，令牌**只保存在本机**，
应用用它换取与你手动在官网下载**完全一致**的原文件（分辨率、字节数一致）。

### 下载

| 文件 | 说明 |
|---|---|
| \`WallpaperWorkshop-Setup-v${VERSION}.exe\` | Windows 安装包（约 97 MB） |
| \`WallpaperWorkshop-Web-v${VERSION}.zip\` | 网页离线版（0.5 MB） |

- **直链**：https://github.com/xiaobaiba999/bizhi/releases/download/v${VERSION}/WallpaperWorkshop-Setup-v${VERSION}.exe
- **国内镜像直链**（ghfast.top，实测可信，支持断点续传）：
  https://ghfast.top/https://github.com/xiaobaiba999/bizhi/releases/download/v${VERSION}/WallpaperWorkshop-Setup-v${VERSION}.exe
- 下载后请核对大小（以本 Release 附件字节数为准），偏小 = 下载不完整请重下；
  也可用 \`certutil -hashfile <文件名> SHA256\` 校验
- 系统要求：Windows 10 / 11（64 位）；SmartScreen 首次运行点「仍要运行」；
  被杀软拦截时到隔离区恢复并加白名单

### 近期版本回顾

**v1.4.12 —— 未登录不再静默存小图**：未登录点下载引导扫码、扫码成功自动补下；
令牌失效引导重新扫码；下载成功明确提示原图 + 保存路径

**v1.4.11 —— 满屏加载 + 官网同步**：首屏一次铺满 48 张渐进上屏、残缺页不再
误判到底、滚动每批 24 张；切回窗口 / 每 5 分钟自动同步官网最新壁纸

**v1.4.10 —— 修复「下载后运行不了 / 没反应」**：崩溃全面可见化（错误弹窗 +
运行日志，菜单「帮助 → 打开运行日志」一键打开）、登录模块异常自动降级、
界面崩溃一键重载

### 网页版

- **在线版**：https://xiaobaiba999.github.io/bizhi/
- **离线版**：\`WallpaperWorkshop-Web-v${VERSION}.zip\` 解压后双击 \`index.html\`（需联网加载壁纸；
  在线/离线网页版受官网限制无法获取原图，下载按钮会引导安装桌面版）

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
