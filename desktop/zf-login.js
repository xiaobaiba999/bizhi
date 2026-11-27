/**
 * 壁纸工坊 · 桌面版扫码登录 + 令牌管理（主进程，CommonJS）
 * ============================================================
 * v2.0 阶段三拆分后职责单一：微信扫码登录 + 令牌存取/校验。
 * 原内联的 ALTCHA 验证 → desktop/zf-certify.js；
 * 原图下载 → desktop/original-download.js（OriginalDownloadService）。
 *
 * 1. 扫码登录（哲风壁纸 haowallpaper.com 微信登录，主进程全托管）：
 *    - 抓取微信 qrconnect 页面提取 uuid，二维码图片转 dataURL 传渲染层
 *      （app:// origin 直连微信图片会被 Referer 策略拦截）
 *    - 后台长轮询微信 lp 端点：408 等待 / 404 已扫 / 405 已确认 / 402 过期
 *    - 用户确认后主进程代替浏览器走官网 wxLogin 回调 → stateLogin 轮询拿令牌
 *    - 令牌写入 userData/ww-settings.json（跨版本升级永不丢）
 * 2. verifyToken：getCompleteUrl 实测令牌有效性（只换直链不下载，
 *    依赖 zf-certify 的 ALTCHA 会话）。
 *
 * 与服务器版 src/lib/zf-login.ts 逻辑逐行对齐。
 */

"use strict";

const { randomUUID } = require("node:crypto");
const { ensureCertified, invalidateCertification } = require("./zf-certify.js");

const API_BASE = "https://haowallpaper.com";
const ZF_WX_APPID = "wx5b6879182de50dd6";
const ZF_WX_CALLBACK = `${API_BASE}/link/app/appUser/wxLogin`;
const ZF_STATE_LOGIN_URL = `${API_BASE}/link/app/appUser/stateLogin`;
const WX_QRCONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WX_LP_URL = "https://lp.open.weixin.qq.com/connect/l/qrconnect";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 二维码会话本地过期时间（毫秒） */
const QR_SESSION_TTL_MS = 180 * 1000;

function zfHeaders(extra) {
  return {
    "User-Agent": UA,
    Referer: `${API_BASE}/`,
    Accept: "application/json, text/plain, */*",
    ...(extra || {}),
  };
}

/** getCompleteUrl 直链接口（verifyToken 探测用；必须带必需查询参数） */
function completeUrlOf(wtId) {
  return `${API_BASE}/link/common/file/getCompleteUrl/${encodeURIComponent(wtId)}?__media=1&__responseCodec=aeg-v2`;
}

/* ---------------- Cookie jar（官网粘性会话回放） ---------------- */

function collectCookies(res, jar) {
  try {
    const list =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = String(raw).split(";")[0].trim();
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && value) jar.set(name, value);
    }
  } catch {
    /* ignore */
  }
}

