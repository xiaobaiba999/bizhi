/**
 * 壁纸工坊 · 桌面版扫码登录 + 原图下载模块（主进程，CommonJS）
 * ============================================================
 * v1.4.7 桌面构建重构为「纯静态导出 + app:// 协议」后，渲染层不再有 Next
 * 服务端，扫码登录（依赖服务端抓取微信页面 / 长轮询 / ALTCHA 人机验证）
 * 随之消失——这正是用户反馈「最新版扫码登录没了」的根因。
 * v1.4.9 把整套登录链路搬进 Electron 主进程（Node 环境无 CORS 限制）：
 *
 * 1. 扫码登录（哲风壁纸 haowallpaper.com 微信登录，服务端全托管）：
 *    - 抓取微信 qrconnect 页面提取 uuid，二维码图片转 dataURL 传渲染层
 *      （app:// origin 直连微信图片会被 Referer 策略拦截）
 *    - 后台长轮询微信 lp 端点：408 等待 / 404 已扫 / 405 已确认 / 402 过期
 *    - 用户确认后主进程代替浏览器走官网 wxLogin 回调 → stateLogin 轮询拿令牌
 *    - 令牌写入 userData/ww-settings.json（跨版本升级永不丢）
 * 2. ALTCHA 人机验证（getCompleteUrl 的前置要求，会话缓存 8 分钟复用）
 * 3. 原图直存：getCompleteUrl 换官网原图直链 → 下载字节直接写入保存目录
 *
 * 与服务器版 src/lib/zf-login.ts / zf-certify.ts 逻辑逐行对齐。
 */

"use strict";

const { createHash, randomUUID } = require("node:crypto");

const API_BASE = "https://haowallpaper.com";
const ZF_WX_APPID = "wx5b6879182de50dd6";
const ZF_WX_CALLBACK = `${API_BASE}/link/app/appUser/wxLogin`;
const ZF_STATE_LOGIN_URL = `${API_BASE}/link/app/appUser/stateLogin`;
const WX_QRCONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WX_LP_URL = "https://lp.open.weixin.qq.com/connect/l/qrconnect";

const CERTIFY_CHALLENGE_URL = `${API_BASE}/link/pc/certify/challenge`;
const CERTIFY_VERIFY_URL = `${API_BASE}/link/pc/certify/verify`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 二维码会话本地过期时间（毫秒） */
const QR_SESSION_TTL_MS = 180 * 1000;
/** ALTCHA 验证会话有效时长（官方 15 分钟内可用，保守取 8 分钟） */
const CERTIFY_TTL_MS = 8 * 60 * 1000;

function zfHeaders(extra) {
  return {
    "User-Agent": UA,
    Referer: `${API_BASE}/`,
    Accept: "application/json, text/plain, */*",
    ...(extra || {}),
  };
}

/** getCompleteUrl 直链接口（必须带 __media=1&__responseCodec=aeg-v2，否则 305/3004） */
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

/* ---------------- ALTCHA 人机验证 ---------------- */

let certifySession = null; // { cookie, verifiedAt }
let certifyInflight = null;

function solveChallenge(challenge) {
  const { salt, challenge: target, maxnumber } = challenge;
  for (let n = 0; n <= maxnumber; n++) {
    const hash = createHash("sha256").update(salt + n).digest("hex");
    if (hash === target) return n;
  }
  return null;
}

