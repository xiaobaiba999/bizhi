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

const RELEASE_NOTES = `## 壁纸工坊 v${VERSION} —— 修复「下载后运行不了 / 没反应」+ 崩溃可见化 🔧

### ⚠️ 先看这里：双击安装包没反应 / 运行不了的排查（重要）

1. **核对文件大小**：下载完成后右键安装包 → 属性，大小应为 **97.2 MB（101,901,321 字节）**。
   明显偏小说明下载不完整，请重新下载（推荐用下方镜像直链，浏览器/下载工具均支持断点续传）
2. **校验文件哈希**：在安装包所在目录打开命令行（cmd），执行：
   \`\`\`
   certutil -hashfile WallpaperWorkshop-Setup-v${VERSION}.exe SHA256
   \`\`\`
   应显示 \`b914948302f323104e330a59fbac8cb3ae34ca6ec138e8f020f2bf69967bacf1\`。
   不一致 = 文件在下载过程中损坏，请重新下载
3. **杀毒软件静默拦截**：本应用无付费代码签名证书，部分安全软件（360 / 火绒 / 电脑管家等）
   可能默认拦截未签名安装包。请到杀软的「隔离区 / 信任区」把安装程序恢复并加入白名单后重试
4. **SmartScreen 蓝色提示**：首次运行出现「Windows 已保护你的电脑」时，点「更多信息」→「仍要运行」
5. **旧版本残留**：安装前请先在任务管理器里结束所有「壁纸工坊」进程（老版本可能仍在后台占用）
6. **终极兜底**：网页离线版 \`WallpaperWorkshop-Web-v${VERSION}.zip\`（0.5MB）解压后双击
   \`index.html\` 即可使用（联网加载壁纸，功能与网页版一致）

### 本版修复（v1.4.10）

- **启动失败不再「无声无息」**：任何未处理错误都会弹出明确的错误提示框（含原因与日志位置），
  同时自动写入运行日志（\`%APPDATA%\\\\壁纸工坊\\\\logs\\\\main.log\`），菜单
  「帮助 → 打开运行日志」可一键打开，问题可定位、可反馈
- **登录模块异常自动降级**：扫码登录组件万一加载失败，浏览 / 屏蔽 / 普通下载完全不受影响，
  界面明确提示降级原因，绝不拖死整个应用
- **界面崩溃可自愈**：渲染进程意外退出时弹窗提示，一键「重新加载」恢复，不再白屏假死
- **启动全链路日志**：主进程启动 → 协议注册 → 窗口创建 → 界面呈现，每一步都有迹可查
- **系统通知可靠性**：Windows 通知标识（AUMID）与安装器对齐，Win10 / 11 通知不再丢失

### 下载

| 文件 | 说明 | 校验 |
|---|---|---|
| \`WallpaperWorkshop-Setup-v${VERSION}.exe\` | Windows 安装包（97.2 MB） | SHA256 见上方第 2 步 |
| \`WallpaperWorkshop-Web-v${VERSION}.zip\` | 网页离线版（0.5 MB） | — |

- **直链**：https://github.com/xiaobaiba999/bizhi/releases/download/v${VERSION}/WallpaperWorkshop-Setup-v${VERSION}.exe
- **国内镜像直链**（ghfast.top，实测可信，支持断点续传）：
  https://ghfast.top/https://github.com/xiaobaiba999/bizhi/releases/download/v${VERSION}/WallpaperWorkshop-Setup-v${VERSION}.exe
- 系统要求：Windows 10 / 11（64 位）

### 近期版本更新回顾

**v1.4.9 —— 扫码登录全面回归 + 官网原图直存**

- 微信扫码登录回归桌面版：主进程托管全链路（二维码 → 长轮询 → 自动获取官网令牌），
  令牌保存在本机应用数据文件，升级新版本不丢；也可手动粘贴令牌
- **登录后下载 = 官网原图**：走官网同款「人机验证 + 原图直链」通道，分辨率与文件大小
  和官网点击下载完全一致；未登录 / 令牌失效时自动回退预览质量，并在下载记录中标注
- 下载记录增加质量标注（原图 / 预览）

**v1.4.8 —— 记录永不丢 + 保存位置自选**

- 屏蔽 / 下载记录以应用数据文件为唯一真源（原子写入 + 退出强制落盘），跨版本升级、
  重装、localStorage 损坏都不丢；v1.4.7 的旧记录自动迁移
- 保存位置自主选择：页头按钮 / 菜单「文件 → 选择保存位置…」，记忆自定义目录

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
