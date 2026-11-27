/**
 * 壁纸工坊 · 原图下载完整性自动校验（original-download-quality-test）
 * ============================================================
 * 运行：bun scripts/original-download-quality-test.mjs
 * 可选：WW_TEST_TOKEN=<官网登录令牌> 时追加「真实令牌金基准对比」。
 *
 * v1.4.14 为「下载文件必须与官网原图完全一致（不裁切/不缩放/不改比例/
 * 不重压缩/不伪装）」而生。本脚本用真实网络请求取证 + 真实/合成字节样本
 * 校验，验证以下断言（任一失败即退出码 1）：
 *
 * A.  官网 CDN 直链（未登录）：cache_file 与 pre_cache_file（JSON-LD 官方
 *     contentUrl）都只回 webp 预览（≤1100px）——「未登录拿不到原图」实证。
 * B.  官网 getCompleteUrl（未登录）：必须 401，原图仅对登录用户开放。
 * M.  官网原图基准（Golden Reference）：≥3 张不同类型壁纸（电脑 4K/7K +
 *     手机竖屏），详情页 JSON-LD 官方元数据（width/height/contentUrl/
 *     contentSize）全部可解析、宽高为正整数、宽高比一致 —— 这是期望宽高
 *     的唯一权威来源（不硬编码任何固定尺寸）。
 * T.  完整性十项测试（合成字节 + 期望值，双生校验器 CJS/TS 一致）：
 *     T1  正确原图（4096×2160 PNG 8MB）→ PASS
 *     T2  相同文件大小但分辨率错误（1920×1080 补齐到同样 8MB）→ FAIL
 *         DOWNLOAD_RESOLUTION_MISMATCH（证明「只看文件大小」永远过不了关）
 *     T3  分辨率错误但接近（3840×2160，非官网 4096×2160）→ FAIL
 *     T4  裁切（4096×2000）→ FAIL
 *     T5  缩放（2048×1080）→ FAIL
 *     T6  宽高比改变（4096×2048）→ FAIL
 *     T7  WebP 预览（890×556 25KB 官网真实字节）→ FAIL
 *     T8  真实内容 WebP 伪装 .png（期望 png 格式）→ FAIL
 *         DOWNLOAD_FORMAT_MISMATCH
 *     T9  真实 4K PNG（4096×2160）→ PASS
 *     T10 更高分辨率（7680×4320 / 5120×2880，按各自期望）→ PASS；
 *         反向证明无 4096 硬编码（4096×2160 对期望 7680×4320 → FAIL）
 *     附加：SHA-256 期望一致 → PASS / 不一致 → FAIL（字节级证明）；
 *           体积下限（同尺寸重压缩缩水）→ FAIL
 * C.  质量校验器兜底闸门（无期望值时）：官网 890px/1100px 预览必须 REJECT，
 *     合法大图 PASS，webp 字节得到 .webp 扩展名（防改名伪装）。
 * C2. 桌面主进程 downloadOriginal 集成（stub 官网接口、真实字节）：
 *     分辨率不符拒绝且零落盘；期望匹配放行且落盘字节 SHA 与下载字节一致
 *     （原始字节直写证明）；元数据不可用退回预览兜底闸门；无令牌零请求。
 * D.（需令牌）金基准全链路：官网元数据 → getCompleteUrl → 直链参考下载
 *     → 项目链路（zf-login 模块）下载落盘 → 逐项对比 Width/Height/AR/
 *     Format/Size/SHA-256，输出官网 vs 项目对比表。无令牌时 SKIP 并说明。
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
const { validateOriginalImage: validateTs } = await import(
  "../src/lib/image-quality.ts"
);
const { fetchOfficialOriginalMeta } = await import("../desktop/zf-meta.js");

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

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/** 完整 SHA-256（hex 64）；展示时可再截断 */
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const zfHeaders = (extra = {}) => ({
  "User-Agent": UA,
  Referer: `${API_BASE}/`,
  Accept: "application/json, text/plain, */*",
  ...extra,
});

/* ---------------- 官网真实列表取样 ---------------- */

