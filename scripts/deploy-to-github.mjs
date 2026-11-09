#!/usr/bin/env node
/**
 * 壁纸工坊 · GitHub Pages 部署（REST API 版）
 *
 * 为什么不用 git push？
 *   本沙箱网络策略只放行 api.github.com（REST API），github.com 的
 *   git-receive-pack 通道（git push）会被挂起阻断。因此改走 Git Data API：
 *   逐文件建 blob → 建整棵 tree（不带 base_tree = 镜像替换，旧文件自动清除）
 *   → 建 commit → 建/推 main 分支 → 开启 Pages。全部通过 api.github.com 完成。
 *
 * 用法（项目根目录执行）：
 *   node scripts/deploy-to-github.mjs <token>     # 直接传 token
 *   node scripts/deploy-to-github.mjs             # 依次读 env GITHUB_TOKEN、~/.bizhi-token
 *
 * token 权限要求（二选一）：
 *   - Fine-grained（推荐）：只选 xiaobaiba999/bizhi 一个仓库，
 *     权限 Contents: Read and write + Pages: Read and write
 *   - Classic：勾 repo（public_repo 亦可推送，但 Pages 开启可能需手动）
 *
 * 部署目标：https://xiaobaiba999.github.io/bizhi/
 * 前置：先执行 node scripts/build-gh-pages.mjs /bizhi 生成 github-pages-dist/
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "github-pages-dist");

const OWNER = "xiaobaiba999";
const REPO = "bizhi";
const BRANCH = "main";
const BASE_PATH = "/bizhi";
const SITE_URL = `https://${OWNER}.github.io${BASE_PATH}/`;
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
    `[deploy] 缺少 GitHub token。用法：\n` +
      `  node scripts/deploy-to-github.mjs <token>\n` +
      `  或设置 env GITHUB_TOKEN，或把 token 存到 ~/.bizhi-token\n` +
      `  token 创建：github.com → Settings → Developer settings →\n` +
      `  Fine-grained tokens（只选 bizhi 仓库，Contents + Pages 读写）`
  );
  process.exit(1);
}

/* ------------------------------ API 基础封装 ------------------------------ */

const step = (msg) => console.log(`\n[deploy] ${msg}`);

async function api(method, urlPath, body, { ok404 = false, raw = false } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bizhi-deploy-script",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  if (res.status === 404 && ok404) return { status: 404, data: null };
  if (res.status === 401) {
    throw new Error("token 无效或已过期（401），请重新生成");
  }
  if (res.status === 403) {
    const text = await res.text();
    throw new Error(`权限不足（403）：${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (raw) return { status: res.status, data: await res.arrayBuffer() };
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}

/** 带退避重试（api.github.com 偶发 5xx / 二次限流） */
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

function collectFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = path.join(d, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else out.push({ abs: full, rel: relPath, size: fs.statSync(full).size });
    }
  };
  walk(dir, "");
  return out;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error(
      `未找到 ${DIST}/index.html —— 请先执行: node scripts/build-gh-pages.mjs ${BASE_PATH}`
    );
  }

  step(`① 校验仓库 ${OWNER}/${REPO} 与 token`);
  const repo = await apiRetry("GET", `/repos/${OWNER}/${REPO}`);
  console.log(`    仓库: ${repo.data.full_name}（${repo.data.private ? "私有" : "公开"}）`);
  const defaultBranch = repo.data.default_branch || BRANCH;
  if (defaultBranch !== BRANCH) {
    console.log(`    注意：仓库默认分支为 ${defaultBranch}，本脚本仍使用 ${BRANCH}`);
  }

  step("② 收集静态文件并上传 blob");
  const files = collectFiles(DIST);
  const totalMB = (files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2);
  console.log(`    ${files.length} 个文件，共 ${totalMB} MB`);
  if (files.length === 0) throw new Error("没有可部署的文件");

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
        return {
          path: f.rel,
          mode: "100644",
          type: "blob",
          sha: blob.data.sha,
        };
      })
    );
    treeEntries.push(...results);
    done += chunk.length;
    process.stdout.write(`    blobs: ${done}/${files.length}\r`);
  }
  console.log(`    blobs: ${done}/${files.length} ✔`);

  step("③ 创建 tree（整树替换 = 镜像，仓库旧文件自动清除）");
  const tree = await apiRetry("POST", `/repos/${OWNER}/${REPO}/git/trees`, {
    tree: treeEntries,
  });
  console.log(`    tree: ${tree.data.sha}`);

  step("④ 查询当前 main 分支（空仓库则无父提交）");
  const head = await apiRetry("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, undefined, {
    ok404: true,
  });
  const parentSha = head.data ? head.data.object.sha : null;
  console.log(parentSha ? `    父提交: ${parentSha.slice(0, 10)}` : "    空仓库，将创建首个提交");

  step("⑤ 创建提交");
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const commit = await apiRetry("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `deploy 壁纸工坊 网页版 → ${SITE_URL}（${stamp} UTC，${files.length} 文件）`,
    tree: tree.data.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  });
  console.log(`    commit: ${commit.data.sha.slice(0, 10)}`);

  step(`⑥ ${parentSha ? "推进" : "创建"} ${BRANCH} 分支`);
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

  step("⑦ 开启 GitHub Pages（main 分支根目录）");
  const pages = await apiRetry("GET", `/repos/${OWNER}/${REPO}/pages`, undefined, { ok404: true });
  if (pages.data) {
    console.log(`    Pages 已启用：${pages.data.html_url}（本次推送后约 1 分钟内更新）`);
  } else {
    try {
      const created = await apiRetry("POST", `/repos/${OWNER}/${REPO}/pages`, {
        source: { branch: BRANCH, path: "/" },
      });
      console.log(`    Pages 已开启：${created.data.html_url}`);
    } catch (e) {
      console.log(`    ⚠ Pages 自动开启失败（${String(e.message).slice(0, 120)}）`);
      console.log(`      请手动：仓库 Settings → Pages → Deploy from a branch → ${BRANCH} / (root)`);
    }
  }

  console.log(`\n[deploy] 完成 ✔  站点地址：${SITE_URL}`);
  console.log(`  首次部署 Pages 构建约需 1-2 分钟，稍候刷新即可。`);
  console.log(`  提醒：token 用完可到 GitHub → Settings → Developer settings 撤销。`);
}

main().catch((e) => {
  console.error(`\n[deploy] 失败：${e.message}`);
  process.exit(1);
});
