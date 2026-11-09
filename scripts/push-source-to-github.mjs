#!/usr/bin/env node
/**
 * 壁纸工坊 · 源码分支推送（REST API 版）
 *
 * 用途：把完整项目源码镜像推送到仓库的 `source` 分支做永久备份
 * （main 分支专供 GitHub Pages 静态站点使用，两者互不干扰）。
 *
 * 与 deploy-to-github.mjs 同理：沙箱 git push 通道被阻断，改走 Git Data API
 * （blob → tree 整树替换 → commit → ref）。排除所有构建产物与本地数据：
 * node_modules / .next* / release / github-pages-dist / download / db /
 * public/desktop（174MB 安装包）/ public/*.zip / upload / tool-results /
 * skills / mini-services / dev.log / .env 等。
 *
 * 安装包不上传到分支（Git blob 单文件上限 100MB）——改由 GitHub Release
 * 资产托管（releases 单文件上限 2GB），见 GITHUB_DEPLOY.md。
 *
 * 用法（项目根目录执行）：
 *   node scripts/push-source-to-github.mjs <token>
 *   node scripts/push-source-to-github.mjs        # 读 env GITHUB_TOKEN、~/.bizhi-token
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OWNER = "xiaobaiba999";
const REPO = "bizhi";
const BRANCH = "source";
const API = "https://api.github.com";

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
    `[source-push] 缺少 GitHub token。用法：\n` +
      `  node scripts/push-source-to-github.mjs <token>\n` +
      `  或设置 env GITHUB_TOKEN，或把 token 存到 ~/.bizhi-token`
  );
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
      "User-Agent": "bizhi-source-push",
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

/* ------------------------------ 文件收集 ------------------------------ */

/** 纳入源码分支的顶层文件（存在才收录） */
const ROOT_FILES = [
  "package.json",
  "bun.lock",
  "next-env.d.ts",
  "next.config.ts",
  "tsconfig.json",
  "electron-builder.yml",
  "components.json",
  "eslint.config.mjs",
  "README.md",
  "GITHUB_DEPLOY.md",
  "AGENTS.md",
  ".gitignore",
];

/** 纳入源码分支的目录（递归全收） */
const ROOT_DIRS = ["src", "scripts", "desktop", "prisma", "build"];

/** public/ 特殊处理：排除 desktop/（安装包目录）与 *.zip（网页版压缩包，构建产物） */
function collectPublic(out) {
  const dir = path.join(ROOT, "public");
  if (!fs.existsSync(dir)) return;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "desktop") continue; // 安装包目录不入源码分支
      const full = path.join(d, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else if (!e.name.endsWith(".zip")) out.push({ abs: full, rel: `public/${relPath}` });
    }
  };
  walk(dir, "");
}

function collectFiles() {
  const out = [];
  for (const f of ROOT_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile())
      out.push({ abs, rel: f });
  }
  for (const d of ROOT_DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    const walk = (dd, rel) => {
      for (const e of fs.readdirSync(dd, { withFileTypes: true })) {
        const full = path.join(dd, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(full, relPath);
        else out.push({ abs: full, rel: `${d}/${relPath}` });
      }
    };
    walk(dir, "");
  }
  collectPublic(out);
  return out;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  console.log(`[source-push] 目标：${OWNER}/${REPO} 分支 ${BRANCH}（整树镜像替换）`);

  const files = collectFiles();
  const totalMB = (files.reduce((s, f) => s + fs.statSync(f.abs).size, 0) / 1024 / 1024).toFixed(2);
  console.log(`    ${files.length} 个文件，共 ${totalMB} MB`);
  if (files.length === 0) throw new Error("没有可推送的文件");

  const CONCURRENCY = 6;
  const treeEntries = [];
  let done = 0;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (f) => {
        const content = fs.readFileSync(f.abs).toString("base64");
        const blob = await apiRetry("POST", `/repos/${OWNER}/${REPO}/git/blobs`, {
          content,
          encoding: "base64",
        });
        return { path: f.rel, mode: "100644", type: "blob", sha: blob.data.sha };
      })
    );
    treeEntries.push(...results);
    done += chunk.length;
    process.stdout.write(`    blobs: ${done}/${files.length}\r`);
  }
  console.log(`    blobs: ${done}/${files.length} ✔`);

  const tree = await apiRetry("POST", `/repos/${OWNER}/${REPO}/git/trees`, { tree: treeEntries });
  console.log(`    tree: ${tree.data.sha}`);

  const head = await apiRetry("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, undefined, {
    ok404: true,
  });
  const parentSha = head.data ? head.data.object.sha : null;
  console.log(parentSha ? `    父提交: ${parentSha.slice(0, 10)}` : "    新建 source 分支");

  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const commit = await apiRetry("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `source: 壁纸工坊完整源码快照（${stamp} UTC，${files.length} 文件）`,
    tree: tree.data.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  });
  console.log(`    commit: ${commit.data.sha.slice(0, 10)}`);

  if (parentSha) {
    await apiRetry("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.data.sha,
      force: false,
    });
  } else {
    await apiRetry("POST", `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.data.sha,
    });
  }
  console.log(`    ${BRANCH} → ${commit.data.sha.slice(0, 10)} ✔`);
  console.log(`\n[source-push] 完成 ✔ 源码已备份到 ${BRANCH} 分支`);
}

main().catch((e) => {
  console.error(`\n[source-push] 失败：${e.message}`);
  process.exit(1);
});