async function fetchOfficialSamples(count = 3, wpType = 1) {
  const res = await fetch(`${API_BASE}/homeView?page=1&sortType=3&rows=12&wpType=${wpType}`, {
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
    const look = /href="\/homeViewLook\/([0-9]{6,32})"/.exec(chunks[i]);
    if (!img) continue;
    samples.push({
      src: img[1],
      title: (alt?.[1] ?? "").slice(0, 24),
      wtId: look ? look[1] : null,
    });
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

/** PNG CRC32 表（规范实现） */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
  return Buffer.concat([head, data, crc]);
}

/**
 * 生成真实可解码的 PNG。
 * gradient（默认）：低频渐变，zlib 高度可压（小体积、尺寸真实）；
 * noise：伪随机像素（几乎不可压，用于构造「8MB 级大文件」场景）。
 */
function makePng(width, height, { noise = false } = {}) {
  const rows = [];
  let seed = 0x2f6e2b1 ^ width ^ (height << 3);
  const rand = () => {
    // xorshift32：确定性伪随机（同一参数生成完全一致的字节，测试可复现）
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed & 0xff;
  };
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte + RGB
    for (let x = 0; x < width; x++) {
      if (noise) {
        row[1 + x * 3] = rand();
        row[2 + x * 3] = rand();
        row[3 + x * 3] = rand();
      } else {
        row[1 + x * 3] = (x / width) * 255;
        row[2 + x * 3] = (y / height) * 255;
        row[3 + x * 3] = 128;
      }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 把 PNG 补齐到精确字节数（IEND 之后追加注释块，头部宽高不变）——
 *  用于构造「文件大小一样但分辨率不同」的对抗样本 */
function padPngTo(png, totalBytes) {
  if (png.length >= totalBytes) return png;
  const pad = Buffer.alloc(totalBytes - png.length, 0x20);
  return Buffer.concat([png, pad]);
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

console.log("壁纸工坊 · 原图下载完整性自动校验（original-download-quality-test v1.4.14）");
console.log("=".repeat(72));

let samples = [];
let phoneSamples = [];
try {
  samples = await fetchOfficialSamples(3, 1);
  phoneSamples = await fetchOfficialSamples(1, 2);
} catch (e) {
  console.error(`官网列表抓取失败：${e.message}`);
  process.exit(1);
}
console.log(`\n官网实时取样 ${samples.length} 张（电脑）+ ${phoneSamples.length} 张（手机）：`);
for (const s of samples) console.log(`  - ${s.title}  ${s.src}  wtId=${s.wtId}`);
for (const s of phoneSamples) console.log(`  - ${s.title}  ${s.src}  wtId=${s.wtId}`);

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
      `A: ${s.title} cache_file 直链为预览（${info?.format ?? "?"} ${info?.width}x${info?.height} ${kb(buf.length)}，CT=${ct}，HTTP ${res.status}）`,
      res.status === 200 && isPreview && /webp/.test(ct),
      `sha256:${sha256(buf).slice(0, 16)}`
    );
  } catch (e) {
    check(`A: ${s.title} 直链请求`, false, e.message);
  }
}

/* ---------- 测试 M：官网原图基准（Golden Reference 元数据） ---------- */

console.log("\n[M] 官网原图基准（详情页 JSON-LD 官方元数据，期望宽高的唯一权威来源）：");
const golden = []; // { wtId, title, meta, contentUrlPreview }
const metaSamples = [
  ...samples.map((s) => ({ ...s, kind: "电脑" })),
  ...phoneSamples.map((s) => ({ ...s, kind: "手机" })),
].filter((s) => s.wtId);

for (const s of metaSamples) {
  try {
    const meta = await fetchOfficialOriginalMeta(s.wtId);
    if (!meta) {
      check(`M: ${s.title}（${s.kind}）官方元数据可解析`, false, "详情页 JSON-LD 未取到 width/height");
      continue;
    }
    const ar = Math.round((meta.width / meta.height) * 1e6) / 1e6;
    check(
      `M: ${s.title}（${s.kind}）官方元数据：${meta.width}×${meta.height} AR=${ar} size=${meta.contentSizeBytes ? mb(meta.contentSizeBytes) : "?"}`,
      Number.isInteger(meta.width) && meta.width > 0 && Number.isInteger(meta.height) && meta.height > 0 &&
        /^https:\/\/img\.haowallpaper\.com\//.test(meta.contentUrl)
    );
    golden.push({ wtId: s.wtId, title: s.title, kind: s.kind, meta });

    // A2：官方 contentUrl（pre_cache_file）未登录也只回预览 —— 证明
    // 「元数据公开，但原图字节仅登录可得」，同时记录预览实况
    try {
      const r2 = await fetch(meta.contentUrl, {
        headers: { "User-Agent": UA, Referer: `${API_BASE}/` },
        signal: AbortSignal.timeout(20000),
      });
      const b2 = Buffer.from(await r2.arrayBuffer());
      const i2 = parseCjs(b2);
      const isPreview = !!(i2 && Math.max(i2.width, i2.height) <= 1100);
      check(
        `A2: ${s.title} contentUrl 未登录只回预览（${i2?.format ?? "?"} ${i2?.width}x${i2?.height} ${kb(b2.length)}，HTTP ${r2.status}）`,
        r2.status === 200 && isPreview && /webp/.test(r2.headers.get("content-type") ?? "")
      );
    } catch (e) {
      check(`A2: ${s.title} contentUrl 未登录取证`, false, e.message);
    }
  } catch (e) {
    check(`M: ${s.title} 官方元数据`, false, e.message);
  }
}
check("M: 基准覆盖 ≥3 张不同类型壁纸", golden.length >= 3, `实际 ${golden.length} 张`);

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

/* ---------- 测试 T：完整性十项（期望值硬校验，双生一致） ---------- */

console.log("\n[T] 原图完整性十项测试（合成字节 + 官方期望值；desktop CJS 与 src/lib TS 双生一致）：");

const T = (name, buf, expect, expectOk, expectCode) => {
  const r1 = validateCjs(buf, expect);
  const r2 = validateTs(buf, expect);
  const okCode = expectCode ? r1.code === expectCode : true;
  check(`T(CJS): ${name}`, r1.ok === expectOk && okCode, r1.ok ? `${r1.width}x${r1.height} ${r1.format}` : (r1.code ?? r1.msg ?? ""));
  check(
    `T(TS) : ${name}`,
    r2.ok === expectOk && r2.code === r1.code,
    `与 CJS 一致：${JSON.stringify({ ok: r2.ok, code: r2.code, w: r2.width, h: r2.height }) === JSON.stringify({ ok: r1.ok, code: r1.code, w: r1.width, h: r1.height })}`
  );
};

const TARGET_8MB = 8 * 1024 * 1024;
const EXP_4K = { width: 4096, height: 2160 };

// T1 正确原图：4096×2160 PNG，补到 8MB → PASS
const t1 = padPngTo(makePng(4096, 2160), TARGET_8MB);
T("T1 正确原图 4096×2160 PNG 8MB → PASS", t1, EXP_4K, true);

// T2 相同文件大小但分辨率错误：1920×1080 补到同样的 8MB → FAIL
// （证明「只看文件大小」永远过不了关；宽高是硬性指标）
const t2 = padPngTo(makePng(1920, 1080), TARGET_8MB);
T("T2 同为 8MB 但 1920×1080 → FAIL(RESOLUTION)", t2, EXP_4K, false, "DOWNLOAD_RESOLUTION_MISMATCH");

// T3 分辨率错误但接近（3840×2160，不是官网 4096×2160）→ FAIL
const t3 = padPngTo(makePng(3840, 2160), TARGET_8MB);
T("T3 3840×2160（非官网 4096×2160）→ FAIL(RESOLUTION)", t3, EXP_4K, false, "DOWNLOAD_RESOLUTION_MISMATCH");

// T4 裁切：4096×2000（宽对高错，画面被裁）→ FAIL
const t4 = padPngTo(makePng(4096, 2000), TARGET_8MB);
T("T4 裁切 4096×2000 → FAIL(RESOLUTION)", t4, EXP_4K, false, "DOWNLOAD_RESOLUTION_MISMATCH");

// T5 缩放：2048×1080（等比缩小一半）→ FAIL
const t5 = padPngTo(makePng(2048, 1080), TARGET_8MB);
T("T5 缩放 2048×1080 → FAIL(RESOLUTION)", t5, EXP_4K, false, "DOWNLOAD_RESOLUTION_MISMATCH");

// T6 宽高比改变：4096×2048（宽对高错且 AR 1.999… ≠ 1.896…）→ FAIL
const t6 = padPngTo(makePng(4096, 2048), TARGET_8MB);
T("T6 宽高比改变 4096×2048 → FAIL(RESOLUTION)", t6, EXP_4K, false, "DOWNLOAD_RESOLUTION_MISMATCH");

// T7 WebP 预览：官网真实 890×556 字节 → FAIL（有期望值时按分辨率拒）
if (previewBytesList[0]) {
  T("T7 官网 890×556 WebP 预览 → FAIL", previewBytesList[0], EXP_4K, false, "DOWNLOAD_RESOLUTION_MISMATCH");
}

// T8 真实内容 WebP 伪装 .png：4096×2160 webp 字节 + 期望 png → FAIL(FORMAT)
const t8 = makeWebpVp8x(4096, 2160);
T("T8 WebP 字节伪装 PNG（期望 png）→ FAIL(FORMAT)", t8, { ...EXP_4K, format: "png" }, false, "DOWNLOAD_FORMAT_MISMATCH");

// T9 真实 4K PNG（渐变真像素，可解码）→ PASS
const t9 = makePng(4096, 2160);
T("T9 真实 4K PNG 4096×2160 → PASS", t9, EXP_4K, true);

// T10 无 4096 硬编码：7680×4320 / 5120×2880 按各自期望 PASS；
//     4096×2160 对期望 7680×4320 必须 FAIL（证明尺寸来自当前壁纸元数据）
const t10a = makePng(7680, 4320);
T("T10a 7680×4320 按期望 7680×4320 → PASS", t10a, { width: 7680, height: 4320 }, true);
const t10b = makePng(5120, 2880);
T("T10b 5120×2880 按期望 5120×2880 → PASS", t10b, { width: 5120, height: 2880 }, true);
T("T10c 4096×2160 对期望 7680×4320 → FAIL（无硬编码放行）", t9, { width: 7680, height: 4320 }, false, "DOWNLOAD_RESOLUTION_MISMATCH");

// 附加：SHA-256 期望（字节级一致性证明）
{
  const buf = makePng(4096, 2160, { noise: true });
  const good = sha256(buf);
  const r = validateCjs(buf, { ...EXP_4K, sha256: good });
  check("T-SHA: 字节与期望 SHA-256 一致 → PASS", r.ok === true, `sha256:${good.slice(0, 16)}`);
  const tampered = Buffer.from(buf);
  tampered[tampered.length - 10] ^= 0xff; // 改 1 字节（同尺寸同格式）
  const r2 = validateCjs(tampered, { ...EXP_4K, sha256: good });
  check(
    "T-SHA: 同尺寸同格式但 1 字节不同 → FAIL(SHA)",
    r2.ok === false && r2.code === "DOWNLOAD_SHA256_MISMATCH",
    r2.code ?? ""
  );
  const r2ts = validateTs(tampered, { ...EXP_4K, sha256: good });
  check("T-SHA: TS 孪生一致拒绝", r2ts.ok === false && r2ts.code === r2.code);
}

// 附加：体积下限（同尺寸重压缩缩水）→ FAIL
{
  const tiny = makePng(4096, 2160); // 渐变高度可压，远小于 4MB
  const r = validateCjs(tiny, { ...EXP_4K, minBytes: 4 * 1024 * 1024 });
  check(
    "T-SIZE: 4096×2160 但体积缩水（重压缩嫌疑）→ FAIL(SIZE)",
    r.ok === false && r.code === "DOWNLOAD_SIZE_MISMATCH",
    `${kb(tiny.length)} < 4MB`
  );
}

/* ---------- 测试 C：质量校验器兜底闸门（无期望值时） ---------- */

console.log("\n[C] 质量校验器兜底闸门（元数据不可用时，双生模块逐字节对齐）：");
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

console.log("\n[C2] 桌面主进程 OriginalDownloadService 集成断言（original-download.js + zf-certify.js + zf-meta.js + history-db.js + 质量闸门）：");
try {
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  const { createLoginModule } = await import("../desktop/zf-login.js");
  const { createHistoryDb } = await import("../desktop/history-db.js");
  const { createOriginalDownloadService } = await import("../desktop/original-download.js");

  const realFetch = globalThis.fetch;
  const tmpDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "ww-qtest-"));
  const savedFiles = [];
  const pngFiles = () => fsMod.readdirSync(tmpDir).filter((f) => f.endsWith(".png") || f.endsWith(".webp"));

  /** 组装完整下载栈（登录 + SQLite 历史 + 下载服务） */
  const makeStack = (settings) => {
    const login = createLoginModule({
      readSettings: () => settings,
      writeSettings: () => {},
      log: () => {},
    });
    const history = createHistoryDb({
      dbFile: () => pathMod.join(tmpDir, "history-main.db"),
      legacyStoreFile: () => pathMod.join(tmpDir, "no-store.json"),
      log: () => {},
    });
    const service = createOriginalDownloadService({
      rawToken: () => login.rawToken(),
      getSaveDir: () => tmpDir,
      uniqueSavePath: (dir, name) => {
        let p = pathMod.join(dir, name);
        let i = 1;
        while (fsMod.existsSync(p)) p = pathMod.join(dir, name.replace(/(\.\w+)$/, ` ($1)`).replace(".", `(${i}).`));
        return p;
      },
      history,
      log: () => {},
    });
    return { login, history, download: service.download };
  };

  /** 构造 stub fetch：详情页返回官方元数据 JSON-LD（期望 4096×2160），
   *  getCompleteUrl 换链成功，CDN 返回指定字节 */
  const stubFetchWith = (cdnBytes, { metaOk = true, schemaType = "ImageObject", descHint = "静态" } = {}) => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("homeViewLook/")) {
        if (!metaOk) return new Response("Server Error", { status: 500 });
        const html =
          '<script type="application/ld+json">{"@context":"https://schema.org",' +
          `"@type":"${schemaType}",` +
          `"name":"集成测试壁纸","description":"壁纸特征：4K ${descHint}电脑壁纸",` +
          '"contentUrl":"https://img.haowallpaper.com/pre_cache_file/fake.png",' +
          '"width":4096,"height":2160,"contentSize":"8.32 MB"}</script>';
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      if (u.includes("certify/")) {
        return new Response(JSON.stringify({ code: 200, data: { salt: "s", challenge: "c", maxnumber: 10, algorithm: "SHA-256" } }), { headers: { "content-type": "application/json" } });
      }
      if (u.includes("getCompleteUrl")) {
        return new Response(JSON.stringify({ status: 200, data: { url: "https://fake-cdn/original.png" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(cdnBytes), { headers: { "content-type": "image/png" } });
    };
  };

  const TOKEN_SETTINGS = { zfToken: "integration-test-token-1234567890" };

  // 场景 1：官方元数据 4096×2160，CDN 却回 3840×2160（等 AR 缩放）
  // → 主进程必须拒绝（resolution-mismatch），保存目录零新增
  {
    const { download } = makeStack(TOKEN_SETTINGS);
    const before = pngFiles().length;
    stubFetchWith(makePng(3840, 2160, { noise: true }));
    const r = await download({ id: "70010000000000001", wtId: "70010000000000001", title: "集成-分辨率拦截", category: "computer" });
    const after = pngFiles().length;
    check(
      "C2: CDN 回 3840×2160（官方 4096×2160）→ 拒绝（resolution-mismatch）",
      r.ok === false && r.reason === "resolution-mismatch",
      r.msg ?? ""
    );
    check("C2: 拒绝时保存目录零新增文件", after === before, `files=${after}`);
  }

  // 场景 2：CDN 回裁切版 4096×2000 → 拒绝且零落盘
  {
    const { download } = makeStack(TOKEN_SETTINGS);
    const before = pngFiles().length;
    stubFetchWith(makePng(4096, 2000, { noise: true }));
    const r = await download({ id: "70010000000000002", wtId: "70010000000000002", title: "集成-裁切拦截", category: "computer" });
    const after = pngFiles().length;
    check(
      "C2: CDN 回裁切 4096×2000 → 拒绝（resolution-mismatch）",
      r.ok === false && r.reason === "resolution-mismatch"
    );
    check("C2: 拒绝时保存目录零新增文件", after === before, `files=${after}`);
  }

  // 场景 3：CDN 回 4096×2160 真像素 PNG → 成功保存；落盘字节 SHA 与下载
  // 字节 SHA 完全一致（原始字节直写证明：无 resize/crop/重编码）；
  // v2.0：SQLite 历史同步写入全字段
  {
    const { download } = makeStack(TOKEN_SETTINGS);
    const cdnBytes = makePng(4096, 2160, { noise: true });
    stubFetchWith(cdnBytes);
    const r = await download({ id: "70010000000000003", wtId: "70010000000000003", title: "集成-原图放行", category: "computer" });
    check(
      "C2: 4096×2160 原图字节 → 成功且期望校验生效（metaVerified）",
      r.ok === true && r.width === 4096 && r.height === 2160 && r.metaVerified === true,
      r.savedPath ? pathMod.basename(r.savedPath) : JSON.stringify(r).slice(0, 80)
    );
    if (r.savedPath) {
      savedFiles.push(r.savedPath);
      const ext = pathMod.extname(r.savedPath).slice(1);
      check("C2: 成功保存的扩展名必须是 .png（真实内容）", ext === "png", `ext=${ext}`);
      const onDisk = fsMod.statSync(r.savedPath).size;
      check("C2: 落盘字节数与下载字节一致", onDisk === cdnBytes.length, `${onDisk}B`);
      const diskSha = sha256(fsMod.readFileSync(r.savedPath));
      check(
        "C2: 落盘字节 SHA-256 与下载字节完全一致（无处理直写）",
        diskSha === sha256(cdnBytes),
        `sha256:${diskSha.slice(0, 16)}`
      );
    }
    // v2.0 阶段五：重开历史库（模拟应用重启）验证记录持久化
    const histReopen = createHistoryDb({
      dbFile: () => pathMod.join(tmpDir, "history-main.db"),
      legacyStoreFile: () => pathMod.join(tmpDir, "no-store.json"),
      log: () => {},
    });
    const rec = await histReopen.getRecord("70010000000000003");
    check(
      "C2: SQLite 历史已写入（宽高/格式/大小/SHA/路径/分类/时间全字段，重启仍在）",
      !!rec && rec.width === 4096 && rec.height === 2160 && rec.format === "png" &&
        rec.bytes === cdnBytes.length && !!rec.sha256 && !!rec.savedPath && rec.category === "computer" && rec.downloadedAt > 0,
      rec ? `${rec.width}×${rec.height} ${rec.format} ${rec.bytes}B` : "record missing"
    );
    check(
      "C2: 历史记录 SHA-256 与落盘字节一致",
      !!rec && rec.sha256 === sha256(cdnBytes),
      rec?.sha256?.slice(0, 16) ?? ""
    );
    const listAll = await histReopen.listDownloads({});
    check("C2: listDownloads 返回记录", listAll.length >= 1, `n=${listAll.length}`);
    check(
      "C2: 文件存在检测 fileExists=true",
      listAll.length > 0 && listAll[0].fileExists === true,
      String(listAll[0]?.fileExists)
    );
    // 手动删除文件后重读 → fileExists=false（记录保留）
    if (r.savedPath) {
      fsMod.rmSync(r.savedPath, { force: true });
      const listAfterDelete = await histReopen.listDownloads({});
      check(
        "C2: 用户删除本地文件 → fileExists=false 且记录保留",
        listAfterDelete.length >= 1 && listAfterDelete[0].fileExists === false,
        String(listAfterDelete[0]?.fileExists)
      );
    }
  }

  // 场景 3b（v2.0）：重复下载同一张 → already-downloaded（零官网请求）
  {
    const { download } = makeStack(TOKEN_SETTINGS);
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const r = await download({ id: "70010000000000003", wtId: "70010000000000003", title: "集成-重复下载", category: "computer" });
    check(
      "C2: 重复下载同一张 → already-downloaded 且零官网请求",
      r.ok === false && r.reason === "already-downloaded" && fetchCalls === 0,
      `calls=${fetchCalls}`
    );
  }

  // 场景 3c（v2.0）：动态壁纸（JSON-LD @type=VideoObject）→ 拒绝下载
  {
    const { download } = makeStack(TOKEN_SETTINGS);
    const before = pngFiles().length;
    stubFetchWith(makePng(4096, 2160, { noise: true }), { schemaType: "VideoObject", descHint: "动态" });
    const r = await download({ id: "70010000000000009", wtId: "70010000000000009", title: "集成-动态拒绝", category: "computer" });
    const after = pngFiles().length;
    check(
      "C2: 动态壁纸（@type=VideoObject）→ 拒绝（dynamic）零落盘",
      r.ok === false && r.reason === "dynamic" && after === before,
      r.reason ?? ""
    );
  }

  // 场景 4：元数据不可用（详情页 500）+ CDN 回官网真实 890px 预览字节
  // → 退回 v1.4.13 兜底闸门拒绝（quality-mismatch），零落盘
  {
    const { download } = makeStack(TOKEN_SETTINGS);
    const before = pngFiles().length;
    stubFetchWith(previewBytesList[0], { metaOk: false });
    const r = await download({ id: "70010000000000004", wtId: "70010000000000004", title: "集成-元数据降级", category: "computer" });
    const after = pngFiles().length;
    check(
      "C2: 元数据不可用 + 890px 预览 → 兜底闸门拒绝（quality-mismatch）",
      r.ok === false && r.reason === "quality-mismatch",
      r.msg ?? ""
    );
    check("C2: 拒绝时保存目录零新增文件", after === before, `files=${after}`);
  }

  // 场景 5：令牌缺失 → no-token（不发起任何下载）
  {
    const { download } = makeStack({});
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const r = await download({ id: "70010000000000005", wtId: "70010000000000005", title: "集成-无令牌", category: "computer" });
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

/* ---------- 测试 D：真实令牌金基准全链路（可选） ---------- */

console.log("\n[D] 真实令牌金基准全链路（WW_TEST_TOKEN 提供时执行）：");
const token = process.env.WW_TEST_TOKEN;
if (!token) {
  console.log("  SKIP — 未提供 WW_TEST_TOKEN。");
  console.log("  说明：A/A2/B 已实证「未登录拿不到原图」（cache_file / pre_cache_file 只回预览 +");
  console.log("  getCompleteUrl 401），M 已建立官方元数据基准（期望宽高），T 已实证「分辨率/格式/");
  console.log("  SHA/体积任一不符必被拒绝」，C2 已实证主进程链路拦截与字节直写。");
  console.log("  带 token 的官网原图 vs 项目下载逐字节对比请执行：");
  console.log("  WW_TEST_TOKEN=<token> bun scripts/original-download-quality-test.mjs");
} else {
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  const { createLoginModule } = await import("../desktop/zf-login.js");
  const { createHistoryDb } = await import("../desktop/history-db.js");
  const { createOriginalDownloadService } = await import("../desktop/original-download.js");
  const tmpDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "ww-golden-"));

  try {
    const cookie = await runCertification();
    const targets = golden.length > 0 ? golden.slice(0, 4) : [];
    check("D: 金基准样本就绪（≥3）", targets.length >= 3, `实际 ${targets.length}`);

    for (const g of targets) {
      const label = `${g.title}（${g.kind}，期望 ${g.meta.width}×${g.meta.height}）`;
      // ① getCompleteUrl 换签名直链
      const res = await fetch(
        `${API_BASE}/link/common/file/getCompleteUrl/${g.wtId}?__media=1&__responseCodec=aeg-v2`,
        { headers: zfHeaders({ token, ...(cookie ? { Cookie: cookie } : {}) }), signal: AbortSignal.timeout(15000) }
      );
      const json = await res.json().catch(() => null);
      const target = digUrl(json);
      if (!target) {
        check(`D: ${label} getCompleteUrl`, false, `HTTP ${res.status} ${String(json?.msg ?? "").slice(0, 40)}`);
        continue;
      }
      // ② 参考下载：直链原始字节（Golden Reference bytes）
      const ref = await fetch(target, { headers: zfHeaders({ token }), signal: AbortSignal.timeout(120000) });
      const refBuf = Buffer.from(await ref.arrayBuffer());
      const refInfo = parseCjs(refBuf);
      const refSha = sha256(refBuf);

      // ③ 核心断言：直链字节的实际宽高 == 官网元数据声明的宽高
      check(
        `D: ${label} 直链实际 ${refInfo?.width}×${refInfo?.height} == 官方声明 → 宽高一致`,
        ref.ok && !!refInfo && refInfo.width === g.meta.width && refInfo.height === g.meta.height,
        `${refInfo?.format} ${mb(refBuf.length)}`
      );

      // ④ 项目链路：OriginalDownloadService（主进程同款逻辑）下载落盘
      const login = createLoginModule({
        readSettings: () => ({ zfToken: token }),
        writeSettings: () => {},
        log: () => {},
      });
      const history = createHistoryDb({
        dbFile: () => pathMod.join(tmpDir, `golden-${g.wtId}.db`),
        legacyStoreFile: () => pathMod.join(tmpDir, "no-store.json"),
        log: () => {},
      });
      const download = createOriginalDownloadService({
        rawToken: () => login.rawToken(),
        getSaveDir: () => tmpDir,
        uniqueSavePath: (d, n) => pathMod.join(d, n),
        history,
        log: () => {},
      });
      const r = await download({ id: g.wtId, wtId: g.wtId, title: `金基准-${g.title}` });
      if (!r.ok) {
        check(`D: ${label} 项目链路下载`, false, `${r.reason}: ${r.msg ?? ""}`);
        continue;
      }
      const savedBuf = fsMod.readFileSync(r.savedPath);
      const savedInfo = parseCjs(savedBuf);
      const savedSha = sha256(savedBuf);

      // ⑤ 官网 vs 项目 全量对比（Width/Height/AR/Format/Size/SHA-256）
      const rows = [
        ["Width", g.meta.width, savedInfo?.width, g.meta.width === savedInfo?.width],
        ["Height", g.meta.height, savedInfo?.height, g.meta.height === savedInfo?.height],
        [
          "Aspect Ratio",
          Math.round((g.meta.width / g.meta.height) * 1e6) / 1e6,
          savedInfo ? Math.round((savedInfo.width / savedInfo.height) * 1e6) / 1e6 : null,
          savedInfo
            ? Math.round((g.meta.width / g.meta.height) * 1e6) === Math.round((savedInfo.width / savedInfo.height) * 1e6)
            : false,
        ],
        ["Format", "—", savedInfo?.format, true],
        ["Size", g.meta.contentSizeBytes ? `${mb(g.meta.contentSizeBytes)}（官方声明）` : "—", mb(savedBuf.length), true],
        ["SHA256(官网直链)", refSha.slice(0, 16) + "…", savedSha.slice(0, 16) + "…", refSha === savedSha],
      ];
      console.log(`\n  [D] ${label}`);
      console.log("  " + "-".repeat(64));
      for (const [k, official, project, pass] of rows) {
        console.log(`  ${k.padEnd(16)} 官网=${String(official).padEnd(24)} 项目=${String(project).padEnd(24)} ${pass ? "PASS" : "FAIL"}`);
      }
      console.log("  " + "-".repeat(64));
      check(`D: ${label} 官网 vs 项目宽高完全一致`, g.meta.width === savedInfo?.width && g.meta.height === savedInfo?.height);
      check(`D: ${label} 项目落盘字节与官网直链 SHA-256 一致`, refSha === savedSha, `sha256:${savedSha.slice(0, 16)}`);
      check(
        `D: ${label} 体积与官方声明同量级（±30%）`,
        !g.meta.contentSizeBytes || (savedBuf.length >= g.meta.contentSizeBytes * 0.7 && savedBuf.length <= g.meta.contentSizeBytes * 1.3),
        `${mb(savedBuf.length)} vs ${g.meta.contentSizeBytes ? mb(g.meta.contentSizeBytes) : "?"}`
      );
      fsMod.rmSync(r.savedPath, { force: true });
    }
  } catch (e) {
    check("D: 令牌金基准链路", false, e.message);
  } finally {
    fsMod.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/* ---------- 汇总 ---------- */

console.log("\n" + "-".repeat(72));
console.log("结果明细：");
console.log(results.join("\n"));
console.log("-".repeat(72));
console.log(`合计：${passes} 通过 / ${failures} 失败`);
if (failures > 0) {
  console.log("\nDOWNLOAD INTEGRITY TEST FAILED —— 存在断言失败，禁止发布。");
  process.exit(1);
}
console.log(
  "\nALL INTEGRITY CHECKS PASSED —— 未登录拿不到原图（官网机制）+ 官方元数据基准就绪 +" +
    " 分辨率/格式/SHA/体积任一不符必被拒绝（十项完整性测试）+ 主进程链路零裁切零重编码字节直写。"
);
process.exit(0);