function collectSessionCookie(res) {
  try {
    const list =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = String(raw).split(";")[0].trim();
      if (pair.startsWith("server_session_")) return pair;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 执行一次完整 ALTCHA 验证（挑战 → PoW → 提交） */
async function runCertification() {
  const chalRes = await fetch(CERTIFY_CHALLENGE_URL, {
    headers: { "User-Agent": UA, Referer: `${API_BASE}/`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!chalRes.ok) throw new Error(`获取人机验证挑战失败（HTTP ${chalRes.status}）`);

  const cookie = collectSessionCookie(chalRes) || "";
  const challenge = await chalRes.json().catch(() => null);
  if (!challenge || !challenge.challenge || !challenge.salt) {
    throw new Error("人机验证挑战数据异常");
  }

  const number = solveChallenge(challenge);
  if (number === null) throw new Error("人机验证工作量证明求解失败");

  const payload = Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number,
      salt: challenge.salt,
      signature: challenge.signature,
    })
  ).toString("base64");

  const verifyRes = await fetch(`${CERTIFY_VERIFY_URL}?__media=1&__responseCodec=aeg-v2`, {
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
  });

  const refreshedCookie = collectSessionCookie(verifyRes);
  const finalCookie = refreshedCookie || cookie;
  const json = await verifyRes.json().catch(() => null);
  if (Number(json?.status ?? -1) !== 200 || !finalCookie) {
    throw new Error(`人机验证未通过（${json?.msg || `HTTP ${verifyRes.status}`}）`);
  }
  return { cookie: finalCookie, verifiedAt: Date.now() };
}

/** 确保已通过人机验证，返回应回放的 Cookie；失败返回 null */
async function ensureCertified(force = false) {
  if (!force && certifySession && Date.now() - certifySession.verifiedAt < CERTIFY_TTL_MS) {
    return certifySession.cookie;
  }
  if (certifyInflight) return certifyInflight.then((s) => s.cookie).catch(() => null);

  certifyInflight = (async () => {
    const s = await runCertification();
    certifySession = s;
    return s;
  })();

  try {
    const s = await certifyInflight;
    return s.cookie;
  } catch {
    return null;
  } finally {
    certifyInflight = null;
  }
}

function invalidateCertification() {
  certifySession = null;
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
 *   - getSaveDir(): string                 壁纸保存目录
 *   - uniqueSavePath(dir, name): string    同名不覆盖的保存路径
 *   - notifySaved(quality, filename): void 保存完成通知（复用系统通知）
 */
function createLoginModule(deps) {
  const { readSettings, writeSettings, getSaveDir, uniqueSavePath } = deps;

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
          return { status: "error", msg: "令牌保存失败" };
        }
      }
      return { status: "ok" };
    }
    if (s.phase === "expired") return { status: "expired", msg: s.msg || null };
    if (s.phase === "error") return { status: "error", msg: s.msg || "登录状态异常，请刷新重试" };
    if (s.phase === "scanned") return { status: "scanned", msg: s.msg || null };
    return { status: "pending", msg: s.msg || null };
  };

  /* ----- 令牌验证（getCompleteUrl 实测，只换直链不下载） ----- */

  const verifyToken = async (wtId) => {
    const id = String(wtId || "");
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) {
      return { valid: null, msg: "缺少有效的壁纸 id，无法验证令牌" };
    }
    const token = rawToken();
    if (!token) return { valid: null, msg: "no-token" };

    const probe = async () => {
      try {
        const cookie = await ensureCertified();
        const res = await fetch(completeUrlOf(id), {
          headers: zfHeaders({ token, ...(cookie ? { Cookie: cookie } : {}) }),
          signal: AbortSignal.timeout(10000),
        });
        const json = await res.json().catch(() => null);
        if (json && digUrl(json)) return { valid: true };
        const status = Number(json?.status ?? -1);
        const msg = typeof json?.msg === "string" ? json.msg.trim() : "";
        if (status === 401 || /未授权/.test(msg)) {
          return { valid: false, msg: (msg || `HTTP ${res.status}`).slice(0, 80) };
        }
        return { valid: null, msg: (msg || `HTTP ${res.status}`).slice(0, 80) };
      } catch {
        return { valid: null, msg: "官网连接异常，未能验证" };
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

  /* ----- 原图直存（串行队列：避免 ALTCHA 会话并发竞争） ----- */

  let dlChain = Promise.resolve();

  /** 单次原图直存：ALTCHA → getCompleteUrl → 下载字节写入保存目录 */
  const runOriginalDownload = async (wtId, filename) => {
    const token = rawToken();
    if (!token) return { ok: false, quality: "preview", reason: "no-token" };

    const id = /^[0-9A-Za-z_-]{1,64}$/.test(String(wtId || "")) ? wtId : null;
    if (!id) return { ok: false, quality: "preview", reason: "error", msg: "壁纸 id 不合法" };

    let target = null;
    try {
      const cookie = await ensureCertified();
      const res = await fetch(completeUrlOf(id), {
        headers: zfHeaders({ token, ...(cookie ? { Cookie: cookie } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => null);
      target = json ? digUrl(json) : null;
      if (!target) {
        const status = Number(json?.status ?? -1);
        const msg = typeof json?.msg === "string" ? json.msg.trim() : "";
        if (status === 401 || /未授权/.test(msg)) {
          return { ok: false, quality: "preview", reason: "auth-expired", msg };
        }
        if (status === 305) {
          // 人机验证可能过期：重验一次
          invalidateCertification();
          const cookie2 = await ensureCertified(true);
          const res2 = await fetch(completeUrlOf(id), {
            headers: zfHeaders({ token, ...(cookie2 ? { Cookie: cookie2 } : {}) }),
            signal: AbortSignal.timeout(15000),
          });
          const json2 = await res2.json().catch(() => null);
          target = json2 ? digUrl(json2) : null;
          const status2 = Number(json2?.status ?? -1);
          const msg2 = typeof json2?.msg === "string" ? json2.msg.trim() : "";
          if (!target) {
            if (status2 === 401 || /未授权/.test(msg2)) {
              return { ok: false, quality: "preview", reason: "auth-expired", msg: msg2 };
            }
            return { ok: false, quality: "preview", reason: "error", msg: msg2 || `官网接口异常（HTTP ${status2}）` };
          }
        } else {
          return { ok: false, quality: "preview", reason: "error", msg: msg || `官网接口异常（HTTP ${res.status}）` };
        }
      }
    } catch (e) {
      return {
        ok: false,
        quality: "preview",
        reason: "error",
        msg: e instanceof Error ? e.message : "官网连接异常",
      };
    }

    // 下载原图字节并写入保存目录
    try {
      const upstream = await fetch(target, {
        headers: zfHeaders({ token }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!upstream.ok) {
        return { ok: false, quality: "preview", reason: "error", msg: `原图下载失败（HTTP ${upstream.status}）` };
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length === 0) return { ok: false, quality: "preview", reason: "error", msg: "原图内容为空" };

      // 文件名：清洗 + 从原图直链推断扩展名（官网原图多为 png）
      const clean = String(filename || "wallpaper")
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "wallpaper";
      const dot = target.lastIndexOf(".");
      const urlExt = dot === -1 ? "" : target.slice(dot + 1).toLowerCase();
      const ext = /^\w{2,5}$/.test(urlExt) ? urlExt : "png";
      const savePath = uniqueSavePath(getSaveDir(), `${clean}.${ext}`);
      const fs = require("node:fs");
      fs.writeFileSync(savePath, buf);
      return { ok: true, quality: "original", savedPath: savePath };
    } catch (e) {
      return {
        ok: false,
        quality: "preview",
        reason: "error",
        msg: e instanceof Error ? e.message : "原图保存失败",
      };
    }
  };

  /** 入队一次原图下载（串行执行，返回统一结果） */
  const downloadOriginal = (wtId, filename) => {
    const task = dlChain.then(() => runOriginalDownload(wtId, filename));
    // 链上异常不阻塞后续任务
    dlChain = task.catch(() => undefined);
    return task;
  };

  return { loginStart, loginPoll, getToken, saveToken, clearToken, verifyToken, downloadOriginal };
}

module.exports = { createLoginModule };
