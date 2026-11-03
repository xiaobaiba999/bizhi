"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  ExternalLink,
  Globe,
  KeyRound,
  QrCode,
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

/** 二维码占位图案（确定性伪随机方块，模拟等待扫码态） */
function QrPlaceholder({ expired }: { expired: boolean }) {
  const cells = Array.from({ length: 49 }, (_, i) => {
    const v = Math.sin(i * 99.73) * 10000
    return (v - Math.floor(v)) > 0.52
  })
  return (
    <div className={cn("relative grid aspect-square w-full grid-cols-7 gap-1 p-4 transition-opacity", expired && "opacity-25")}>
      {cells.map((on, i) => (
        <span
          key={i}
          className={cn("rounded-[2px]", on ? "bg-neutral-900" : "bg-transparent")}
        />
      ))}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className={cn(
          "flex size-10 items-center justify-center rounded-full bg-white shadow-lg",
          expired ? "text-neutral-400" : "text-primary"
        )}>
          <span className={cn("size-5 rounded-full border-2 border-primary/30 border-t-primary", !expired && "animate-spin")} />
        </span>
      </span>
    </div>
  )
}

/**
 * 登录令牌设置（还原壁纸工坊 1.0.x 交互）：
 * 令牌用于从哲风壁纸下载原图（与官网分辨率、文件大小完全一致），仅保存在本地数据库。
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
  const [countdown, setCountdown] = useState(120)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/token", { cache: "no-store" })
      if (res.ok) setState(await res.json())
    } catch {
      /* 静默失败，保留当前展示 */
    }
  }, [])

  // 打开时拉取令牌状态并重置输入（微任务中执行，避免 effect 内同步 setState）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      void refresh()
      setMode("qrcode")
      setManualInput("")
      setCountdown(120)
    })
    return () => {
      cancelled = true
    }
  }, [open, refresh])

  // 二维码倒计时（每秒递减，到 0 停止）
  useEffect(() => {
    if (!open || mode !== "qrcode") return
    const t = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0))
    }, 1000)
    return () => clearInterval(t)
  }, [open, mode])

  // 令牌状态轮询（扫码确认后服务端会出现令牌）
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!open) {
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }
    pollRef.current = setInterval(() => void refresh(), 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [open, refresh])

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

  const expired = countdown <= 0
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
                <span className="ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  <Globe className="size-3" />
                  浏览器直连
                </span>
              </div>
              <p className="mt-1.5 pl-7 text-[11px] leading-relaxed text-muted-foreground">
                下载原图时由浏览器直连源站获取直链（令牌绑定了登录 IP）
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
              <div className="mx-auto max-w-[220px]">
                <QrPlaceholder expired={expired} />
              </div>
              <p className="text-center text-sm font-bold">{expired ? "二维码已过期" : "等待响应中～"}</p>
              <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" />
                请用微信扫一扫，并在手机上确认
                <span className="text-[10px]">（{mm}:{ss} 后过期）</span>
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
              {expired && (
                <div className="mt-3 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCountdown(120)}
                    className="h-7 text-xs"
                  >
                    刷新二维码
                  </Button>
                </div>
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
