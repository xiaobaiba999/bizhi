/**
 * 哲风壁纸（haowallpaper.com）微信扫码登录
 *
 * 登录机制（逆向自官网前端）：
 * 1. 页面生成随机 state，内嵌微信开放平台二维码 iframe：
 *    https://open.weixin.qq.com/connect/qrconnect?appid=<appid>&scope=snsapi_login
 *      &redirect_uri=<官网回调>&state=<state>&login_type=jssdk&self_redirect=true
 * 2. 手机微信扫码确认后，二维码 iframe 跳到官网回调（code+state），官网服务端
 *    用 code 换取用户信息并把登录令牌挂到该 state 上。
 * 3. 页面轮询 /link/app/appUser/stateLogin?state=<state>，出现 token 即登录成功。
 *
 * 本地服务端代替浏览器轮询（无 CORS 问题），拿到令牌后存入本地数据库。
 */

const API_BASE = "https://haowallpaper.com"

/** 哲风壁纸的微信开放平台 appid */
export const ZF_WX_APPID = "wx5b6879182de50dd6"

/** 官网微信登录回调地址（OAuth redirect_uri） */
export const ZF_WX_CALLBACK = "https://haowallpaper.com/link/app/appUser/wxLogin"

/** 扫码状态轮询接口 */
export const ZF_STATE_LOGIN_URL = `${API_BASE}/link/app/appUser/stateLogin`

/**
 * 扫码会话登记（进程内存）：记录创建时间，用于本地判定过期，
 * 避免「源站迟迟不报过期 → 前端无限等待」的问题。
 */
const sessions = new Map<string, number>()

/** 二维码会话本地过期时间（毫秒）：超过即直接判过期，不再依赖源站 */
export const QR_SESSION_TTL_MS = 3 * 60 * 1000

/** 登录相关端点连通性（用于提前给出明确错误，避免无意义的无限等待） */
export interface LoginEndpointStatus {
  /** 微信开放平台（二维码 iframe）是否可达 */
  wx: boolean
  /** 哲风壁纸登录服务是否可达 */
  zf: boolean
}

/** 令牌获取原图直链接口 */
export function zfCompleteUrl(wtId: string): string {
  return `${API_BASE}/link/common/file/getCompleteUrl/${encodeURIComponent(wtId)}`
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

export function zfUpstreamHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": UA,
    Referer: `${API_BASE}/`,
    Accept: "application/json, text/plain, */*",
    ...extra,
  }
}

/** 生成随机 state（与官网一致的 uuid 形态），同时登记会话创建时间 */
export function newState(): string {
  const state = crypto.randomUUID()
  sessions.set(state, Date.now())
  // 顺手清理超过 1 小时的旧会话，防止内存增长
  if (sessions.size > 64) {
    const now = Date.now()
    for (const [k, t] of sessions) {
      if (now - t > 3_600_000) sessions.delete(k)
    }
  }
  return state
}

/** 构造微信开放平台扫码二维码 iframe 地址（与官网 WxLogin 参数一致） */
export function buildWxQrUrl(state: string): string {
  const params = new URLSearchParams({
    appid: ZF_WX_APPID,
    scope: "snsapi_login",
    redirect_uri: ZF_WX_CALLBACK,
    state,
    login_type: "jssdk",
    self_redirect: "true",
  })
  return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}`
}

export type ZfPollStatus = "pending" | "ok" | "expired" | "error"

export interface ZfPollResult {
  status: ZfPollStatus
  /** 登录成功时的令牌 */
  token?: string
  /** 过期/错误说明 */
  msg?: string
}

/**
 * 在令牌响应里深挖 token 字段（官网前端同样兼容 data / data.data 两层）。
 */
function digToken(data: unknown, depth = 0): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data) || depth > 3) return null
  const obj = data as Record<string, unknown>
  if (typeof obj.token === "string" && obj.token.length > 0) return obj.token
  return digToken(obj.data, depth + 1)
}

/** 会话是否已超过本地 TTL（超时直接判过期，不再无限等待源站） */
function sessionTimedOut(state: string): boolean {
  const t = sessions.get(state)
  return typeof t === "number" && Date.now() - t > QR_SESSION_TTL_MS
}

/**
 * 探测登录相关端点连通性。
 * 只要能拿到任意 HTTP 响应（含 4xx/5xx）即视为网络可达；
 * 仅在 DNS / TCP / TLS 全部失败（fetch 抛异常）时判定不可达。
 */
export async function probeLoginEndpoints(): Promise<LoginEndpointStatus> {
  const ping = async (url: string): Promise<boolean> => {
    try {
      await fetch(url, {
        headers: zfUpstreamHeaders(),
        redirect: "manual",
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      })
      return true
    } catch {
      return false
    }
  }
  const [wx, zf] = await Promise.all([ping("https://open.weixin.qq.com/"), ping(`${API_BASE}/`)])
  return { wx, zf }
}

/**
 * 服务端代为轮询扫码状态。
 * - 会话超过本地 TTL → 直接判过期（避免前端无限等待）
 * - status 200 + data 含 token → ok
 * - status 305 且 msg 为空 → pending（等待扫码）
 * - status 305 且 msg 非空 → expired（二维码过期/失效）
 * - 其他 → error
 */
export async function pollStateLogin(state: string): Promise<ZfPollResult> {
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(state)) {
    return { status: "error", msg: "state 参数不合法" }
  }
  if (sessionTimedOut(state)) {
    return { status: "expired", msg: "二维码已超时，请刷新后重新扫码" }
  }
  try {
    const res = await fetch(`${ZF_STATE_LOGIN_URL}?state=${encodeURIComponent(state)}`, {
      headers: zfUpstreamHeaders(),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    })
    const text = await res.text()
    try {
      const json = JSON.parse(text) as { status?: number; msg?: string; data?: unknown }
      const status = Number(json.status ?? -1)
      if (status === 200) {
        const token = digToken(json.data) ?? digToken(json)
        if (token) return { status: "ok", token }
        return { status: "pending" }
      }
      if (status === 305) {
        const msg = typeof json.msg === "string" ? json.msg.trim() : ""
        return msg ? { status: "expired", msg } : { status: "pending" }
      }
      return { status: "error", msg: json.msg || `源站响应异常（HTTP ${res.status}）` }
    } catch {
      return { status: "error", msg: text.slice(0, 120) || "源站响应异常" }
    }
  } catch (e) {
    return { status: "error", msg: e instanceof Error ? e.message : "网络异常" }
  }
}
