"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import {
  ExternalLink,
  KeyRound,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Trash2,
  ClipboardPaste,
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
  qrUrl: string
}

type QrPhase = "loading" | "waiting" | "ok" | "expired" | "error"

const QR_TTL = 120

/**
 * 登录令牌设置：
 * - 扫码登录：内嵌哲风壁纸同款「微信开放平台扫码二维码」，扫码确认后令牌自动入库
 * - 手动粘贴：从官网浏览器开发者工具复制令牌
 * 令牌用于下载原图（与官网分辨率、文件大小完全一致），仅保存在本地数据库。
 */
export function TokenSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<TokenState>({ token: null, source: null, createdAt: null })
  const [mode, setMode] = useState<"qrcode" | "manual">("qrcode")
  const [manualInput, setManualInput] = useState("")
  const [saving, setSaving] = useState(false)

  // 扫码会话
  const [qr, setQr] = useState<QrSession | null>(null)
  const [phase, setPhase] = useState<QrPhase>("loading")
  const [countdown, setCountdown] = useState(QR_TTL)
  const [qrNonce, setQrNonce] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/token", { cache: "no-store" })
      if (res.ok) setState(await res.json())
    } catch {
      /* 静默失败，保留当前展示 */
    }
  }, [])

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
      setCountdown(QR_TTL)
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
      void (async () => {
        try {
          const res = await fetch("/api/zf-login", { method: "POST" })
          if (!res.ok) throw new Error()
          const data: QrSession = await res.json()
          if (cancelled) return
          setQr(data)
          setPhase("waiting")
        } catch {
          if (!cancelled) setPhase("error")
        }
      })()
    })
    return () => {
      cancelled = true
    }
  }, [open, mode, qrNonce])

  // 倒计时
  useEffect(() => {
    if (!open || mode !== "qrcode" || phase !== "waiting") return
    const t = setInterval(() => setCountdown((c) => (c > 0 ? c - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [open, mode, phase])

  // 轮询扫码状态（服务端代查哲风接口）
  useEffect(() => {
    if (!open || mode !== "qrcode" || phase !== "waiting" || !qr) return
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
              setPhase("ok")
              toast.success("扫码登录成功，令牌已自动保存")
              void refresh()
            } else if (data.status === "expired") {
              stopped = true
              setPhase("expired")
            }
            // pending / error → 继续轮询
          } catch {
            /* 网络抖动继续轮询 */
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

  const expired = countdown <= 0 && phase === "waiting"
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

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {/* 令牌状态卡 */}
          {state.token ? (
            <div className="mb-4 rounded-xl border bg-muted/40 p-3.5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-5 shrink-0 text-emerald-500" />
                <span className="text-sm font-bold">令牌有效</span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {state.token}
                </span>
                {state.source === "qrcode" && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                    扫码登录
                  </span>
                )}
              </div>
              <p className="mt-1.5 pl-7 text-[11px] leading-relaxed text-muted-foreground">
                下载原图时自动使用令牌获取与官网完全一致的原图
              </p>
              <div className="mt-2.5 pl-7">
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
            <div className="mb-4 rounded-xl border border-dashed p-3.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <KeyRound className="size-4" />
                暂无令牌 —— 当前下载原图为官网预览质量（约 1100px）
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
                <div className="flex aspect-square w-full max-w-[220px] items-center justify-center rounded-2xl bg-muted/50">
                  <span className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                </div>
              ) : phase === "error" ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <p className="text-sm font-semibold text-destructive">二维码生成失败</p>
                  <Button variant="outline" size="sm" onClick={regenQr} className="h-8 text-xs">
                    <RefreshCw className="size-3.5" />
                    重新生成
                  </Button>
                </div>
              ) : (
                <div className="relative mx-auto max-w-[220px]">
                  <div
                    className={cn(
                      "overflow-hidden rounded-2xl border-4 border-neutral-100 bg-white transition-opacity",
                      (expired || phase === "expired") && "opacity-25"
                    )}
                  >
                    <iframe
                      key={qr?.state ?? "qr"}
                      src={qr?.qrUrl ?? "about:blank"}
                      title="哲风壁纸微信扫码登录二维码"
                      width="220"
                      height="220"
                      scrolling="no"
                      frameBorder={0}
                      className="block h-[220px] w-full"
                    />
                  </div>
                  {(expired || phase === "expired") && (
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
                    {phase === "loading" ? "二维码生成中…" : expired || phase === "expired" ? "二维码已过期" : "等待扫码中～"}
                  </p>
                  <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-primary" />
                    请用微信扫一扫，并在手机上确认
                    {phase === "waiting" && !expired && (
                      <span className="text-[10px]">（{mm}:{ss} 后过期）</span>
                    )}
                  </p>
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
