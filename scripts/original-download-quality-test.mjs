/**
 * 壁纸工坊 · 原图下载质量自动校验（original-download-quality-test）
 * ============================================================
 * 运行：bun scripts/original-download-quality-test.mjs
 * 可选：WW_TEST_TOKEN=<官网登录令牌> 时追加「真实令牌全链路对比」。
 *
 * v1.4.13 为根治「下载的图片模糊、只有几十 KB」而生。本脚本用真实网络
 * 请求取证 + 真实字节样本校验，验证以下断言（任一失败即退出码 1）：
 *
 * A. 官网 CDN 直链（未登录）：必须只回 webp 预览（≤1100px / ≤56KB 级），
 *    证明「直连 .png 直链拿到的绝不是原图」—— 这就是旧版模糊小图的来源。
 * B. 官网 getCompleteUrl（未登录）：必须 401，证明原图仅对登录用户开放。
 * C. 质量校验器（desktop/image-quality.js 与 src/lib/image-quality.ts 双生）：
 *    - 官网真实预览字节（890px 与 1100px 两档）→ 必须 REJECT
 *    - 合法大图（真像素 PNG 3840×2160、SOF0 JPEG 头、VP8X WebP 头）→ 必须 PASS
 *    - 低分辨率小图 / 随机字节 → 必须 REJECT
 *    - webp 字节必须得到 .webp 扩展名（杜绝 preview.webp 改名 .png）
 * D.（需令牌）真实令牌全链路：ALTCHA → getCompleteUrl → 下载原图 → 校验器
 *    PASS，输出与官网原图的尺寸/大小/SHA-256 对比表。无令牌时 SKIP 并说明。
 */

import { createHash, randomUUID } from "node:crypto";
import zlib from "node:zlib";

const API_BASE = "https://haowallpaper.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* 双生校验器：桌面版（CJS）与服务器版（TS）必须给出完全一致的结果 */
const { validateOriginalImage: validateCjs, parseImageInfo: parseCjs } = await import(
  "../desktop/image-quality.js"
);
const { validateOriginalImage: validateTs, parseImageInfo: parseTs } = await import(
  "../src/lib/image-quality.ts"
);

let failures = 0;
let passes = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) {
    passes += 1;
    results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function kb(n) {
  return `${(n / 1024).toFixed(1)}KB`;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

const zfHeaders = (extra = {}) => ({
  "User-Agent": UA,
  Referer: `${API_BASE}/`,
  Accept: "application/json, text/plain, */*",
  ...extra,
});

/* ---------------- 官网真实列表取样 ---------------- */

async function fetchOfficialSamples(count = 3) {
  const res = await fetch(`${API_BASE}/homeView?page=1&sortType=3&rows=12&wpType=1`, {
    headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`官网列表页 HTTP ${res.status}`);
  const html = await res.text();
  const chunks = html.split('<div class="card"');
  const samples = [];
  for (let i = 1; i < chunks.length && samples.length < count; i++) {
    const img = /<img[^>]+src="(https:\/\/img\.haowallpaper\.com\/cache_file\/[^"?]+)"/.exec(chunks[i]);
    const alt = /alt="([^"]*)"/.exec(chunks[i]);
    if (!img) continue;
    samples.push({ src: img[1], title: (alt?.[1] ?? "").slice(0, 24) });
  }
  return samples;
}

/* ---------------- ALTCHA（与主进程实现一致） ---------------- */

async function runCertification() {
  const chalRes = await fetch(`${API_BASE}/link/pc/certify/challenge`, {
    headers: { "User-Agent": UA, Referer: `${API_BASE}/`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const cookie =
    chalRes.headers
      .getSetCookie?.()
      ?.find((c) => c.startsWith("server_session_"))
      ?.split(";")[0] ?? null;
  const challenge = await chalRes.json();
  let number = null;
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (createHash("sha256").update(challenge.salt + n).digest("hex") === challenge.challenge) {
      number = n;
      break;
    }
  }
  if (number === null) throw new Error("ALTCHA PoW 求解失败");
  const payload = Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number,
      salt: challenge.salt,
      signature: challenge.signature,
    })
  ).toString("base64");
  const verifyRes = await fetch(
    `${API_BASE}/link/pc/certify/verify?__media=1&__responseCodec=aeg-v2`,
    {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Referer: `${API_BASE}/`,
        Origin: API_BASE,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(20000),
    }
  );
  const refreshed =
    verifyRes.headers
      .getSetCookie?.()
      ?.find((c) => c.startsWith("server_session_"))
      ?.split(";")[0] ?? null;
  const json = await verifyRes.json().catch(() => null);
  if (Number(json?.status ?? -1) !== 200) throw new Error(`ALTCHA 验证未通过：${JSON.stringify(json)}`);
  return refreshed || cookie;
}

