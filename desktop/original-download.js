/**
 * 壁纸工坊 · OriginalDownloadService（桌面主进程，CommonJS）
 * ============================================================
 * v2.0 阶段三：独立原图下载服务 —— 统一链路，规格顺序逐条落实：
 *
 *   用户点击下载
 *     → ① 检查本地下载记录（重复下载明确提示，不重复请求官网）
 *     → ② 检查登录状态（无令牌 → 引导扫码，绝不保存预览图）
 *     → ③ 获取官网原图授权（详情页 JSON-LD 元数据 + 动态壁纸拒绝）
 *     → ④ ALTCHA 人机验证
 *     → ⑤ 获取签名下载地址（getCompleteUrl）
 *     → ⑥ 下载原始文件（整段字节，超时/中断防护）
 *     → ⑦ 校验图片（v1.4.13/14 质量防线全保留：期望宽高逐一硬比对 +
 *        魔数真实格式 + 体积下限 + 预览图兜底拒绝；不过绝不落盘）
 *     → ⑧ 直接保存原始字节（无任何裁切/缩放/重编码）
 *     → ⑨ 写入下载历史（SQLite，校验通过+文件落盘后才写）
 *     → ⑩ 返回结果（渲染层更新界面）
 *
 * v2.0 阶段七：统一错误处理 —— reason 枚举与人类可读消息一一对应：
 *   no-token / auth-expired / already-downloaded / dynamic / restricted /
 *   rate-limited / not-found / no-permission / server-error / network /
 *   interrupted / quality-mismatch / resolution-mismatch / format-mismatch /
 *   sha-mismatch / size-mismatch / error
 *
 * 429 / 官网风控防御（阶段七规格逐条）：
 *   - Retry-After 头识别（秒数与 HTTP 日期两种格式）
 *   - 官网「预计恢复时间」识别（本地时区解析）
 *   - 时间戳单位/时区/有效性保护：恢复时间必须落在 (now, now+90天] 才可信，
 *     超出窗口不展示具体日期（标注官网返回了异常日期），绝不伪造恢复时间
 *   - 限流期间熔断：快速失败零官网请求，30 分钟探测窗口
 *   - 串行队列最小间隔 2.5s（拟人节奏，降低风控触发概率）
 */

"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { validateOriginalImage } = require("./image-quality.js");
const { fetchOfficialOriginalMeta, metaIsStaticImage } = require("./zf-meta.js");
const { ensureCertified, invalidateCertification } = require("./zf-certify.js");

const API_BASE = "https://haowallpaper.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** getCompleteUrl 直链接口（必须带 __media=1&__responseCodec=aeg-v2） */
function completeUrlOf(wtId) {
  return `${API_BASE}/link/common/file/getCompleteUrl/${encodeURIComponent(wtId)}?__media=1&__responseCodec=aeg-v2`;
}

function zfHeaders(extra) {
  return {
    "User-Agent": UA,
    Referer: `${API_BASE}/`,
    Accept: "application/json, text/plain, */*",
    ...(extra || {}),
  };
}

/** getCompleteUrl 响应里深挖原图直链 */
function digUrl(data, depth = 0) {
  if (depth > 3) return null;
  if (typeof data === "string") return /^https?:\/\//.test(data) ? data : null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const key of ["url", "completeUrl", "downUrl", "link"]) {
    if (typeof data[key] === "string" && /^https?:\/\//.test(data[key])) return data[key];
  }
  return digUrl(data.data, depth + 1);
}

/* ---------------- v2.0 阶段七：限流/恢复时间解析与防御 ---------------- */

/** 受限消息关键词（官网风控文案，实测取证见 v1.4.15） */
const RESTRICTED_RE = /受限|恢复时间|禁止下载|封禁|联系客服/;
/** 恢复时间可信窗口：超出视为「官网返回了异常日期」，不展示具体时间 */
const RECOVER_SANITY_MS = 90 * 24 * 60 * 60 * 1000;
/** 熔断期内真实探测间隔 */
const RESTRICTED_PROBE_MS = 30 * 60 * 1000;
/** 429 无任何线索时的短熔断时长 */
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
/** 串行队列相邻两次下载最小间隔（拟人节奏） */
const DL_MIN_GAP_MS = 2500;

