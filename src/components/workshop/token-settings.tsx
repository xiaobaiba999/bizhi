"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  ClipboardPaste,
  ExternalLink,
  KeyRound,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface TokenState {
  token: string | null
  source: string | null
  createdAt: string | null
}

interface QrSession {
  state: string
  /** 二维码图片直链（服务端从微信 qrconnect 页面提取，<img> 直显免 iframe 拦截） */
  qrImg: string | null
  /** 服务端连通性预检：微信开放平台 / 哲风壁纸是否可达 */
  wxReachable?: boolean
  zfReachable?: boolean
  /** 二维码会话创建失败的详细原因 */
  startError?: string
}

type QrPhase = "loading" | "waiting" | "scanned" | "ok" | "expired" | "error"

/** 令牌有效性验证状态（用官网接口实测，避免「令牌已失效却显示有效」） */
type VerifyState = "idle" | "checking" | "valid" | "invalid" | "unknown"

const QR_TTL = 170
/** 二维码图片加载超时：超时判定「二维码显示失败」，不再停留在等待页 */
const QR_LOAD_TIMEOUT = 12000
/** 轮询连续失败阈值：达到即停止并报错（约 6 秒内给出明确反馈，杜绝无限等待） */
const POLL_FAIL_LIMIT = 3

/**
 * 登录令牌设置：
 * - 扫码登录：直显服务端提取的「微信开放平台扫码二维码」图片（免 iframe 跨域拦截），
 *   状态区分「等待扫码 → 已扫码待确认 → 成功」，扫码确认后令牌自动入库
 * - 手动粘贴：从官网浏览器开发者工具复制令牌
 * 令牌用于下载原图（与官网分辨率、文件大小完全一致），仅保存在本地数据库。
 *
 * 扫码等待体验优化（避免「登录不上一直等待」）：
 * - 发起时服务端预检微信 / 哲风连通性，不可达直接报错并给手动粘贴兜底
 * - 二维码图片 12 秒未加载出来 → 判定加载失败
 * - 轮询连续 3 次失败 → 停止轮询并报错
 * - 倒计时归零 → 本地立即判过期（不等源站）
 * - 等待期间随时可刷新二维码 / 切换手动粘贴
 */