function digUrl(data, depth = 0) {
  if (depth > 3) return null;
  if (typeof data === "string") return /^https?:\/\//.test(data) ? data : null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const key of ["url", "completeUrl", "downUrl", "link"]) {
    if (typeof data[key] === "string" && /^https?:\/\//.test(data[key])) return data[key];
  }
  return digUrl(data.data, depth + 1);
}

/* ---------------- 测试字节构造 ---------------- */

/** 生成真实可解码的 PNG（简单渐变像素，zlib 压缩后很小但 IHDR 尺寸真实） */
function makePng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte + RGB
    for (let x = 0; x < width; x++) {
      // 低频渐变：zlib 高度可压，字节真实有效
      row[1 + x * 3] = (x / width) * 255;
      row[2 + x * 3] = (y / height) * 255;
      row[3 + x * 3] = 128;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  // 真实 CRC32（PNG 规范）
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunkReal = (type, data) => {
    // PNG 规范 chunk 头：4 字节长度（BE）在前、4 字节类型在后
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkReal("IHDR", ihdr),
    chunkReal("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunkReal("IEND", Buffer.alloc(0)),
  ]);
}

/** 手工构造 JPEG 头（SOI + SOF0 声明尺寸；校验器只解析头部） */
function makeJpegHeader(width, height) {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17 - 2, 0); // 段长
  sof[2] = 8; // precision
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3; // 3 分量
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** 手工构造 WebP VP8X 头（canvas 尺寸真实声明） */
function makeWebpVp8x(width, height) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x10; // 有 alpha 标记（任意合法 flags）
  const w = width - 1;
  const h = height - 1;
  payload[4] = w & 0xff;
  payload[5] = (w >> 8) & 0xff;
  payload[6] = (w >> 16) & 0xff;
  payload[7] = h & 0xff;
  payload[8] = (h >> 8) & 0xff;
  payload[9] = (h >> 16) & 0xff;
  const head = Buffer.alloc(8);
  head.write("VP8X", 0, "latin1");
  head.writeUInt32LE(10, 4);
  const body = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), head, payload]);
  body.writeUInt32LE(body.length - 8, 4); // RIFF size
  return body;
}

/* ================= 主流程 ================= */

console.log("壁纸工坊 · 原图下载质量自动校验（original-download-quality-test）");
console.log("=".repeat(72));

let samples = [];
try {
  samples = await fetchOfficialSamples(3);
} catch (e) {
  console.error(`官网列表抓取失败：${e.message}`);
  process.exit(1);
}
console.log(`\n官网实时取样 ${samples.length} 张：`);
for (const s of samples) console.log(`  - ${s.title}  ${s.src}`);

/* ---------- 测试 A：官网 CDN 直链（未登录）必须只给预览 ---------- */