/** 从官网 msg 里解析「恢复时间：YYYY-MM-DD HH:mm[:ss]」→ epoch ms（本地时区） */
function parseRestrictedUntil(msg) {
  const m = String(msg || "").match(
    /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) return 0;
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0)
  ).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Retry-After 头解析（秒数或 HTTP 日期两种格式）。
 * 单位防御：纯数字按秒；日期解析失败或落在过去 → 0（未知）。
 */
function parseRetryAfterMs(headerValue) {
  const v = String(headerValue || "").trim();
  if (!v) return 0;
  if (/^\d+$/.test(v)) {
    const secs = Number(v);
    // 异常保护：超过 90 天的 Retry-After 视为不可信
    const ms = secs * 1000;
    return ms > 0 && ms <= RECOVER_SANITY_MS ? ms : 0;
  }
  const t = Date.parse(v);
  const ms = Number.isFinite(t) ? t - Date.now() : 0;
  return ms > 0 && ms <= RECOVER_SANITY_MS ? ms : 0;
}

/** 剩余时长人类可读（受限提示展示；不伪造，只换算） */
function humanizeRemain(ms) {
  if (ms <= 0) return "即将恢复";
  const min = Math.round(ms / 60000);
  if (min < 60) return `约 ${min} 分钟`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `约 ${hours} 小时`;
  return `约 ${Math.round(hours / 24)} 天`;
}

/**
 * 创建原图下载服务。
 * @param deps
 *   - rawToken(): string|null        当前登录令牌（来自 zf-login 模块）
 *   - getSaveDir(): string           壁纸保存目录
 *   - uniqueSavePath(dir, name): string
 *   - history: history-db 模块（addDownload / getRecord）
 *   - log(line): void                运行日志（审计轨迹）
 */
