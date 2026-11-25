/**
 * 哲风壁纸（haowallpaper.com）微信扫码登录 —— 服务端全托管实现
 *
 * 背景：微信开放平台二维码页面在跨域 iframe 中会显示
 * 「微信授权请求与发起浏览器不匹配」拒绝渲染（父页面域名不是 redirect_uri 域名）。
 * 因此改为服务端全托管：
 * 1. 服务端抓取微信 qrconnect 页面，提取 uuid 与二维码图片直链
 *    （https://open.weixin.qq.com/connect/qrcode/<uuid>，浏览器直显无 iframe）
 * 2. 服务端长轮询微信 lp 端点（/connect/l/qrconnect?uuid=...&last=...）：
 *    - 408 等待扫码（实测约 15 秒挂起后返回）/ 404 已扫码待确认 /
 *      405 已确认（返回 wx_code）/ 402 过期 / 403 用户取消
 *    ※ lp 请求的 Referer 必须是「完整的 qrconnect 页面 URL」（与真实微信 iframe
 *      内 JS 发起的请求完全一致），微信服务端可能据此校验会话一致性
 * 3. 用户在手机上确认后（405）服务端代替浏览器 GET 官网回调
 *    wxLogin?code=<wx_code>&state=<state>，让官网把登录令牌挂到 state 上
 * 4. 再轮询官网 stateLogin?state=... 拿到令牌，交由 API 路由存入本地数据库
 *
 * 手机扫码 → 微信确认 → lp 返回 405+code，全程无需任何浏览器上下文，天然免疫 iframe 限制。
 * 全链路各环节的失败原因都会写入会话诊断字段（diag），前端可展示精确定位。
 */

const API_BASE = "https://haowallpaper.com"

/** 哲风壁纸的微信开放平台 appid */
export const ZF_WX_APPID = "wx5b6879182de50dd6"

/** 官网微信登录回调地址（OAuth redirect_uri） */
export const ZF_WX_CALLBACK = "https://haowallpaper.com/link/app/appUser/wxLogin"

/** 扫码状态轮询接口 */
export const ZF_STATE_LOGIN_URL = `${API_BASE}/link/app/appUser/stateLogin`

/** 微信开放平台 qrconnect 页面 */
const WX_QRCONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect"

/** 微信长轮询端点（扫码状态） */
const WX_LP_URL = "https://lp.open.weixin.qq.com/connect/l/qrconnect"

/** 二维码会话本地过期时间（毫秒）：超过即直接判过期，不再依赖源站 */
export const QR_SESSION_TTL_MS = 180 * 1000

/** 登录相关端点连通性（用于提前给出明确错误，避免无意义的无限等待） */
export interface LoginEndpointStatus {
  /** 微信开放平台（二维码 / lp 轮询）是否可达 */
  wx: boolean
  /** 哲风壁纸登录服务是否可达 */
  zf: boolean
}

/**
 * 令牌获取原图直链接口。
 * 官网前端实测：必须带 __media=1&__responseCodec=aeg-v2 查询参数，
 * 否则一律返回 305 [错误的请求 -> 3004]（与令牌是否有效无关）。
 */
export function zfCompleteUrl(wtId: string): string {
  return `${API_BASE}/link/common/file/getCompleteUrl/${encodeURIComponent(wtId)}?__media=1&__responseCodec=aeg-v2`
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

/* ---------------- 扫码会话（进程内存） ---------------- */

export type QrPhase = "starting" | "waiting" | "scanned" | "ok" | "expired" | "error"

/** 全链路诊断信息（前端展示 / 排查「扫码没反应」用） */
export interface QrDiag {
  /** lp 长轮询已发送的请求数 */
  lpPolls: number
  /** lp 最近一次返回的微信 errcode（408 等待 / 404 已扫 / 405 已确认 / 402 过期…） */
  lpLastErrcode: number | null
  /** 官网 wxLogin 回调的 HTTP 状态码（尚未到达该环节为 null） */
  wxLoginStatus: number | null
  /** 官网 stateLogin 轮询次数 */
  statePolls: number
}

interface QrSessionObj {
  state: string
  /** 微信二维码 uuid（qrconnect 页面提取） */
  uuid: string | null
  /** 发起 qrconnect 时的完整页面 URL（lp 轮询 Referer 必须与真实 iframe 一致） */
  qrconnectUrl: string | null
  createdAt: number
  phase: QrPhase
  /** 登录成功后的令牌（由 API 路由读取并入库） */
  token?: string
  /** phase 具体说明 */
  msg?: string
  /** 令牌是否已入库（避免重复写） */
  tokenSaved?: boolean
  /** lp 连续异常计数 */
  lpFails: number
  /** 诊断信息 */
  diag: QrDiag
  /**
   * haowallpaper.com 域 Cookie（wxLogin 回调设置的粘性会话等）。
   * 官网前端在浏览器里发请求会自动携带；服务端全托管必须手动回放到
   * stateLogin 轮询，否则负载均衡可能把请求分到另一台后端，永远查不到令牌。
   */
  zfCookies: Map<string, string>
}

const sessions = new Map<string, QrSessionObj>()

/* ---------------- Cookie 回放（服务端全托管的关键） ---------------- */

/** 兼容各运行时的 set-cookie 读取（undici 有 getSetCookie，旧环境只有 get） */
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

/** 把响应里的 set-cookie 收进 jar（仅保留 name=value 对） */
function collectCookies(res: Response, jar: Map<string, string>): void {
  try {
    for (const raw of getSetCookieList(res.headers)) {
      const pair = (raw.split(";")[0] ?? "").trim()
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name && value) jar.set(name, value)
    }
  } catch {
    /* ignore */
  }
}