console.log("\n[A] 官网 CDN 直链（未登录）行为取证：");
const previewBytesList = [];
for (const s of samples) {
  try {
    const res = await fetch(s.src, {
      headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
      signal: AbortSignal.timeout(20000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get("content-type") ?? "").split(";")[0];
    const info = parseCjs(buf);
    previewBytesList.push(buf);
    const isPreview = !!(info && Math.max(info.width, info.height) <= 1100);
    check(
      `A: ${s.title} 直链为预览（${info?.format ?? "?"} ${info?.width}x${info?.height} ${kb(buf.length)}，CT=${ct}，HTTP ${res.status}）`,
      res.status === 200 && isPreview && /webp/.test(ct),
      `sha256:${sha256(buf)}`
    );
  } catch (e) {
    check(`A: ${s.title} 直链请求`, false, e.message);
  }
}

/* ---------- 测试 B：getCompleteUrl（未登录）必须 401 ---------- */

console.log("\n[B] 官网 getCompleteUrl（未登录）必须 401（原图仅登录用户开放）：");
try {
  const cookie = await runCertification();
  check("B: ALTCHA 人机验证（未登录可通过）", !!cookie);
  const res = await fetch(
    `${API_BASE}/link/common/file/getCompleteUrl/${samples[0].src
      .split("/")
      .pop()
      .replace(/\.\w+$/, "")}?__media=1&__responseCodec=aeg-v2`,
    { headers: zfHeaders(cookie ? { Cookie: cookie } : {}), signal: AbortSignal.timeout(15000) }
  );
  const json = await res.json().catch(() => null);
  check(
    `B: getCompleteUrl 无令牌 → HTTP ${res.status}（status=${json?.status}）`,
    res.status === 401 || Number(json?.status) === 401,
    String(json?.msg ?? "").slice(0, 40)
  );
} catch (e) {
  check("B: getCompleteUrl 链路", false, e.message);
}

/* ---------- 测试 C：质量校验器（双生模块逐字节对齐） ---------- */

console.log("\n[C] 质量校验器断言（desktop CJS 与 src/lib TS 双生一致）：");
const png4k = makePng(3840, 2160);
const pngSmall = makePng(800, 600);
const jpegHead = makeJpegHeader(4096, 2160);
const webpHead = makeWebpVp8x(3840, 2160);
const randomBytes = createHash("sha256").update(randomUUID()).digest();

// 官方 previewFileImg 1100px 预览真实字节（另一档预览，也必须被拒绝）
let preview1100 = null;
try {
  const fid = samples[0].src.split("/").pop().replace(/\.\w+$/, "");
  const r = await fetch(
    `${API_BASE}/link/common/file/previewFileImg/${fid}?__media=1&__responseCodec=aeg-v2`,
    { headers: { "User-Agent": UA, Referer: `${API_BASE}/` }, redirect: "follow", signal: AbortSignal.timeout(20000) }
  );
  preview1100 = Buffer.from(await r.arrayBuffer());
  const pinfo = parseCjs(preview1100);
  console.log(`  官方 previewFileImg 取样：${pinfo?.format ?? "?"} ${pinfo?.width}x${pinfo?.height} ${kb(preview1100.length)}`);
} catch (e) {
  console.log(`  官方 previewFileImg 取样失败（跳过该样本）：${e.message}`);
}

const cjsCases = [
  ["官网 890px 预览字节必须 REJECT", previewBytesList[0], false],
  ["真像素 PNG 3840×2160 必须 PASS", png4k, true],
  ["SOF0 JPEG 头 4096×2160 必须 PASS", jpegHead, true],
  ["VP8X WebP 头 3840×2160 必须 PASS", webpHead, true],
  ["低分辨率 PNG 800×600 必须 REJECT", pngSmall, false],
  ["随机字节必须 FORMAT_UNKNOWN", randomBytes, false],
];
if (preview1100 && parseCjs(preview1100)) {
  cjsCases.splice(1, 0, ["官网 1100px 官方预览必须 REJECT", preview1100, false]);
}
for (const [name, buf, expectOk] of cjsCases) {
  const r1 = validateCjs(buf);
  const r2 = validateTs(buf);
  check(`C(CJS): ${name}`, r1.ok === expectOk, r1.ok ? `${r1.width}x${r1.height} ${r1.format}` : (r1.msg ?? r1.code));
  check(`C(TS) : ${name}`, r2.ok === expectOk, `与 CJS 一致：${JSON.stringify({ ok: r2.ok, w: r2.width, h: r2.height }) === JSON.stringify({ ok: r1.ok, w: r1.width, h: r1.height })}`);
}

// 扩展名反伪装：webp 字节必须得到 .webp 扩展名（绝不能按 URL/名字改成 .png）
{
  const r = validateCjs(previewBytesList[0]);
  check(
    "C: webp 字节 → 扩展名必须是 .webp（防 preview.webp 改名 .png）",
    r.ext === "webp",
    `ext=${r.ext}`
  );
}

/* ---------- 测试 C2：桌面主进程下载链路集成（stub 官网，字节真实） ---------- */

console.log("\n[C2] 桌面主进程 downloadOriginal 集成断言（zf-login.js + 质量闸门）：");
try {
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  const { createLoginModule } = await import("../desktop/zf-login.js");

  const realFetch = globalThis.fetch;
  const tmpDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "ww-qtest-"));
  const savedFiles = [];

  const makeModule = () =>
    createLoginModule({
      readSettings: () => ({ zfToken: "integration-test-token-1234567890" }),
      writeSettings: () => {},
      getSaveDir: () => tmpDir,
      uniqueSavePath: (dir, name) => {
        let p = pathMod.join(dir, name);
        let i = 1;
        while (fsMod.existsSync(p)) p = pathMod.join(dir, name.replace(/(\.\w+)$/, ` ($1)`).replace(".", `(${i}).`));
        return p;
      },
    });

  // 场景 1：getCompleteUrl 换链成功，但 CDN 回的是官网真实 890px 预览字节
  // → 主进程必须拒绝保存（quality-mismatch），保存目录必须没有新文件
  {
    const mod = makeModule();
    const origReaddir = fsMod.readdirSync(tmpDir);
    globalThis.fetch = async (url) => {
      if (String(url).includes("getCompleteUrl")) {
        return new Response(JSON.stringify({ status: 200, data: { url: "https://fake-cdn/original.png" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      // 原图直链请求：回真实官网预览字节（测试 A 已下载的 890px webp）
      return new Response(new Uint8Array(previewBytesList[0]), {
        headers: { "content-type": "image/webp" },
      });
    };
    const r = await mod.downloadOriginal("2026102100000001", "集成测试-预览拦截");
    const filesNow = fsMod.readdirSync(tmpDir);
    check(
      "C2: CDN 回预览字节 → downloadOriginal 必须拒绝（quality-mismatch）",
      r.ok === false && r.reason === "quality-mismatch",
      r.msg ?? ""
    );
    check(
      "C2: 拒绝时保存目录零新增文件",
      filesNow.length === origReaddir.length,
      `files=${filesNow.length}`
    );
  }

  // 场景 2：CDN 回合成 3840×2160 真像素 PNG → 必须成功保存且扩展名 .png
  {
    const mod = makeModule();
    globalThis.fetch = async (url) => {
      if (String(url).includes("getCompleteUrl")) {
        return new Response(JSON.stringify({ status: 200, data: { url: "https://fake-cdn/original.png" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(png4k), { headers: { "content-type": "image/png" } });
    };
    const r = await mod.downloadOriginal("2026102100000002", "集成测试-原图放行");
    check(
      "C2: 4K 原图字节 → downloadOriginal 必须成功（original）",
      r.ok === true && r.quality === "original" && r.width === 3840 && r.height === 2160,
      r.savedPath ? pathMod.basename(r.savedPath) : JSON.stringify(r).slice(0, 80)
    );
    if (r.savedPath) {
      savedFiles.push(r.savedPath);
      const ext = pathMod.extname(r.savedPath).slice(1);
      check("C2: 成功保存的扩展名必须是 .png（真实内容）", ext === "png", `ext=${ext}`);
      const onDisk = fsMod.statSync(r.savedPath).size;
      check("C2: 落盘字节数与下载字节一致", onDisk === png4k.length, `${onDisk}B`);
    }
  }

  // 场景 3：令牌缺失 → no-token（不发起任何下载）
  {
    const mod = createLoginModule({
      readSettings: () => ({}),
      writeSettings: () => {},
      getSaveDir: () => tmpDir,
      uniqueSavePath: (d, n) => pathMod.join(d, n),
    });
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const r = await mod.downloadOriginal("2026102100000003", "集成测试-无令牌");
    check(
      "C2: 无令牌 → no-token 且不发起网络请求",
      r.ok === false && r.reason === "no-token" && fetchCalled === false
    );
  }

  globalThis.fetch = realFetch;
  for (const f of savedFiles) fsMod.rmSync(f, { force: true });
  fsMod.rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {
  check("C2: 桌面主进程集成链路", false, e.message);
}

/* ---------- 测试 D：真实令牌全链路（可选） ---------- */

console.log("\n[D] 真实令牌全链路（WW_TEST_TOKEN 提供时执行）：");
const token = process.env.WW_TEST_TOKEN;
if (!token) {
  console.log("  SKIP — 未提供 WW_TEST_TOKEN。");
  console.log("  说明：A/B 已实证「未登录拿不到原图」（CDN 只回预览 + getCompleteUrl 401），");
  console.log("  校验器 C 已实证「预览字节必被拒绝」。带令牌的官网原图对比请在桌面版");
  console.log("  扫码登录后执行：WW_TEST_TOKEN=<token> bun scripts/original-download-quality-test.mjs");
} else {
  try {
    const cookie = await runCertification();
    for (const s of samples) {
      const wtId = s.src.split("/").pop().replace(/\.\w+$/, "");
      const res = await fetch(
        `${API_BASE}/link/common/file/getCompleteUrl/${wtId}?__media=1&__responseCodec=aeg-v2`,
        { headers: zfHeaders({ token, ...(cookie ? { Cookie: cookie } : {}) }), signal: AbortSignal.timeout(15000) }
      );
      const json = await res.json().catch(() => null);
      const target = digUrl(json);
      if (!target) {
        check(`D: ${s.title} getCompleteUrl（令牌）`, false, `HTTP ${res.status} ${String(json?.msg ?? "").slice(0, 40)}`);
        continue;
      }
      const dl = await fetch(target, {
        headers: zfHeaders({ token }),
        signal: AbortSignal.timeout(120000),
      });
      const buf = Buffer.from(await dl.arrayBuffer());
      const v = validateCjs(buf);
      check(
        `D: ${s.title} 原图下载+校验 PASS（${v.width}x${v.height} ${kb(buf.length)} ${v.format}）`,
        dl.ok && v.ok,
        `sha256:${sha256(buf)}`
      );
    }
  } catch (e) {
    check("D: 令牌全链路", false, e.message);
  }
}

/* ---------- 汇总 ---------- */

console.log("\n" + "-".repeat(72));
console.log("结果明细：");
console.log(results.join("\n"));
console.log("-".repeat(72));
console.log(`合计：${passes} 通过 / ${failures} 失败`);
if (failures > 0) {
  console.log("\nDOWNLOAD QUALITY TEST FAILED —— 存在断言失败，禁止发布。");
  process.exit(1);
}
console.log("\nALL QUALITY CHECKS PASSED —— 未登录拿不到原图（官网机制）+ 预览字节必被拒绝 + 合法原图必被放行。");
process.exit(0);