function createOriginalDownloadService(deps) {
  const { rawToken, getSaveDir, uniqueSavePath, history, log = () => {} } = deps;

  /* ----- 熔断状态（内存态） ----- */
  let restrictedUntil = 0; // epoch ms，0 = 未受限
  let restrictedMsg = ""; // 官网原始消息
  let restrictedProbeAt = 0; // 上次真实探测时间
  let restrictedAbsurd = false; // 官网返回了异常（超出可信窗口）的恢复日期
  let lastDlStartAt = 0; // 串行节流
  let dlChain = Promise.resolve(); // 串行队列

  const markRestricted = (msg, fallbackMs) => {
    restrictedMsg = String(msg || "");
    const until = parseRestrictedUntil(restrictedMsg);
    restrictedAbsurd = until > 0 && until - Date.now() > RECOVER_SANITY_MS;
    restrictedUntil = until > Date.now() ? until : Date.now() + (fallbackMs ?? 10 * 60 * 1000);
    restrictedProbeAt = Date.now();
    log(
      `官网风控受限熔断至 ${new Date(restrictedUntil).toLocaleString()}（${
        restrictedMsg || "429 限流"
      }）${restrictedAbsurd ? "［官网恢复时间超出 90 天可信窗口，界面不展示具体日期］" : ""}`
    );
  };

  const restrictedResult = () => {
    const remain = restrictedUntil > Date.now() ? restrictedUntil - Date.now() : 0;
    const when = restrictedAbsurd
      ? "官网返回的恢复时间明显异常，恢复时间未知"
      : `预计 ${humanizeRemain(remain)}后恢复（${new Date(restrictedUntil).toLocaleString()}）`;
    return {
      ok: false,
      reason: "restricted",
      recoverAt: restrictedAbsurd ? 0 : restrictedUntil || undefined,
      recoverUnknown: restrictedAbsurd || undefined,
      msg:
        `官网下载功能暂时受限，${when}。` +
        (restrictedMsg ? `官网提示：${restrictedMsg} ` : "") +
        "已自动暂停请求官网，恢复后可手动重试；若有疑问请联系官网客服。",
    };
  };

  const restrictedFused = () =>
    restrictedUntil > Date.now() && Date.now() - restrictedProbeAt < RESTRICTED_PROBE_MS;

  /** getCompleteUrl 业务错误 → 命中风控关键词则熔断（返回受限结果，否则 null） */
  const checkRestricted = (msg) => {
    if (!RESTRICTED_RE.test(String(msg || ""))) return null;
    markRestricted(msg);
    return restrictedResult();
  };

  /** HTTP 429 统一入口：识别 Retry-After，无线索则短熔断 */
  const rateLimitedResult = (retryAfterHeader) => {
    const retryMs = parseRetryAfterMs(retryAfterHeader);
    markRestricted("官网限流（429）", retryMs || RATE_LIMIT_FALLBACK_MS);
    const remain = restrictedUntil - Date.now();
    return {
      ok: false,
      reason: "rate-limited",
      recoverAt: restrictedUntil || undefined,
      msg: `操作太快被官网限流，已自动暂停 ${humanizeRemain(remain)}，期间不再请求；恢复后请手动重试。`,
    };
  };

  /** 校验失败码 → 统一 reason */
  const reasonOfCode = (code) =>
    ({
      DOWNLOAD_RESOLUTION_MISMATCH: "resolution-mismatch",
      DOWNLOAD_FORMAT_MISMATCH: "format-mismatch",
      DOWNLOAD_SHA256_MISMATCH: "sha-mismatch",
      DOWNLOAD_SIZE_MISMATCH: "size-mismatch",
      DOWNLOAD_QUALITY_MISMATCH: "quality-mismatch",
    })[code] || "error";

  /** HTTP 状态码 → 统一 reason + 消息（401/403/404/429/5xx） */
  const httpErrorResult = (status, where) => {
    if (status === 401)
      return { ok: false, reason: "auth-expired", msg: "登录令牌已失效，请重新扫码" };
    if (status === 403)
      return { ok: false, reason: "no-permission", msg: "官网拒绝访问（403 无权限），该原图可能需要更高权限" };
    if (status === 404)
      return { ok: false, reason: "not-found", msg: "原图资源不存在（404），可能已下架" };
    if (status === 429) return null; // 调用方已单独处理（需 Retry-After 头）
    return {
      ok: false,
      reason: "server-error",
      msg: `官网${where}失败（HTTP ${status}），请稍后重试`,
    };
  };

  /** 网络异常分类：超时 / 中断 / 一般网络 */
  const networkErrorResult = (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout|timed out/i.test(msg))
      return { ok: false, reason: "network", msg: "连接官网超时，请检查网络后重试" };
    if (/interrupted|ECONNRESET|socket/i.test(msg))
      return { ok: false, reason: "interrupted", msg: "下载连接被中断，请重试" };
    return { ok: false, reason: "network", msg: `网络异常：${msg.slice(0, 80)}` };
  };

  /* ---------------- 单次下载（规格十步） ---------------- */

  const runDownload = async (wp) => {
    // ② 登录状态（①之前做本地记录检查更省；规格顺序：先记录后登录——
    //    已下载的直接提示，不需要令牌，两序皆满足"先本地后远程"）
    // ① 本地下载记录：重复下载明确提示（不重复请求官网）
    const existing = await history.getRecord(wp.id).catch(() => null);
    if (existing) {
      return {
        ok: false,
        reason: "already-downloaded",
        msg:
          `「${existing.title || wp.title}」已于 ${new Date(existing.downloadedAt).toLocaleString()} 下载过` +
          (existing.savedPath ? `，保存在：${existing.savedPath}` : "") +
          (existing.fileExists === false ? "（原文件已不在保存位置，可在下载历史中查看）" : ""),
        record: existing,
      };
    }

    const token = rawToken();
    if (!token) return { ok: false, reason: "no-token", msg: "下载高清原图需先扫码登录" };

    const id = /^[0-9A-Za-z_-]{1,64}$/.test(String(wp.wtId || wp.id || "")) ? String(wp.wtId || wp.id) : null;
    if (!id) return { ok: false, reason: "error", msg: "壁纸 id 不合法" };

    // 熔断期内快速失败（零官网请求）；探测窗口放行一次
    if (restrictedUntil > Date.now()) {
      if (restrictedFused()) return restrictedResult();
      restrictedProbeAt = Date.now();
    }

    // ③ 官网详情页 JSON-LD 元数据（期望宽高唯一权威来源 + 动态类型权威判定）
    const meta = await fetchOfficialOriginalMeta(id);
    if (meta && !metaIsStaticImage(meta)) {
      log(`动态壁纸拦截［${meta.schemaType || meta.staticHint}］：${meta.title || id}`);
      return {
        ok: false,
        reason: "dynamic",
        msg: "该内容是动态壁纸（官网元数据非静态图片），v2.0 仅支持静态壁纸下载",
      };
    }
    const expect = meta
      ? {
          width: meta.width,
          height: meta.height,
          // 体积下限：官方 contentSize 的 50%（辅助线，仅拦「同尺寸重压缩缩水」）
          ...(meta.contentSizeBytes ? { minBytes: Math.floor(meta.contentSizeBytes * 0.5) } : {}),
        }
      : undefined;
    if (meta) {
      log(`原图期望（官网元数据）：${meta.width}×${meta.height}` +
        (meta.contentSizeBytes ? `，约 ${(meta.contentSizeBytes / 1024 / 1024).toFixed(2)}MB` : ""));
    } else {
      log("官网元数据不可用：退回预览兜底闸门（长边≤1100px 拒绝）");
    }

    // ④ ALTCHA + ⑤ getCompleteUrl 签名直链（305 时重验一次）
    let target = null;
    try {
      const cookie = await ensureCertified();
      const res = await fetch(completeUrlOf(id), {
        headers: zfHeaders({ token, ...(cookie ? { Cookie: cookie } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) return rateLimitedResult(res.headers.get("retry-after"));
      const json = await res.json().catch(() => null);
      target = json ? digUrl(json) : null;
      if (!target) {
        const status = Number(json?.status ?? -1);
        const msg = typeof json?.msg === "string" ? json.msg.trim() : "";
        const mapped = httpErrorResult(res.status, "获取原图授权");
        if (mapped) return mapped; // 401/403/404/5xx（HTTP 层）
        if (status === 401 || /未授权/.test(msg)) {
          return { ok: false, reason: "auth-expired", msg: "登录令牌已失效，请重新扫码" };
        }
        if (status === 305) {
          invalidateCertification();
          const cookie2 = await ensureCertified(true);
          const res2 = await fetch(completeUrlOf(id), {
            headers: zfHeaders({ token, ...(cookie2 ? { Cookie: cookie2 } : {}) }),
            signal: AbortSignal.timeout(15000),
          });
          if (res2.status === 429) return rateLimitedResult(res2.headers.get("retry-after"));
          const json2 = await res2.json().catch(() => null);
          target = json2 ? digUrl(json2) : null;
          const status2 = Number(json2?.status ?? -1);
          const msg2 = typeof json2?.msg === "string" ? json2.msg.trim() : "";
          if (!target) {
            if (status2 === 401 || /未授权/.test(msg2)) {
              return { ok: false, reason: "auth-expired", msg: "登录令牌已失效，请重新扫码" };
            }
            const mapped2 = httpErrorResult(res2.status, "获取原图授权");
            return (
              checkRestricted(msg2) ||
              mapped2 || {
                ok: false,
                reason: "error",
                msg: msg2 || `官网接口异常（HTTP ${status2}）`,
              }
            );
          }
        } else {
          return (
            checkRestricted(msg) ||
            mapped ||
            (status === 404
              ? { ok: false, reason: "not-found", msg: "原图资源不存在（官网业务 404）" }
              : {
                  ok: false,
                  reason: "server-error",
                  msg: msg || `官网接口异常（HTTP ${res.status}）`,
                })
          );
        }
      }
    } catch (e) {
      return networkErrorResult(e);
    }

    // ⑥ 下载原始文件（整段字节读入内存）
    let buf;
    try {
      const upstream = await fetch(target, {
        headers: zfHeaders({ token }),
        signal: AbortSignal.timeout(120_000),
      });
      if (upstream.status === 429) return rateLimitedResult(upstream.headers.get("retry-after"));
      if (upstream.status === 403)
        return { ok: false, reason: "no-permission", msg: "CDN 拒绝访问（403），签名直链可能已过期，请重试" };
      if (upstream.status === 404)
        return { ok: false, reason: "not-found", msg: "原图文件不存在（404）" };
      if (!upstream.ok) {
        const mapped = httpErrorResult(upstream.status, "下载原图");
        return mapped || { ok: false, reason: "server-error", msg: `原图下载失败（HTTP ${upstream.status}）` };
      }
      buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length === 0) return { ok: false, reason: "network", msg: "原图内容为空（连接被提前切断）" };
    } catch (e) {
      return networkErrorResult(e);
    }

    // ⑦ 质量硬闸门：期望宽高逐一硬比对 + 字节级校验，不过绝不落盘
    const check = validateOriginalImage(buf, expect);
    if (!check.ok) {
      log(`质量闸门拦截 [${check.code}]：${check.msg}`);
      return {
        ok: false,
        reason: check.code === "FORMAT_UNKNOWN" ? "error" : reasonOfCode(check.code),
        msg: check.msg,
        width: check.width,
        height: check.height,
        expectedWidth: check.expectedWidth,
        expectedHeight: check.expectedHeight,
      };
    }

    // ⑧ 直接保存原始字节（文件名清洗 + 扩展名按真实内容格式）
    const clean =
      String(wp.title || "wallpaper")
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "wallpaper";
    const savePath = uniqueSavePath(getSaveDir(), `${clean}.${check.ext}`);
    try {
      fs.writeFileSync(savePath, buf);
    } catch (e) {
      return {
        ok: false,
        reason: "error",
        msg: `保存文件失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // ⑨ 写入下载历史（SQLite；只有走到这里 = 文件已保存且校验已通过）
    const sha256 = createHash("sha256").update(buf).digest("hex");
    await history.addDownload({
      id: wp.id,
      wtId: id,
      title: clean,
      category: wp.category === "phone" ? "phone" : wp.category === "computer" ? "computer" : null,
      width: check.width,
      height: check.height,
      format: check.format,
      bytes: check.bytes,
      sha256,
      savedPath: savePath,
      downloadedAt: Date.now(),
    });

    log(
      `原图已保存：${savePath}（${check.width}×${check.height} ${check.format} ` +
        `${(check.bytes / 1024 / 1024).toFixed(2)}MB，期望 ${expect ? `${expect.width}×${expect.height}` : "无"}，` +
        `sha256:${sha256.slice(0, 16)}）`
    );

    // ⑩ 结果（渲染层展示「已保存官网原图 WxH · 大小」）
    return {
      ok: true,
      savedPath: savePath,
      width: check.width,
      height: check.height,
      aspectRatio: check.aspectRatio,
      format: check.format,
      bytes: check.bytes,
      sha256,
      expectedWidth: expect ? expect.width : undefined,
      expectedHeight: expect ? expect.height : undefined,
      metaVerified: !!expect,
    };
  };

  /**
   * 入队一次下载（串行 + 最小间隔节流；熔断快速失败不排队）。
   * @param wp { id, wtId?, title, category? } 统一壁纸模型字段
   */
  const download = (wp) => {
    if (restrictedFused()) return Promise.resolve(restrictedResult());
    const task = dlChain.then(async () => {
      const wait = lastDlStartAt + DL_MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      lastDlStartAt = Date.now();
      return runDownload(wp);
    });
    dlChain = task.catch(() => undefined);
    return task;
  };

  return { download };
}

module.exports = { createOriginalDownloadService };
