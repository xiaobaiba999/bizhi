/**
 * 一次性诊断脚本：直测哲风壁纸官网 getCompleteUrl 链路
 * 1. ALTCHA certify（challenge → PoW → verify）拿 server_session cookie
 * 2. 无令牌 / 假令牌分别探测 getCompleteUrl，观察官网返回（401 vs 3004）
 * → 验证「令牌失效」判定逻辑（invalid 仅在 401/未授权时报）
 */
import { createHash } from "node:crypto"

const API_BASE = "https://haowallpaper.com"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

function getSetCookieList(headers) {
  const h = headers
  if (typeof h.getSetCookie === "function") {
    try { return h.getSetCookie() } catch { return [] }
  }
  const single = headers.get("set-cookie")
  return single ? [single] : []
}

function collectSessionCookie(res) {
  for (const raw of getSetCookieList(res.headers)) {
    const pair = (raw.split(";")[0] ?? "").trim()
    if (pair.startsWith("server_session_")) return pair
  }
  return null
}

function solve(challenge) {
  for (let n = 0; n <= challenge.maxnumber; n++) {
    const hash = createHash("sha256").update(challenge.salt + n).digest("hex")
    if (hash === challenge.challenge) return n
  }
  return null
}

// 用一个真实存在的 wtId（从 dev.log 中拿到的）
const WTID = process.argv[2] || "19927393742902848"

console.log("=== ① certify/challenge ===")
const chalRes = await fetch(`${API_BASE}/link/pc/certify/challenge`, {
  headers: { "User-Agent": UA, Referer: `${API_BASE}/`, Accept: "application/json" },
  signal: AbortSignal.timeout(15000),
})
console.log("HTTP", chalRes.status)
const cookie = collectSessionCookie(chalRes) ?? ""
console.log("cookie:", cookie.slice(0, 40) + "…")
const challenge = await chalRes.json()
console.log("challenge keys:", Object.keys(challenge).join(","), "maxnumber:", challenge.maxnumber)

console.log("\n=== ② PoW + verify ===")
const t0 = Date.now()
const number = solve(challenge)
console.log("PoW number:", number, `(${Date.now() - t0}ms)`)
const payload = Buffer.from(
  JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number,
    salt: challenge.salt,
    signature: challenge.signature,
  })
).toString("base64")
const verifyRes = await fetch(`${API_BASE}/link/pc/certify/verify?__media=1&__responseCodec=aeg-v2`, {
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
})
const refreshed = collectSessionCookie(verifyRes)
const finalCookie = refreshed ?? cookie
const vjson = await verifyRes.json().catch(() => null)
console.log("HTTP", verifyRes.status, "json:", JSON.stringify(vjson))
console.log("final cookie:", finalCookie.slice(0, 40) + "…")

async function probe(label, extraHeaders) {
  const res = await fetch(
    `${API_BASE}/link/common/file/getCompleteUrl/${WTID}?__media=1&__responseCodec=aeg-v2`,
    {
      headers: {
        "User-Agent": UA,
        Referer: `${API_BASE}/`,
        Accept: "application/json, text/plain, */*",
        ...(finalCookie ? { Cookie: finalCookie } : {}),
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(10000),
    }
  )
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  const url = json ? JSON.stringify(json).match(/https?:\\?\/\\?\/[^"']+/)?.[0] : null
  console.log(`\n[${label}] HTTP ${res.status} → ${text.slice(0, 220)}`)
  return { res, json }
}

console.log(`\n=== ③ getCompleteUrl 三种探测（wtId=${WTID}）===`)
await probe("无令牌", {})
await probe("假令牌(token header)", { token: "eyJhbGciOiJIUzI1NiJ9.fake.sig" })
await probe("假令牌(haowallpaper_token cookie)", {
  Cookie: `${finalCookie}; haowallpaper_token=eyJhbGciOiJIUzI1NiJ9.fake.sig`,
})
console.log("\n=== done ===")
