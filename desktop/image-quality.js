/**
 * 壁纸工坊 · 原图质量校验（主进程，CommonJS）
 * ============================================================
 * v1.4.13 为「下载的图片模糊、只有几十 KB」问题而生的最后一道闸门；
 * v1.4.14 升级为「原图完整性硬校验」：
 *
 * 实测（2026-11，scripts/original-download-quality-test.mjs 取证）官网
 * 质量阶梯：
 *   1. s240/s320 缩略图（网格显示用，几十 KB 以下 webp）
 *   2. CDN 直链（未登录）：890px 宽 webp 预览，6.7~25KB —— 无论 URL 扩展名
 *      是 .png，CDN 对未登录请求一律返回该预览（这就是模糊小图的来源）
 *   3. previewFileImg 官方预览：1100px 宽 webp，约 56KB
 *   4. 原图：仅登录令牌 + ALTCHA + getCompleteUrl 签名直链可得（未登录 401）
 *
 * 官网详情页（/homeViewLook/<wtId>）内嵌 schema.org JSON-LD，公开给出每张
 * 壁纸原图的官方 width / height / contentUrl / contentSize —— 这就是
 * 「期望尺寸」的唯一权威来源（绝不硬编码 4096 等固定值，不同壁纸可能是
 * 1920×1080 / 3840×2160 / 6912×4320 / 竖屏手机壁纸……）。
 *
 * 本模块在「字节」层面回答一个问题：这段字节到底是不是官网原图？
 * - 按魔数识别真实格式（PNG/JPEG/WebP/GIF），杜绝 preview.webp 改名 xxx.png
 * - 解析真实宽高（纯 Node，无原生依赖，只读头部不解码像素）
 * - 【v1.4.14】expect 硬校验：期望宽高必须逐一完全一致（杜绝裁切/缩放/
 *   拉伸/改比例 —— 4096×2000、2048×1080、4096×2048、3840×2160 对期望
 *   4096×2160 全部拒绝），可选期望格式与 SHA-256（字节级一致性证明）
 * - 长边 ≤ 1100px（官方预览上限）或「字节 < 60KB 且长边 < 1500」→ 判预览，
 *   返回 DOWNLOAD_QUALITY_MISMATCH，调用方必须拒绝保存
 *   （期望宽高校验通过时跳过该兜底 —— 官方元数据是权威）
 *
 * 与 src/lib/image-quality.ts（服务器版 TS 孪生）逐行对齐，改一处必须同步另一处。
 *
 * 下载链路铁律（本模块只读字节，永不修改字节）：
 *   官网原始字节 → Buffer → 质量验证（只读头部/哈希） → 原样写入文件
 * 全链路无 resize / crop / canvas / 重编码（已全局审计）。
 */

"use strict";

const { createHash } = require("node:crypto");

/** 官方预览的宽度上限（previewFileImg 实测 1100px；CDN 直链预览 890px） */
const PREVIEW_LONG_SIDE_MAX = 1100;
/** 疑似预览的体积线：官方预览 ≤ 56KB；配合较低分辨率才判定（防误伤真小原图） */
const SUSPICIOUS_SMALL_BYTES = 60 * 1024;
/** 配合体积线使用的低分辨率线 */
const LOW_RES_LONG_SIDE = 1500;

/**
 * 解析图片字节 → { format, width, height }；无法识别返回 null。
 * 只读头部，不解码像素，几 MB 的图也是微秒级。
 */
function parseImageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG：89 50 4E 47 0D 0A 1A 0A + IHDR(宽高 big-endian @16/@20)
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null; // 无 IHDR
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG：FF D8；扫描 SOF0~SOF15（除 C4/C8/CC）取宽高
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2; continue; // 无长度段
      }
      if (off + 4 > buf.length) break;
      const segLen = buf.readUInt16BE(off + 2);
      if (segLen < 2) break;
      const isSOF =
        (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        if (off + 9 > buf.length) break;
        return { format: "jpeg", height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + segLen;
    }
    return null;
  }

  // WebP：RIFF....WEBP（VP8X / VP8 / VP8L 三种头部）
  if (
    buf.readUInt32BE(0) === 0x52494646 && // "RIFF"
    buf.readUInt32BE(8) === 0x57454250    // "WEBP"
  ) {
    const fourCC = buf.toString("latin1", 12, 16);
    if (fourCC === "VP8X" && buf.length >= 30) {
      // VP8X：1 字节 flags + 3 字节保留 + canvas 宽-1 / 高-1（各 3 字节 LE）
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: "webp", width: w, height: h };
    }
    if (fourCC === "VP8 " && buf.length >= 30) {
      // VP8（有损）：chunk data（从 20 起）= 3 字节帧标记 + 3 字节同步码
      // 9D 01 2A（在 23-25）+ 宽 LE14（26-27）+ 高 LE14（28-29）。
      // 实测官网 890px 预览即此格式（字节验证：7a03=890、2c02=556）。
      if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return {
          format: "webp",
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      return null;
    }
    if (fourCC === "VP8L" && buf.length >= 21 && buf[20] === 0x2f) {
      // VP8L（无损）：签名 0x2F 后 4 字节位流：宽-1 低 14 位、高-1 次 14 位
      const bits = buf.readUInt32LE(21);
      return {
        format: "webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    return null;
  }

  // GIF：GIF87a / GIF89a；宽高 LE16 @6/@8
  if (buf.toString("latin1", 0, 3) === "GIF") {
    return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  return null;
}

/** 实际格式 → 落盘扩展名（内容说了算，杜绝扩展名伪装） */
function extOfFormat(format) {
  switch (format) {
    case "png": return "png";
    case "jpeg": return "jpg";
    case "webp": return "webp";
    case "gif": return "gif";
    default: return "bin";
  }
}

/** 宽高比（保留 6 位小数；宽高为 0 时返回 null） */
function aspectRatioOf(width, height) {
  if (!width || !height) return null;
  return Math.round((width / height) * 1e6) / 1e6;
}

/**
 * 原图质量校验（v1.4.14 完整性版）：ok 之外的一切结果都意味着「绝不允许保存」。
 *
 * @param {Buffer} buf 下载到的完整字节（本函数只读，绝不修改）
 * @param {{ width?: number, height?: number, format?: string,
 *           sha256?: string, minBytes?: number }} [expect]
 *   期望值（来自官网详情页 JSON-LD 官方元数据，或金基准测试样本）：
 *   - width / height：官方原图宽高，逐一硬性比对（宽或高任一不符即拒绝 ——
 *     天然覆盖裁切（4096×2000）、缩放（2048×1080）、比例改变（4096×2048））
 *   - format：官方原图格式（png/jpeg/webp/gif），不符即拒绝（杜绝 WebP
 *     伪装 PNG / JPEG 伪装 PNG）
 *   - sha256：官方原图完整字节哈希，不符即拒绝（字节级一致性证明 —— 同时
 *     证明无裁切/无缩放/无重编码/无重压缩/无画面丢失）
 *   - minBytes：体积下限（官方 contentSize 的保守折扣），过小判定为疑似
 *     重新压缩版本。注意：体积只是辅助线，宽高+格式才是硬性指标。
 * @returns {{
 *   ok: boolean,
 *   code?: "FORMAT_UNKNOWN" | "DOWNLOAD_QUALITY_MISMATCH" |
 *          "DOWNLOAD_RESOLUTION_MISMATCH" | "DOWNLOAD_FORMAT_MISMATCH" |
 *          "DOWNLOAD_SHA256_MISMATCH" | "DOWNLOAD_SIZE_MISMATCH",
 *   msg?: string,
 *   format?: string, width?: number, height?: number, longSide?: number,
 *   aspectRatio?: number, ext?: string, bytes?: number, sha256?: string,
 *   expectedWidth?: number, expectedHeight?: number
 * }}
 */
function validateOriginalImage(buf, expect) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  const info = parseImageInfo(buf);
  if (!info || !info.width || !info.height || info.width > 100000 || info.height > 100000) {
    return {
      ok: false,
      code: "FORMAT_UNKNOWN",
      msg: "无法识别图片内容（非 PNG/JPEG/WebP/GIF 或头部损坏）",
      bytes,
    };
  }
  const longSide = Math.max(info.width, info.height);
  const ar = aspectRatioOf(info.width, info.height);
  const base = {
    ...info,
    longSide,
    aspectRatio: ar,
    ext: extOfFormat(info.format),
    bytes,
  };

  const exp = expect && typeof expect === "object" ? expect : {};
  const expW = Number(exp.width) > 0 ? Number(exp.width) : null;
  const expH = Number(exp.height) > 0 ? Number(exp.height) : null;

  // ① 期望宽高硬校验（官方元数据为权威，逐一完全一致才放行；
  //    宽或高任一不符即拒绝 —— 覆盖裁切/缩放/拉伸/改比例全部场景）
  if (expW !== null || expH !== null) {
    const badW = expW !== null && info.width !== expW;
    const badH = expH !== null && info.height !== expH;
    if (badW || badH) {
      const expAr = aspectRatioOf(expW ?? info.width, expH ?? info.height);
      const arNote =
        expAr !== null && ar !== null && expAr !== ar
          ? `，宽高比也不一致（官网 ${expAr} / 实际 ${ar}）`
          : "";
      return {
        ...base,
        ok: false,
        code: "DOWNLOAD_RESOLUTION_MISMATCH",
        expectedWidth: expW ?? undefined,
        expectedHeight: expH ?? undefined,
        msg:
          `分辨率与官网原图不符：官网 ${expW ?? "?"}×${expH ?? "?"}，实际 ` +
          `${info.width}×${info.height}${arNote}，已拒绝保存（可能是缩放/裁切版本）`,
      };
    }
  }
  // 期望宽高全部给出且完全匹配 → 尺寸已由官方元数据证明，跳过预览兜底线
  const dimsVerified = expW !== null && expH !== null;

  // ② 期望格式硬校验（杜绝 WebP/JPEG 内容伪装成 PNG 原图）
  if (typeof exp.format === "string" && exp.format) {
    const want = exp.format === "jpg" ? "jpeg" : exp.format;
    if (info.format !== want) {
      return {
        ...base,
        ok: false,
        code: "DOWNLOAD_FORMAT_MISMATCH",
        msg:
          `图片格式与官网原图不符：官网 ${want}，实际 ${info.format}，` +
          `已拒绝保存（杜绝改名伪装）`,
      };
    }
  }

  // ③ 期望 SHA-256（字节级一致性：一致即同时证明无裁切/缩放/重编码/丢画面）
  if (typeof exp.sha256 === "string" && /^[0-9a-f]{64}$/i.test(exp.sha256)) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== exp.sha256.toLowerCase()) {
      return {
        ...base,
        ok: false,
        code: "DOWNLOAD_SHA256_MISMATCH",
        sha256: actual,
        msg:
          `文件内容与官网原图不一致（SHA-256 校验失败），已拒绝保存` +
          `（可能被 CDN 动态处理或返回了非原文件）`,
      };
    }
    return { ok: true, ...base, sha256: actual };
  }

  // ④ 体积下限（辅助线：官方 contentSize 的保守折扣，防同尺寸重压缩缩水）
  if (Number(exp.minBytes) > 0 && bytes < Number(exp.minBytes)) {
    return {
      ...base,
      ok: false,
      code: "DOWNLOAD_SIZE_MISMATCH",
      msg:
        `文件大小异常偏小（实际 ${(bytes / 1024 / 1024).toFixed(2)}MB，官网原图约 ` +
        `${(Number(exp.minBytes) / 1024 / 1024).toFixed(2)}MB 以上），疑似重新压缩版本，已拒绝保存`,
    };
  }

  // ⑤ 预览兜底线（仅在拿不到官方期望宽高时启用）
  if (!dimsVerified) {
    if (longSide <= PREVIEW_LONG_SIDE_MAX) {
      return {
        ...base,
        ok: false,
        code: "DOWNLOAD_QUALITY_MISMATCH",
        msg:
          `官网返回的是预览图而非原图（${info.width}×${info.height}，${(bytes / 1024).toFixed(0)}KB` +
          `，官方预览上限 ${PREVIEW_LONG_SIDE_MAX}px），已拒绝保存`,
      };
    }
    if (bytes < SUSPICIOUS_SMALL_BYTES && longSide < LOW_RES_LONG_SIDE) {
      return {
        ...base,
        ok: false,
        code: "DOWNLOAD_QUALITY_MISMATCH",
        msg:
          `下载内容疑似预览图（${info.width}×${info.height}，仅 ${(bytes / 1024).toFixed(0)}KB），` +
          `已拒绝保存`,
      };
    }
  }
  return { ok: true, ...base };
}

module.exports = {
  parseImageInfo,
  validateOriginalImage,
  extOfFormat,
  aspectRatioOf,
  PREVIEW_LONG_SIDE_MAX,
};