function cookieHeader(jar) {
  if (!jar || jar.size === 0) return null;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/* ---------------- 扫码会话 ---------------- */

const sessions = new Map();

function extractUuid(html) {
  const m1 = html.match(/\/connect\/qrcode\/([0-9A-Za-z_-]{6,64})/);
  if (m1) return m1[1];
  const m2 = html.match(/window\.uuid\s*=\s*["']([0-9A-Za-z_-]{6,64})["']/);
  return m2 ? m2[1] : null;
}

/** 令牌响应里深挖 token 字段（兼容 data / data.data 两层） */
function digToken(data, depth = 0) {
  if (!data || typeof data !== "object" || Array.isArray(data) || depth > 3) return null;
  if (typeof data.token === "string" && data.token.length > 0) return data.token;
  return digToken(data.data, depth + 1);
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

/** lp 响应解析：window.wx_errcode=405;window.wx_code='xxx'; */
function parseLp(text) {
  const ec = text.match(/wx_errcode=(\d+)/);
  const code = text.match(/wx_code='([^']*)'/) || text.match(/wx_code="([^"]*)"/);
  return { errcode: ec ? Number(ec[1]) : -1, code: code ? code[1] : "" };
}

/** 发起扫码会话：抓 qrconnect 页面 → 提取 uuid → 二维码转 dataURL → 启动后台轮询 */
async function startQrSession(state) {
  const s = sessions.get(state);
  if (!s) throw new Error("会话不存在，请刷新重试");

  const params = new URLSearchParams({
    appid: ZF_WX_APPID,
    scope: "snsapi_login",
    redirect_uri: ZF_WX_CALLBACK,
    state,
    login_type: "jssdk",
    self_redirect: "true",
  });
  const pageUrl = `${WX_QRCONNECT_URL}?${params.toString()}`;
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": UA,
      Referer: `${API_BASE}/`,
      Accept: "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`微信二维码页面获取失败（HTTP ${res.status}）`);

  const html = await res.text();
  const uuid = extractUuid(html);
  if (!uuid) throw new Error("微信二维码解析失败（页面结构可能已变化）");

  // 二维码图片转 dataURL（app:// origin 直连会被微信 Referer 策略拦截）
  const qrRes = await fetch(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, {
    headers: { "User-Agent": UA, Referer: pageUrl, Accept: "image/*,*/*" },
    signal: AbortSignal.timeout(10000),
  });
  if (!qrRes.ok) throw new Error(`微信二维码图片获取失败（HTTP ${qrRes.status}）`);
  const buf = Buffer.from(await qrRes.arrayBuffer());
  if (buf.length === 0) throw new Error("微信二维码图片内容为空");
  const mime = (qrRes.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

  s.uuid = uuid;
  s.qrconnectUrl = pageUrl;
  s.phase = "waiting";
  void pollLoop(s); // 后台长轮询（不 await）
  return dataUrl;
}

/** 会话级后台轮询循环（与服务器版一致：408/404/403/402/405 五态） */
async function pollLoop(s) {
  let last = 400;
  while (sessions.get(s.state) === s && Date.now() - s.createdAt < QR_SESSION_TTL_MS) {
    if (s.phase === "ok" || s.phase === "expired" || s.phase === "error") return;
    try {
      const res = await fetch(`${WX_LP_URL}?uuid=${s.uuid}&last=${last}`, {
        headers: {
          "User-Agent": UA,
          // 关键：与真实微信 iframe 内 JS 完全一致 —— Referer 是完整 qrconnect 页面 URL
          Referer: s.qrconnectUrl || WX_QRCONNECT_URL,
          Accept: "*/*",
        },
        signal: AbortSignal.timeout(22_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { errcode, code } = parseLp(await res.text());
      s.lpFails = 0;

      if (errcode === 405 && code) {
        s.phase = "scanned";
        s.msg = "授权已确认，正在获取登录令牌…";
        await finalizeLogin(s, code);
        return;
      }
      if (errcode === 404) {
        s.phase = "scanned";
        s.msg = null;
        last = 404;
        continue;
      }
      if (errcode === 403) {
        s.phase = "waiting";
        s.msg = "已取消授权，可重新扫码";
        last = 403;
        continue;
      }
      if (errcode === 402) {
        s.phase = "expired";
        s.msg = "二维码已过期，请刷新后重新扫码";
        return;
      }
      if (errcode === 408) {
        last = 408;
        if (s.phase === "scanned") s.phase = "waiting";
        continue;
      }
      s.lpFails += 1;
      if (s.lpFails >= 5) {
        s.phase = "error";
        s.msg = `微信扫码状态异常（errcode=${errcode}），请刷新重试`;
        return;
      }
    } catch {
      s.lpFails += 1;
      if (s.lpFails >= 5) {
        s.phase = "error";
        s.msg = "与微信服务器的连接异常，请刷新重试";
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (sessions.get(s.state) === s && s.phase !== "ok") {
    s.phase = "expired";
    s.msg = "二维码已超时，请刷新后重新扫码";
  }
}

/** code → 官网回调 → 令牌（回调 + stateLogin 轮询，Cookie 回放保持粘性会话） */
async function finalizeLogin(s, wxCode) {
  const cbUrl = `${ZF_WX_CALLBACK}?code=${encodeURIComponent(wxCode)}&state=${encodeURIComponent(s.state)}`;
  let token = null;
  let cbNote = "";
  try {
    const res = await fetch(cbUrl, {
      headers: zfHeaders({ Origin: API_BASE }),
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    collectCookies(res, s.zfCookies);
    const text = await res.text();
    try {
      token = digToken(JSON.parse(text));
    } catch {
      /* HTML 响应：令牌挂在 state 上，走 stateLogin 轮询 */
    }
    if (!token) cbNote = `官网回调返回 HTTP ${res.status}`;
  } catch (e) {
    cbNote = `官网回调请求失败：${e instanceof Error ? e.message : "网络异常"}`;
  }

  for (let i = 0; i < 10 && !token; i++) {
    const cookies = cookieHeader(s.zfCookies);
    try {
      const r = await fetch(`${ZF_STATE_LOGIN_URL}?state=${encodeURIComponent(s.state)}`, {
        headers: zfHeaders({ Origin: API_BASE, ...(cookies ? { Cookie: cookies } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await r.text();
      const json = JSON.parse(text);
      const status = Number(json.status ?? -1);
      if (status === 200) {
        token = digToken(json.data) || digToken(json);
        if (token) break;
      } else if (status === 305) {
        const msg = typeof json.msg === "string" ? json.msg.trim() : "";
        if (msg) {
          cbNote = cbNote || msg;
          break;
        }
      }
    } catch {
      /* 网络抖动：2 秒后继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (token) {
    s.phase = "ok";
    s.token = token;
    s.msg = undefined;
  } else {
    s.phase = "error";
    s.msg =
      `授权已确认，但获取登录令牌失败（${cbNote || "官网未返回令牌"}）。` +
      "请刷新重试或改用手动粘贴";
  }
}

/* ---------------- 模块工厂（依赖注入主进程能力） ---------------- */

/**
 * 创建登录模块。
 * @param deps
 *   - readSettings(): object               读 userData 设置（含 zfToken 字段）
 *   - writeSettings(s): void               写设置（令牌持久化）
 *   - log(line): void                      可选：主进程运行日志（缺省 no-op）
 */
function createLoginModule(deps) {
  const { readSettings, writeSettings, log = () => {} } = deps;

  /** 令牌脱敏展示：保留前 8 后 4 位 */
  const maskToken = (token) =>
    token.length <= 12 ? `${token.slice(0, 2)}****` : `${token.slice(0, 8)}****${token.slice(-4)}`;

  /* ----- 令牌存取（ww-settings.json 跨版本持久） ----- */

  const rawToken = () => {
    const t = readSettings().zfToken;
    return typeof t === "string" && t.length >= 8 ? t : null;
  };

  const getToken = async () => {
    const t = rawToken();
    if (!t) return null;
    const s = readSettings();
    return {
      token: maskToken(t),
      source: typeof s.zfTokenSource === "string" ? s.zfTokenSource : "qrcode",
      createdAt: typeof s.zfTokenAt === "string" ? s.zfTokenAt : new Date().toISOString(),
    };
  };

  const saveToken = async (token, source) => {
    const t = String(token || "").trim();
    if (t.length < 8 || t.length > 512) return false;
    writeSettings({
      ...readSettings(),
      zfToken: t,
      zfTokenSource: source === "manual" ? "manual" : "qrcode",
      zfTokenAt: new Date().toISOString(),
    });
    return true;
  };

  const clearToken = async () => {
    const s = readSettings();
    delete s.zfToken;
    delete s.zfTokenSource;
    delete s.zfTokenAt;
    writeSettings(s);
    return true;
  };

  /* ----- 扫码会话（渲染层每 2 秒轮询一次状态） ----- */

  const loginStart = async () => {
    try {
      // 清理超过 10 分钟的旧会话，防止内存增长
      if (sessions.size > 32) {
        const now = Date.now();
        for (const [k, s] of sessions) {
          if (now - s.createdAt > 600_000) sessions.delete(k);
        }
      }
      const state = randomUUID();
      sessions.set(state, {
        state,
        uuid: null,
        qrconnectUrl: null,
        createdAt: Date.now(),
        phase: "starting",
        token: undefined,
        msg: undefined,
        tokenSaved: false,
        lpFails: 0,
        zfCookies: new Map(),
      });
      const qrDataUrl = await startQrSession(state);
      return { state, qrDataUrl };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "二维码会话创建失败，请检查网络后重试" };
    }
  };

  const loginPoll = async (state) => {
    const s = sessions.get(String(state || ""));
    if (!s) return { status: "error", msg: "会话不存在或已失效，请刷新二维码" };
    if (s.phase === "ok" && s.token) {
      // 令牌首次出现：自动入库（与服务器版 GET /api/zf-login 行为一致）
      if (!s.tokenSaved) {
        try {
          await saveToken(s.token, "qrcode");
          s.tokenSaved = true;
        } catch {
          /* 入库失败不阻塞返回，下次轮询重试 */
        }
      }
      return { status: "ok", msg: "登录成功，令牌已保存" };
    }
    if (s.phase === "expired") return { status: "expired", msg: s.msg || "二维码已过期" };
    if (s.phase === "error") return { status: "error", msg: s.msg || "登录失败" };
    return {
      status: s.phase === "scanned" ? "scanned" : "pending",
      msg: s.msg || undefined,
    };
  };

  /* ----- 令牌验证（getCompleteUrl 实测，只换直链不下载） ----- */

  const verifyToken = async (wtId) => {
    const token = rawToken();
    if (!token) return { valid: false, msg: "尚未登录" };
    const id = /^[0-9A-Za-z_-]{1,64}$/.test(String(wtId || "")) ? wtId : null;

    const probe = async () => {
      try {
        const cookie = await ensureCertified();
        const res = await fetch(completeUrlOf(id || "0"), {
          headers: zfHeaders({ token, ...(cookie ? { Cookie: cookie } : {}) }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429) return { valid: null, msg: "官网限流中，稍后再验证" };
        const json = await res.json().catch(() => null);
        if (json && digUrl(json)) return { valid: true, msg: "令牌有效（可获取原图直链）" };
        const status = Number(json?.status ?? -1);
        const msg = typeof json?.msg === "string" ? json.msg.trim() : "";
        if (status === 401 || /未授权/.test(msg)) return { valid: false, msg: "令牌已失效，请重新扫码" };
        if (status === 305) return { valid: null, msg: `人机验证会话异常（3004/3005），稍后再试` };
        return { valid: null, msg: msg || `官网响应异常（HTTP ${res.status}）` };
      } catch (e) {
        return { valid: null, msg: `探测失败：${e instanceof Error ? e.message : "网络异常"}` };
      }
    };

    let result = await probe();
    // 疑似人机验证过期（3004）：强制重验后再探一次
    if (result.valid !== true && typeof result.msg === "string" && result.msg.includes("3004")) {
      invalidateCertification();
      result = await probe();
    }
    return result;
  };

  return { loginStart, loginPoll, getToken, saveToken, clearToken, verifyToken, rawToken };
}

module.exports = { createLoginModule };