/** 拼接 Cookie 请求头（空 jar 返回 null） */
function cookieHeader(jar: Map<string, string>): string | null {
  if (jar.size === 0) return null
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

/** 二维码图片直链（uuid 就绪后可用） */
export function qrImageUrl(state: string): string | null {
  const s = sessions.get(state)
  return s?.uuid ? `https://open.weixin.qq.com/connect/qrcode/${s.uuid}` : null
}

/** 会话的 qrconnect 页面 URL（二维码图片代理的 Referer 用，与真实页面一致） */
export function qrRefererUrl(state: string): string | null {
  return sessions.get(state)?.qrconnectUrl ?? null
}

/** 生成随机 state（与官网一致的 uuid 形态）并登记会话 */
export function newState(): string {
  const state = crypto.randomUUID()
  sessions.set(state, {
    state,
    uuid: null,
    qrconnectUrl: null,
    createdAt: Date.now(),
    phase: "starting",
    lpFails: 0,
    diag: { lpPolls: 0, lpLastErrcode: null, wxLoginStatus: null, statePolls: 0 },
    zfCookies: new Map(),
  })
  // 顺手清理超过 10 分钟的旧会话，防止内存增长
  if (sessions.size > 32) {
    const now = Date.now()
    for (const [k, s] of sessions) {
      if (now - s.createdAt > 600_000) sessions.delete(k)
    }
  }
  return state
}

/* ---------------- ① 抓取 qrconnect 页面，提取 uuid 并启动后台轮询 ---------------- */

/** 从 qrconnect HTML 里挖 uuid（页面里以 window.uuid / 二维码图片 src 两种形态出现） */
function extractUuid(html: string): string | null {
  const m =
    html.match(/\/connect\/qrcode\/([0-9A-Za-z_-]{6,64})/) ??
    html.match(/window\.uuid\s*=\s*["']([0-9A-Za-z_-]{6,64})["']/)
  return m ? m[1] : null
}

/**
 * 发起扫码会话：
 * 抓取微信 qrconnect 页面（与官网登录参数一致）→ 提取 uuid → 启动后台 lp 轮询循环。
 * 返回二维码图片直链；失败抛错（API 路由转成明确错误信息）。
 */
export async function startQrSession(state: string): Promise<string> {
  const s = sessions.get(state)
  if (!s) throw new Error("会话不存在，请刷新重试")

  const params = new URLSearchParams({
    appid: ZF_WX_APPID,
    scope: "snsapi_login",
    redirect_uri: ZF_WX_CALLBACK,
    state,
    login_type: "jssdk",
    self_redirect: "true",
  })
  const pageUrl = `${WX_QRCONNECT_URL}?${params.toString()}`
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": UA,
      Referer: `${API_BASE}/`,
      Accept: "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`微信二维码页面获取失败（HTTP ${res.status}）`)

  const html = await res.text()
  const uuid = extractUuid(html)
  if (!uuid) throw new Error("微信二维码解析失败（页面结构可能已变化）")

  s.uuid = uuid
  s.qrconnectUrl = pageUrl // lp 轮询 / 图片代理的 Referer 基准
  s.phase = "waiting"
  // 后台轮询（不 await：独立循环，前端每 2 秒来查一次会话状态即可）
  void pollLoop(s)
  return `https://open.weixin.qq.com/connect/qrcode/${uuid}`
}

/* ---------------- ② 后台长轮询微信 lp 端点 ---------------- */

/** 解析 lp 响应：window.wx_errcode=405;window.wx_code='xxx'; */
function parseLp(text: string): { errcode: number; code: string } {
  const ec = text.match(/wx_errcode=(\d+)/)
  const code = text.match(/wx_code='([^']*)'/) ?? text.match(/wx_code="([^"]*)"/)
  return {
    errcode: ec ? Number(ec[1]) : -1,
    code: code ? code[1] : "",
  }
}

/**
 * 会话级后台轮询循环：
 * - 408 等待（微信服务端约 15 秒挂起后返回）/ 404 已扫码 / 403 用户取消（可重新扫）
 *   / 405 已确认（拿 code 换令牌）/ 402 过期
 * - 客户端超时 22 秒（> 服务端 15 秒挂起，网络抖动留 7 秒余量）
 * - 连续 5 次网络异常 → error（放宽阈值，慢网络下扫码状态也能感知）
 */
async function pollLoop(s: QrSessionObj): Promise<void> {
  let last = 400
  while (sessions.get(s.state) === s && Date.now() - s.createdAt < QR_SESSION_TTL_MS) {
    if (s.phase === "ok" || s.phase === "expired" || s.phase === "error") return
    try {
      const res = await fetch(`${WX_LP_URL}?uuid=${s.uuid}&last=${last}`, {
        headers: {
          "User-Agent": UA,
          // 关键：与真实微信 iframe 内 JS 完全一致 —— Referer 是完整 qrconnect 页面 URL
          Referer: s.qrconnectUrl ?? "https://open.weixin.qq.com/connect/qrconnect",
          Accept: "*/*",
        },
        // lp 为长轮询：微信服务端约 15 秒挂起；客户端超时留足余量
        signal: AbortSignal.timeout(22_000),
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { errcode, code } = parseLp(await res.text())
      s.lpFails = 0
      s.diag.lpPolls += 1
      s.diag.lpLastErrcode = errcode

      if (errcode === 405 && code) {
        // 已确认：拿 code 触发官网回调，把令牌挂到 state 上
        s.phase = "scanned"
        await finalizeLogin(s, code)
        return
      }
      if (errcode === 404) {
        s.phase = "scanned" // 已扫码，等待手机上点确认
        last = 404
        continue
      }
      if (errcode === 403) {
        // 用户在手机上点了取消：二维码仍可再次扫码，回到等待
        s.phase = "waiting"
        s.msg = "已取消授权，可重新扫码"
        last = 403
        continue
      }
      if (errcode === 402) {
        s.phase = "expired"
        s.msg = "二维码已过期，请刷新后重新扫码"
        return
      }
      if (errcode === 408) {
        last = 408
        if (s.phase === "scanned") s.phase = "waiting" // 确认超时回落
        continue
      }
      // 其他 errcode：计数容错
      s.lpFails += 1
      if (s.lpFails >= 5) {
        s.phase = "error"
        s.msg = `微信扫码状态异常（errcode=${errcode}），请刷新重试`
        return
      }
    } catch {
      // 网络异常 / 超时：800ms 后立刻重试（扫码事件保存在微信服务端，不会丢失）
      s.lpFails += 1
      if (s.lpFails >= 5) {
        s.phase = "error"
        s.msg = "与微信服务器的连接异常，请刷新重试"
        return
      }
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  if (sessions.get(s.state) === s && s.phase !== "ok") {
    s.phase = "expired"
    s.msg = "二维码已超时，请刷新后重新扫码"
  }
}

/* ---------------- ③ code → 官网回调 → 令牌 ---------------- */

/** 在令牌响应里深挖 token 字段（官网前端同样兼容 data / data.data 两层） */
function digToken(data: unknown, depth = 0): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data) || depth > 3) return null
  const obj = data as Record<string, unknown>
  if (typeof obj.token === "string" && obj.token.length > 0) return obj.token
  return digToken(obj.data, depth + 1)
}

/**
 * 用户已确认（拿到 wx_code）：
 * 1. 服务端 GET 官网回调 wxLogin?code=&state= —— 官网服务端用 code 换用户信息并把令牌挂到 state
 *    （与官网前端 XHR 行为一致：follow 重定向、带 Origin）
 * 2. 轮询 stateLogin 直到出现令牌（兜底：回调响应本身也可能带令牌）
 * 3. 每一步的失败原因都写入会话 msg（前端可见，精确定位「扫了没反应」卡在哪一环）
 */
async function finalizeLogin(s: QrSessionObj, wxCode: string): Promise<void> {
  const cbUrl = `${ZF_WX_CALLBACK}?code=${encodeURIComponent(wxCode)}&state=${encodeURIComponent(s.state)}`
  let token: string | null = null
  let cbNote = ""
  try {
    const res = await fetch(cbUrl, {
      headers: zfUpstreamHeaders({
        Origin: API_BASE,
        Accept: "application/json, text/plain, */*",
      }),
      redirect: "follow", // 与官网前端 XHR 一致（官网服务端可能 302 → JSON）
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    })
    s.diag.wxLoginStatus = res.status
    // 关键：回放官网设置的 Cookie（粘性负载均衡会话等）到后续 stateLogin 轮询，
    // 与真实浏览器行为一致 —— 否则轮询可能落到另一台后端，永远查不到令牌
    collectCookies(res, s.zfCookies)
    const text = await res.text()
    try {
      token = digToken(JSON.parse(text))
    } catch {
      /* HTML 响应：令牌挂在了 state 上，走 stateLogin 轮询 */
    }
    if (!token) cbNote = `官网回调返回 HTTP ${res.status}`
  } catch (e) {
    cbNote = `官网回调请求失败：${e instanceof Error ? e.message : "网络异常"}`
    // 回调失败：仍尝试 stateLogin（官网可能已处理完）
  }

  // 轮询官网 stateLogin（最多 ~20 秒），令牌由官网挂到 state 上
  for (let i = 0; i < 10 && !token; i++) {
    s.diag.statePolls = i + 1
    const r = await pollStateLoginDirect(s.state)
    if (r.status === "ok" && r.token) {
      token = r.token
      break
    }
    if (r.status === "expired" || r.status === "error") {
      cbNote = cbNote || (r.msg ?? "")
      break
    }
    await new Promise((r2) => setTimeout(r2, 2000))
  }

  if (token) {
    s.phase = "ok"
    s.token = token
    s.msg = undefined
  } else {
    s.phase = "error"
    s.msg =
      `授权已确认，但获取登录令牌失败（${cbNote || "官网未返回令牌"}）。` +
      "请刷新重试或改用手动粘贴"
  }
}

/** 直接调用官网 stateLogin（带上会话 Cookie，与浏览器行为一致） */
async function pollStateLoginDirect(state: string): Promise<{ status: "pending" | "ok" | "expired" | "error"; token?: string; msg?: string }> {
  const s = sessions.get(state)
  const cookies = s ? cookieHeader(s.zfCookies) : null
  try {
    const res = await fetch(`${ZF_STATE_LOGIN_URL}?state=${encodeURIComponent(state)}`, {
      headers: zfUpstreamHeaders({
        Origin: API_BASE,
        ...(cookies ? { Cookie: cookies } : {}),
      }),
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

/* ---------------- ④ 前端轮询入口：读会话状态 ---------------- */

export type ZfPollStatus = "pending" | "scanned" | "ok" | "expired" | "error"

export interface ZfPollResult {
  status: ZfPollStatus
  /** 登录成功时的令牌 */
  token?: string
  /** 已取消授权等过程提示 */
  msg?: string
  /** 令牌是否首次出现（API 路由据此入库） */
  tokenFresh?: boolean
  /** 全链路诊断（lp 轮询数 / 微信 errcode / 官网回调状态） */
  diag?: QrDiag
}

/** 前端轮询：返回会话当前状态（后台循环已在跑，这里只读） */
export function pollStateLogin(state: string): ZfPollResult {
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(state)) {
    return { status: "error", msg: "state 参数不合法" }
  }
  const s = sessions.get(state)
  if (!s) {
    return { status: "error", msg: "会话不存在或已失效，请刷新二维码" }
  }
  if (s.phase === "starting") return { status: "pending", diag: s.diag }
  if (s.phase === "waiting") return { status: "pending", msg: s.msg, diag: s.diag }
  if (s.phase === "scanned") return { status: "scanned", msg: s.msg, diag: s.diag }
  if (s.phase === "ok" && s.token) {
    return { status: "ok", token: s.token, tokenFresh: !s.tokenSaved, diag: s.diag }
  }
  if (s.phase === "expired") {
    return { status: "expired", msg: s.msg ?? "二维码已过期，请刷新后重新扫码", diag: s.diag }
  }
  return { status: "error", msg: s.msg ?? "登录状态异常，请刷新重试", diag: s.diag }
}

/** 标记令牌已入库（API 路由保存成功后调用） */
export function markTokenSaved(state: string): void {
  const s = sessions.get(state)
  if (s) s.tokenSaved = true
}

/* ---------------- 连通性预检 ---------------- */

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
