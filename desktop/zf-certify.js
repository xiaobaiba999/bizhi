/**
 * 壁纸工坊 · 哲风官网 ALTCHA 人机验证（桌面主进程，CommonJS）
 * ============================================================
 * v2.0 从 zf-login.js 拆出（原内联实现），职责单一：
 * 官网 getCompleteUrl（原图直链）的前置人机验证。
 *
 * 官网浏览器端真实流程（已抓包确认）：
 * 1. GET  /link/pc/certify/challenge
 *    → {"algorithm":"SHA-256","challenge":"<hex>","maxnumber":160000,
 *       "salt":"<hex>?expires=<epoch>&","signature":"<hex>"}
 * 2. 客户端解工作量证明：找 n（0 ≤ n ≤ maxnumber）使
 *    SHA-256(salt + n) === challenge（本机约几十毫秒）
 * 3. POST /link/pc/certify/verify  body={"payload": base64(JSON)}
 *    → {"status":200,"msg":"验证成功"}；验证状态绑定在负载均衡的
 *    server_session Cookie 上
 * 4. 后续 getCompleteUrl 必须携带同一 server_session Cookie，并带上
 *    __media=1&__responseCodec=aeg-v2 查询参数，否则 3004
 *
 * 验证会话缓存约 8 分钟内复用；多请求并发共用同一次验证（in-flight 去重）。
 * 与 src/lib/zf-certify.ts（服务器版 TS 孪生）逐行对齐，改一处同步另一处。
 */

"use strict";

const { createHash } = require("node:crypto");

const API_BASE = "https://haowallpaper.com";
const CERTIFY_CHALLENGE_URL = `${API_BASE}/link/pc/certify/challenge`;
const CERTIFY_VERIFY_URL = `${API_BASE}/link/pc/certify/verify`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** ALTCHA 验证会话有效时长（官方 15 分钟内可用，保守取 8 分钟） */
const CERTIFY_TTL_MS = 8 * 60 * 1000;

/** 已缓存的验证会话 */
let certifySession = null; // { cookie, verifiedAt }
let certifyInflight = null;

/** 解工作量证明：找 n 使 SHA-256(salt + n) === challenge */
function solveChallenge(challenge) {
  const { salt, challenge: target, maxnumber } = challenge;
  for (let n = 0; n <= maxnumber; n++) {
    const hash = createHash("sha256").update(salt + n).digest("hex");
    if (hash === target) return n;
  }
  return null;
}

/** 从响应头收集 server_session cookie（name=value 对） */
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

/**
 * 确保已通过人机验证，返回应回放到后续请求的 Cookie（server_session_xxx=yyy）。
 * - 已在有效期内 → 复用缓存
 * - 并发调用 → 共用同一个进行中的验证流程
 * - 失败 → 返回 null（调用方按无 Cookie 请求，可能 305 后重验）
 */
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

/** 丢弃当前验证会话（下次调用 ensureCertified 会重新验证） */
function invalidateCertification() {
  certifySession = null;
}

module.exports = { ensureCertified, invalidateCertification };
