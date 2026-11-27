/**
 * 壁纸工坊 · 原图质量校验（服务器版，TS）
 * ============================================================
 * 与 desktop/image-quality.js（桌面版 CommonJS 孪生）逐行对齐，
 * 改一处必须同步另一处。
 *
 * 背景（实测取证见 scripts/original-download-quality-test.mjs）：
 * 官网 CDN 对未登录请求一律返回 890px webp 预览（无论 URL 是否 .png），
 * previewFileImg 官方预览 1100px；原图仅登录令牌 + getCompleteUrl 可得。
 * 本模块用字节级解析回答「这段字节是不是官网原图」。
 */

/** 官方预览的宽度上限（previewFileImg 实测 1100px；CDN 直链预览 890px） */
export const PREVIEW_LONG_SIDE_MAX = 1100
/** 疑似预览的体积线：官方预览 ≤ 56KB；配合较低分辨率才判定（防误伤真小原图） */
export const SUSPICIOUS_SMALL_BYTES = 60 * 1024
/** 配合体积线使用的低分辨率线 */
export const LOW_RES_LONG_SIDE = 1500

export interface ParsedImageInfo {
  format: "png" | "jpeg" | "webp" | "gif"
  width: number
  height: number
}

export interface ImageValidation {
  ok: boolean
  code?: "FORMAT_UNKNOWN" | "DOWNLOAD_QUALITY_MISMATCH"
  msg?: string
  format?: string
  width?: number
  height?: number
  longSide?: number
  ext?: string
  bytes?: number
}

/** 解析图片字节 → { format, width, height }；无法识别返回 null（只读头部） */
export function parseImageInfo(buf: Buffer): ParsedImageInfo | null {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null

  // PNG：89 50 4E 47 0D 0A 1A 0A + IHDR(宽高 big-endian @16/@20)
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null // 无 IHDR
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // JPEG：FF D8；扫描 SOF0~SOF15（除 C4/C8/CC）取宽高
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue }
      const marker = buf[off + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2; continue // 无长度段
      }
      if (off + 4 > buf.length) break
      const segLen = buf.readUInt16BE(off + 2)
      if (segLen < 2) break
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSOF) {
        if (off + 9 > buf.length) break
        return { format: "jpeg", height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
      }
      off += 2 + segLen
    }
    return null
  }

  // WebP：RIFF....WEBP（VP8X / VP8 / VP8L 三种头部）
  if (buf.readUInt32BE(0) === 0x52494646 && buf.readUInt32BE(8) === 0x57454250) {
    const fourCC = buf.toString("latin1", 12, 16)
    if (fourCC === "VP8X" && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { format: "webp", width: w, height: h }
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
        }
      }
      return null
    }
    if (fourCC === "VP8L" && buf.length >= 21 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21)
      return {
        format: "webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      }
    }
    return null
  }

  // GIF：GIF87a / GIF89a；宽高 LE16 @6/@8
  if (buf.toString("latin1", 0, 3) === "GIF") {
    return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }

  return null
}

/** 实际格式 → 落盘扩展名（内容说了算，杜绝扩展名伪装） */
export function extOfFormat(format: string): string {
  switch (format) {
    case "png": return "png"
    case "jpeg": return "jpg"
    case "webp": return "webp"
    case "gif": return "gif"
    default: return "bin"
  }
}

/** 原图质量校验：ok 之外的一切结果都意味着「绝不允许保存」 */
export function validateOriginalImage(buf: Buffer): ImageValidation {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0
  const info = parseImageInfo(buf)
  if (!info || !info.width || !info.height || info.width > 100000 || info.height > 100000) {
    return {
      ok: false,
      code: "FORMAT_UNKNOWN",
      msg: "无法识别图片内容（非 PNG/JPEG/WebP/GIF 或头部损坏）",
      bytes,
    }
  }
  const longSide = Math.max(info.width, info.height)
  const base = { ...info, longSide, ext: extOfFormat(info.format), bytes }

  if (longSide <= PREVIEW_LONG_SIDE_MAX) {
    return {
      ...base,
      ok: false,
      code: "DOWNLOAD_QUALITY_MISMATCH",
      msg:
        `官网返回的是预览图而非原图（${info.width}×${info.height}，${(bytes / 1024).toFixed(0)}KB` +
        `，官方预览上限 ${PREVIEW_LONG_SIDE_MAX}px），已拒绝保存`,
    }
  }
  if (bytes < SUSPICIOUS_SMALL_BYTES && longSide < LOW_RES_LONG_SIDE) {
    return {
      ...base,
      ok: false,
      code: "DOWNLOAD_QUALITY_MISMATCH",
      msg: `下载内容疑似预览图（${info.width}×${info.height}，仅 ${(bytes / 1024).toFixed(0)}KB），已拒绝保存`,
    }
  }
  return { ok: true, ...base }
}