export function TokenSettingsDialog({
  open,
  onOpenChange,
  probeWtId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 用于验证令牌有效性的壁纸 id（当前列表任一张，官网接口需要） */
  probeWtId?: string | null
}) {
  const [state, setState] = useState<TokenState>({ token: null, source: null, createdAt: null })
  const [mode, setMode] = useState<"qrcode" | "manual">("qrcode")
  const [manualInput, setManualInput] = useState("")
  const [saving, setSaving] = useState(false)
  /** 令牌有效性（官网实测）：checking / valid / invalid / unknown */
  const [verify, setVerify] = useState<VerifyState>("idle")
  /** 失效原因（invalid 时展示） */
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)

  // 扫码会话
  const [qr, setQr] = useState<QrSession | null>(null)
  const [phase, setPhase] = useState<QrPhase>("loading")
  /** 具体失败原因（error 阶段展示） */
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(QR_TTL)
  const [qrNonce, setQrNonce] = useState(0)
  /** 已扫码阶段的服务端过程提示（如「授权已确认，正在获取令牌」） */
  const [scannedNote, setScannedNote] = useState<string | null>(null)
  /** 二维码 iframe 是否已触发 load 事件 */
  const qrLoadedRef = useRef(false)
  /** 轮询连续失败计数 */
  const pollFailRef = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/token", { cache: "no-store" })
      if (res.ok) setState(await res.json())
    } catch {
      /* 静默失败，保留当前展示 */
    }
  }, [])

  // 验证令牌有效性：弹窗打开 / 令牌变化（重新扫码入库后）时，用官网接口实测一次
  const runVerify = useCallback(async (wtId: string) => {
    setVerify("checking")
    setVerifyMsg(null)
    try {
      const res = await fetch(`/api/token/verify?wtId=${encodeURIComponent(wtId)}`, {
        cache: "no-store",
      })
      const data = (await res.json().catch(() => null)) as { valid?: boolean | null; msg?: string } | null
      if (data?.valid === true) setVerify("valid")
      else if (data?.valid === false) {
        setVerify("invalid")
        setVerifyMsg(typeof data.msg === "string" ? data.msg : null)
      } else setVerify("unknown")
    } catch {
      setVerify("unknown")
    }
  }, [])

  useEffect(() => {
    if (!open || !state.token || !probeWtId) return
    let cancelled = false
    // 微任务中执行，避免 effect 内同步 setState
    Promise.resolve().then(() => {
      if (cancelled) return
      void runVerify(probeWtId)
    })
    return () => {
      cancelled = true
    }
  }, [open, state.token, probeWtId, runVerify])

  // 打开时重置 + 拉取令牌状态（微任务中执行，避免 effect 内同步 setState）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      void refresh()
      setMode("qrcode")
      setManualInput("")
      setQr(null)
      setPhase("loading")
      setErrorMsg(null)
      setScannedNote(null)
      setCountdown(QR_TTL)
      setVerify("idle")
      setVerifyMsg(null)
      qrLoadedRef.current = false
      pollFailRef.current = 0
    })
    return () => {
      cancelled = true
    }
  }, [open, refresh])

  // 发起扫码会话（打开弹窗 / 点击刷新时；微任务中执行，避免 effect 内同步 setState）
  useEffect(() => {
    if (!open || mode !== "qrcode") return
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      setPhase("loading")
      setCountdown(QR_TTL)
      setErrorMsg(null)
      setScannedNote(null)
      qrLoadedRef.current = false
      pollFailRef.current = 0
      void (async () => {
        try {
          const res = await fetch("/api/zf-login", { method: "POST" })
          if (!res.ok) throw new Error()
          const data: QrSession = await res.json()
          if (cancelled) return
          // 连通性预检：不可达时直接给出明确错误（不进入无限等待）
          if (data.wxReachable === false) {
            setQr(null)
            setPhase("error")
            setErrorMsg(
              data.zfReachable === false
                ? "无法访问微信开放平台与哲风壁纸服务，请检查网络后重试"
                : "无法访问微信开放平台（open.weixin.qq.com），二维码显示不出来"
            )
            return
          }
          if (data.zfReachable === false) {
            setQr(null)
            setPhase("error")
            setErrorMsg("无法访问哲风壁纸登录服务（haowallpaper.com），扫码后也拿不到令牌")
            return
          }
          if (!data.qrImg) {
            // 服务端提取二维码失败（qrconnect 页面抓取/解析失败）
            setQr(null)
            setPhase("error")
            setErrorMsg(data.startError ?? "二维码会话创建失败，请刷新重试或改用手动粘贴")
            return
          }
          setQr(data)
          setPhase("waiting")
        } catch {
          if (!cancelled) {
            setQr(null)
            setPhase("error")
            setErrorMsg("二维码会话创建失败，请检查网络后重试")
          }
        }
      })()
    })
    return () => {
      cancelled = true
    }
  }, [open, mode, qrNonce])

  // 倒计时（waiting 与 scanned 阶段都计时）
  useEffect(() => {
    if (!open || mode !== "qrcode" || (phase !== "waiting" && phase !== "scanned")) return
    const t = setInterval(() => setCountdown((c) => (c > 0 ? c - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [open, mode, phase])

  // 倒计时归零 → 本地立即判过期并停止轮询（不等源站，杜绝无限等待）
  useEffect(() => {
    if (!open || mode !== "qrcode" || (phase !== "waiting" && phase !== "scanned") || countdown > 0)
      return
    Promise.resolve().then(() => {
      setPhase("expired")
    })
  }, [open, mode, phase, countdown])

  // 二维码图片加载超时检测：超时判定加载失败（而不是一直「等待扫码」）
  useEffect(() => {
    if (!open || mode !== "qrcode" || (phase !== "waiting" && phase !== "scanned") || !qr) return
    const t = setTimeout(() => {
      if (!qrLoadedRef.current) {
        setPhase("error")
        setErrorMsg("二维码图片加载超时，请刷新重试或改用手动粘贴")
      }
    }, QR_LOAD_TIMEOUT)
    return () => clearTimeout(t)
  }, [open, mode, phase, qr])

  // 轮询扫码状态（服务端后台已在长轮询微信，这里每 2 秒查一次会话状态）
  useEffect(() => {
    if (!open || mode !== "qrcode" || (phase !== "waiting" && phase !== "scanned") || !qr) return
    let stopped = false
    const timer = setInterval(
      () => {
        if (stopped) return
        void (async () => {
          try {
            const res = await fetch(`/api/zf-login?state=${encodeURIComponent(qr.state)}`, {
              cache: "no-store",
            })
            const data = await res.json().catch(() => null)
            if (stopped || !data) return
            if (data.status === "ok") {
              stopped = true
              pollFailRef.current = 0
              setPhase("ok")
              toast.success("扫码登录成功，令牌已自动保存")
              void refresh()
            } else if (data.status === "scanned") {
              // 已扫码（或已确认授权，服务端正在换取令牌）
              pollFailRef.current = 0
              setPhase("scanned")
              if (typeof data.msg === "string" && data.msg) setScannedNote(data.msg)
            } else if (data.status === "expired") {
              stopped = true
              setPhase("expired")
            } else if (data.status === "pending") {
              pollFailRef.current = 0
              // 从「已扫码」回落（用户取消授权等）
              setPhase("waiting")
            } else {
              // error → 计数；连续多次失败才停止（单次抖动继续轮询）
              pollFailRef.current += 1
              if (pollFailRef.current >= POLL_FAIL_LIMIT) {
                stopped = true
                setPhase("error")
                setErrorMsg(
                  typeof data.msg === "string" && data.msg
                    ? `登录状态查询失败：${data.msg}`
                    : "登录状态查询连续失败，请检查网络后重试"
                )
              }
            }
          } catch {
            pollFailRef.current += 1
            if (!stopped && pollFailRef.current >= POLL_FAIL_LIMIT) {
              stopped = true
              setPhase("error")
              setErrorMsg("网络异常，无法查询扫码状态，请检查网络后重试")
            }
          }
        })()
      },
      2000
    )
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [open, mode, phase, qr, refresh])

  const regenQr = () => {
    setQrNonce((n) => n + 1)
  }

  const saveToken = async (token: string, source: "manual" | "qrcode") => {
    setSaving(true)
    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, source }),
      })
      const msg = await res.json().catch(() => null)
      if (!res.ok) throw new Error(msg?.error ?? "保存失败")
      setState(msg)
      toast.success("令牌已保存，下载原图功能已就绪")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存令牌失败")
    } finally {
      setSaving(false)
    }
  }

  const deleteToken = async () => {
    try {
      const res = await fetch("/api/token", { method: "DELETE" })
      if (!res.ok) throw new Error()
      setState({ token: null, source: null, createdAt: null })
      toast.success("令牌已删除")
    } catch {
      toast.error("删除令牌失败")
    }
  }

  const mm = Math.floor(countdown / 60)
  const ss = String(countdown % 60).padStart(2, "0")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="space-y-1.5 border-b bg-muted/40 px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <KeyRound className="size-4 text-primary" />
            登录令牌设置
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            下载原图（与官网分辨率、文件大小完全一致）需要网站的登录令牌。推荐直接
            <span className="font-semibold text-foreground">微信扫码登录</span>
            自动获取，令牌仅保存在<span className="font-semibold text-foreground">本地数据库</span>。
          </DialogDescription>
        </DialogHeader>

        <div className="custom-scrollbar max-h-[calc(100vh-7rem)] overflow-y-auto p-5">
          {/* 令牌状态卡（官网实测有效性，不再凭「入库了」就显示有效） */}
          {state.token ? (
            <div
              className={cn(
                "mb-4 rounded-xl border p-3.5",
                verify === "invalid" ? "border-amber-500/40 bg-amber-500/5" : "bg-muted/40"
              )}
            >
              <div className="flex items-center gap-2">
                {verify === "invalid" ? (
                  <ShieldX className="size-5 shrink-0 text-amber-500" />
                ) : (
                  <ShieldCheck
                    className={cn("size-5 shrink-0", verify === "valid" ? "text-emerald-500" : "text-muted-foreground")}
                  />
                )}
                <span className="text-sm font-bold">
                  {verify === "invalid" ? "令牌已失效" : "令牌有效"}
                  {verify === "checking" && " · 验证中…"}
                  {verify === "valid" && " · 已验证"}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {state.token}
                </span>
                {state.source === "qrcode" && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                    扫码登录
                  </span>
                )}
                {verify === "checking" && (
                  <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="mt-1.5 pl-7 text-[11px] leading-relaxed text-muted-foreground">
                {verify === "invalid"
                  ? "下载原图已退回预览质量（约 1100px）。请重新扫码登录获取新令牌，即刻恢复高清原图。"
                  : "下载原图时自动使用令牌获取与官网完全一致的原图"}
              </p>
              {verify === "invalid" && verifyMsg && (
                <p className="mt-1 pl-7 font-mono text-[10px] text-muted-foreground/70">（{verifyMsg}）</p>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-7">
                {verify === "invalid" && (
                  <button
                    type="button"
                    onClick={() => setMode("qrcode")}
                    className="inline-flex h-7 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-bold text-primary-foreground transition-all hover:brightness-105"
                  >
                    <QrCode className="size-3" />
                    重新扫码获取
                  </button>
                )}
                {verify === "unknown" && probeWtId && (
                  <button
                    type="button"
                    onClick={() => void runVerify(probeWtId)}
                    className="inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    <RefreshCw className="size-3" />
                    重新验证
                  </button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void deleteToken()}
                  className="h-7 gap-1 border-destructive/40 px-2.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                  删除
                </Button>
              </div>
            </div>
          ) : (
            <div className="mb-4 rounded-xl border border-dashed px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <KeyRound className="size-3.5 shrink-0" />
                <span className="truncate">暂无令牌 —— 当前下载为预览质量（约 1100px）</span>
              </div>
            </div>
          )}

          {/* 登录方式切换 */}
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-full bg-muted p-1" role="tablist" aria-label="令牌获取方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "qrcode"}
              onClick={() => setMode("qrcode")}
              className={cn(
                "relative inline-flex h-8 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition-all",
                mode === "qrcode" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <QrCode className="size-3.5" />
              扫码登录
              <span className="rounded-full bg-primary px-1 py-px text-[9px] font-bold text-primary-foreground">推荐</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "manual"}
              onClick={() => setMode("manual")}
              className={cn(
                "inline-flex h-8 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition-all",
                mode === "manual" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ClipboardPaste className="size-3.5" />
              手动粘贴
            </button>
          </div>

          {mode === "qrcode" ? (
            <div className="rounded-2xl border p-4">
              {/* 真实微信开放平台扫码二维码（与哲风壁纸官网登录参数一致） */}
              {phase === "ok" ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <span className="flex size-16 items-center justify-center rounded-full bg-primary/10">
                    <ShieldCheck className="size-8 text-primary" />
                  </span>
                  <p className="text-sm font-bold">扫码登录成功</p>
                  <p className="text-xs text-muted-foreground">令牌已自动保存，下载原图已解锁高清原图</p>
                </div>
              ) : phase === "loading" ? (
                <div className="mx-auto flex size-[252px] items-center justify-center rounded-2xl bg-muted/50">
                  <span className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                </div>
              ) : phase === "error" ? (
                /* 明确报错 + 兜底入口：不再停留在「等待扫码」无限转圈 */
                <div className="flex flex-col items-center gap-3 py-8">
                  <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
                    <TriangleAlert className="size-7 text-destructive" />
                  </span>
                  <p className="text-sm font-bold text-destructive">扫码登录暂时不可用</p>
                  {errorMsg && (
                    <p className="max-w-[17rem] text-center text-xs leading-relaxed text-muted-foreground">
                      {errorMsg}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={regenQr} className="h-8 text-xs">
                      <RefreshCw className="size-3.5" />
                      刷新重试
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setMode("manual")} className="h-8 text-xs">
                      <ClipboardPaste className="size-3.5" />
                      手动粘贴令牌
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="relative mx-auto w-fit">
                  {/* 微信二维码图片直显（服务端提取直链，经本站代理防热链拦截） */}
                  <div
                    className={cn(
                      "relative overflow-hidden rounded-2xl border bg-white p-2.5 transition-opacity",
                      phase === "expired" && "opacity-25"
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      key={qr?.state ?? "qr"}
                      src={qr ? `/api/zf-login/qr?state=${encodeURIComponent(qr.state)}` : undefined}
                      alt="微信扫码登录二维码"
                      width={230}
                      height={230}
                      decoding="async"
                      onLoad={() => {
                        qrLoadedRef.current = true
                      }}
                      onError={() => {
                        setPhase("error")
                        setErrorMsg("二维码图片加载失败，请刷新重试或改用手动粘贴")
                      }}
                      className="block size-[230px] bg-white object-contain"
                    />
                    {/* 已扫码：二维码变暗 + 等待确认提示 */}
                    {phase === "scanned" && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-white/85 backdrop-blur-[2px]">
                        <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/15">
                          <QrCode className="size-6 text-emerald-600" />
                        </span>
                        <p className="text-sm font-bold text-emerald-700">扫码成功</p>
                        <p className="text-xs text-muted-foreground">{scannedNote ?? "请在手机上点击「确认登录」"}</p>
                      </div>
                    )}
                  </div>
                  {/* 等待期间随时可刷新二维码（不必等到过期） */}
                  {(phase === "waiting" || phase === "scanned") && (
                    <button
                      type="button"
                      onClick={regenQr}
                      aria-label="刷新二维码"
                      title="刷新二维码"
                      className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-transform hover:scale-110"
                    >
                      <RefreshCw className="size-3.5" />
                    </button>
                  )}
                  {phase === "expired" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-background/60 backdrop-blur-[2px]">
                      <p className="text-sm font-bold">二维码已过期</p>
                      <Button variant="outline" size="sm" onClick={regenQr} className="h-8 text-xs">
                        <RefreshCw className="size-3.5" />
                        刷新二维码
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {phase !== "ok" && phase !== "error" && (
                <>
                  <p className="mt-3 text-center text-sm font-bold">
                    {phase === "loading"
                      ? "二维码生成中…"
                      : phase === "expired"
                        ? "二维码已过期"
                        : phase === "scanned"
                          ? "已扫码，等待手机确认"
                          : "等待扫码中～"}
                  </p>
                  <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        "size-1.5 animate-pulse rounded-full",
                        phase === "scanned" ? "bg-emerald-500" : "bg-primary"
                      )}
                    />
                    {phase === "scanned" ? scannedNote ?? "已扫码，正在等待确认结果…" : "请用微信扫一扫，并在手机上确认"}
                    {(phase === "waiting" || phase === "scanned") && countdown > 0 && (
                      <span className="text-[10px]">（{mm}:{ss} 后过期）</span>
                    )}
                  </p>
                  {/* 卡住兜底：随时刷新 / 切换手动粘贴 */}
                  {(phase === "waiting" || phase === "scanned") && (
                    <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                      长时间没反应？
                      <button
                        type="button"
                        onClick={regenQr}
                        className="mx-0.5 font-semibold text-foreground underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                      >
                        刷新二维码
                      </button>
                      或
                      <button
                        type="button"
                        onClick={() => setMode("manual")}
                        className="mx-0.5 font-semibold text-foreground underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                      >
                        手动粘贴令牌
                      </button>
                    </p>
                  )}
                  <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                    扫码即代表同意
                    <a
                      href="https://haowallpaper.com"
                      target="_blank"
                      rel="noreferrer"
                      className="mx-0.5 inline-flex items-center gap-0.5 font-semibold text-foreground underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                    >
                      haowallpaper.com
                      <ExternalLink className="size-2.5" />
                    </a>
                    的微信授权登录
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                在哲风壁纸官网登录后，从浏览器开发者工具（F12 → Application → Cookies）复制令牌内容粘贴到下方：
              </p>
              <textarea
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="粘贴以 haowallpaper_token= 或 eyJ 开头的令牌串…"
                rows={4}
                className="custom-scrollbar mt-3 w-full resize-none rounded-xl border bg-background p-3 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50"
              />
              <Button
                disabled={saving || manualInput.trim().length < 8}
                onClick={() => void saveToken(manualInput.trim(), "manual")}
                className="mt-3 h-9 w-full text-xs font-bold"
              >
                {saving ? "保存中…" : "保存令牌"}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
