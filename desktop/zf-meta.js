/**
 * 壁纸工坊 · 官网原图元数据（主进程，CommonJS）
 * ============================================================
 * v1.4.14「原图完整性硬校验」的期望值来源。
 *
 * 官网详情页 https://haowallpaper.com/homeViewLook/<wtId> 内嵌 schema.org
 * JSON-LD（ImageObject），公开给出每张壁纸原图的官方元数据：
 *   "contentUrl":"https://img.haowallpaper.com/pre_cache_file/....png"
 *   "width":6912,"height":4320,"contentSize":"8.32 MB"
 *
 * 这就是「期望宽高」的唯一权威来源 —— 绝不硬编码 4096 等固定值：
 * 不同壁纸的原图可能是 1920×1080 / 3840×2160 / 6912×4320 / 竖屏手机壁纸，
 * 全部以官网自己的声明为准。
 *
 * 实测注意（未登录取证，见 scripts/original-download-quality-test.mjs）：
 * contentUrl 指向的 pre_cache_file 直链对未登录请求同样只回 1100px webp
 * 预览 —— 元数据是公开的，但原图字节仍仅登录令牌 + getCompleteUrl 可得。
 *
 * 与 src/lib/zf-meta.ts（服务器版 TS 孪生）逐行对齐，改一处必须同步另一处。
 */

"use strict";

const API_BASE = "https://haowallpaper.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 成功缓存的 TTL（详情页元数据不频繁变化） */
const META_TTL_MS = 10 * 60 * 1000;
/** 失败负缓存：避免元数据接口抖动时每张下载都重复打详情页 */
const META_FAIL_TTL_MS = 60 * 1000;
/** 详情页 HTML 上限（实测约 230KB，防异常大响应拖垮内存） */
const META_HTML_LIMIT = 4 * 1024 * 1024;

const metaCache = new Map(); // wtId -> { ts, meta|null }

/**
 * 解析 "8.32 MB" / "1,024 KB" / "3.5M" 这类 contentSize → 字节数（近似值）。
 * 无法解析返回 null。MB 按 1024² 保守解释（用作下限基准时略偏大无害）。
 */
function parseContentSizeBytes(text) {
  if (typeof text !== "string") return null;
  const m = /([\d.,]+)\s*(KB|MB|GB|K|M|G|B)/i.exec(text.replace(/,/g, ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith("G") ? 1024 ** 3 : unit.startsWith("M") ? 1024 ** 2 : unit.startsWith("K") ? 1024 : 1;
  return Math.round(n * mult);
}

/**
 * 从详情页 HTML 提取 JSON-LD ImageObject 的官方原图元数据。
 * @returns {{ width:number, height:number, contentUrl:string,
 *             contentSizeBytes:number|null, title:string|null } | null}
 */
function extractMetaFromDetailHtml(html) {
  if (typeof html !== "string" || html.length === 0) return null;
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let obj = null;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const w = Number(obj.width);
    const h = Number(obj.height);
    const cu = typeof obj.contentUrl === "string" ? obj.contentUrl : "";
    if (Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0 && cu.includes("haowallpaper.com")) {
      const nameAndDesc = `${typeof obj.name === "string" ? obj.name : ""} ${
        typeof obj.description === "string" ? obj.description : ""
      }`;
      return {
        width: w,
        height: h,
        contentUrl: cu,
        contentSizeBytes: parseContentSizeBytes(obj.contentSize),
        title: typeof obj.name === "string" ? obj.name.slice(0, 120) : null,
        schemaType: typeof obj["@type"] === "string" ? obj["@type"] : null,
        staticHint: /动态/.test(nameAndDesc) ? "dynamic" : /静态/.test(nameAndDesc) ? "static" : null,
      };
    }
  }
  // 兜底：JSON.parse 全失败时按正则直取（页面结构微调时的保险）
  const w2 = /"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)/.exec(html);
  const cu2 = /"contentUrl"\s*:\s*"([^"]*img\.haowallpaper\.com[^"]*)"/.exec(html);
  if (w2 && cu2) {
    return {
      width: Number(w2[1]),
      height: Number(w2[2]),
      contentUrl: cu2[1],
      contentSizeBytes: null,
      title: null,
      schemaType: null,
      staticHint: null,
    };
  }
  return null;
}

/**
 * 抓取官网详情页，取官方原图元数据（10 分钟内存缓存 + 60s 负缓存）。
 * 任何失败都返回 null（调用方继续走 v1.4.13 的预览兜底闸门，绝不因
 * 元数据不可用而阻断或放行下载）。
 * @param {string} wtId 壁纸详情 id（卡片 /homeViewLook/<id>）
 */
async function fetchOfficialOriginalMeta(wtId) {
  const id = String(wtId || "").trim();
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) return null;

  const hit = metaCache.get(id);
  const now = Date.now();
  if (hit) {
    if (hit.meta) {
      if (now - hit.ts < META_TTL_MS) return hit.meta;
    } else if (now - hit.ts < META_FAIL_TTL_MS) {
      return null; // 负缓存：短时间内不重试
    }
  }

  try {
    const res = await fetch(`${API_BASE}/homeViewLook/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": UA, Referer: `${API_BASE}/`, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      metaCache.set(id, { ts: now, meta: null });
      return null;
    }
    const html = (await res.text()).slice(0, META_HTML_LIMIT);
    const meta = extractMetaFromDetailHtml(html);
    metaCache.set(id, { ts: now, meta });
    // 缓存条目有界：超过 512 条清最旧的一半
    if (metaCache.size > 512) {
      const keys = [...metaCache.keys()].slice(0, 256);
      for (const k of keys) metaCache.delete(k);
    }
    return meta;
  } catch {
    metaCache.set(id, { ts: now, meta: null });
    return null;
  }
}

/**
 * v2.0：官网元数据是否明确为静态图片（ImageObject 且描述非动态）。
 * 与 src/lib/zf-meta.ts 的 metaIsStaticImage 逐行对齐。
 */
function metaIsStaticImage(meta) {
  if (!meta) return false;
  if (meta.schemaType && meta.schemaType !== "ImageObject") return false;
  if (meta.staticHint === "dynamic") return false;
  return true;
}

module.exports = { fetchOfficialOriginalMeta, extractMetaFromDetailHtml, parseContentSizeBytes, metaIsStaticImage };
