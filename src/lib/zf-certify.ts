/**
 * 哲风壁纸（haowallpaper.com）ALTCHA 人机验证 —— 服务端托管实现
 *
 * 背景：官网的 getCompleteUrl（原图直链）接口在返回数据前要求客户端先通过
 * 「我不是机器人」工作量证明验证（ALTCHA 协议）。未通过时一律返回
 * 305 [错误的请求 -> 3004]，与令牌是否有效无关 —— 这是「扫码成功却提示
 * 令牌失效」的真正根因。
 *
 * 官网浏览器端的真实流程（已抓包确认）：
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
 * 本模块在服务端完整托管该流程并缓存验证会话（约 8 分钟内复用），
 * 多请求并发时共用同一次验证（in-flight 去重）。
 */

import { createHash } from "node:crypto"

const API_BASE = "https://haowallpaper.com"

/** 挑战端点 */
const CERTIFY_CHALLENGE_URL = `${API_BASE}/link/pc/certify/challenge`
/** 验证提交端点 */
const CERTIFY_VERIFY_URL = `${API_BASE}/link/pc/certify/verify`

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

/** 验证会话有效时长：官方实测 15 分钟内可用，保守取 8 分钟强制重验 */
const CERTIFY_TTL_MS = 8 * 60 * 1000

/** ALTCHA 挑战结构（官方端点返回） */
interface AltchaChallenge {
  algorithm: string
  challenge: string
  maxnumber: number
  salt: string
  signature: string
}

/** 已缓存的验证会话 */
interface CertifySession {
  /** 验证绑定的 server_session Cookie（name=value） */
  cookie: string
  /** 验证成功时间戳 */
  verifiedAt: number
}

let session: CertifySession | null = null
/** 并发去重：同一时刻只允许一个验证流程在跑 */
let inflight: Promise<CertifySession> | null = null

/* ---------------- 工具 ---------------- */

/** 兼容各运行时的 set-cookie 读取 */
function getSetCookieList(headers: Headers): string[] {
  const h = headers as unknown as { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie()
    } catch {
      return []
    }
  }
  const single = headers.get("set-cookie")
  return single ? [single] : []
}

/** 从响应头收集 server_session cookie（name=value 对） */
function collectSessionCookie(res: Response): string | null {
  for (const raw of getSetCookieList(res.headers)) {
    const pair = (raw.split(";")[0] ?? "").trim()
    if (pair.startsWith("server_session_")) return pair
  }
  return null
}

/** 解工作量证明：找 n 使 SHA-256(salt + n) === challenge */
function solveChallenge(challenge: AltchaChallenge): number | null {
  const { salt, challenge: target, maxnumber } = challenge
  for (let n = 0; n <= maxnumber; n++) {
    const hash = createHash("sha256").update(salt + n).digest("hex")
    if (hash === target) return n
  }
  return null
}

/* ---------------- 验证主流程 ---------------- */

/**
 * 执行一次完整的 ALTCHA 验证（挑战 → PoW → 提交）。
 * 失败抛错（调用方回退预览质量，不打断下载）。
 */
async function runCertification(): Promise<CertifySession> {
  // ① 拿挑战（同时获得绑定的 server_session cookie）
  const chalRes = await fetch(CERTIFY_CHALLENGE_URL, {
    headers: {
      "User-Agent": UA,
      Referer: `${API_BASE}/`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  })
  if (!chalRes.ok) throw new Error(`获取人机验证挑战失败（HTTP ${chalRes.status}）`)

  const cookie = collectSessionCookie(chalRes) ?? ""
  const challenge = (await chalRes.json().catch(() => null)) as AltchaChallenge | null
  if (!challenge?.challenge || !challenge?.salt) {
    throw new Error("人机验证挑战数据异常")
  }

  // ② 解工作量证明
  const number = solveChallenge(challenge)
  if (number === null) throw new Error("人机验证工作量证明求解失败")

  // ③ 构造 ALTCHA payload（base64 编码的 JSON，与官网前端一致）
  const payload = Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number,
      salt: challenge.salt,
      signature: challenge.signature,
    })
  ).toString("base64")

  // ④ 提交验证（带会话 cookie，保持与挑战同一后端）
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
    cache: "no-store",
  })

  // 验证响应可能刷新 server_session（负载均衡重新粘滞）
  const refreshedCookie = collectSessionCookie(verifyRes)
  const finalCookie = refreshedCookie ?? cookie
  const json = (await verifyRes.json().catch(() => null)) as
    | { status?: number | string; msg?: string }
    | null
  const ok = Number(json?.status ?? -1) === 200
  if (!ok || !finalCookie) {
    throw new Error(`人机验证未通过（${json?.msg || `HTTP ${verifyRes.status}`}）`)
  }

  return { cookie: finalCookie, verifiedAt: Date.now() }
}

/** 当前缓存的验证会话是否仍有效 */
export function isCertified(): boolean {
  return !!session && Date.now() - session.verifiedAt < CERTIFY_TTL_MS
}

/**
 * 确保已通过人机验证，返回应回放到后续请求的 Cookie（如 server_session_xxx=yyy）。
 * - 已在有效期内 → 直接复用缓存
 * - 并发调用 → 共用同一个进行中的验证流程
 * - 失败 → 返回 null（调用方降级为无 Cookie 请求，仍可能成功或回退预览）
 */
export async function ensureCertified(force = false): Promise<string | null> {
  if (!force && isCertified() && session) return session.cookie
  if (inflight) return inflight.then((s) => s.cookie).catch(() => null)

  inflight = (async () => {
    const s = await runCertification()
    session = s
    return s
  })()

  try {
    const s = await inflight
    return s.cookie
  } catch {
    return null
  } finally {
    inflight = null
  }
}

/** 丢弃当前验证会话（下次调用 ensureCertified 会重新验证） */
export function invalidateCertification(): void {
  session = null
}
