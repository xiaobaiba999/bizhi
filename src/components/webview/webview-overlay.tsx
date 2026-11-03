"use client"

import { useEffect, useState } from "react"
import { ArrowLeft, Cloud, ExternalLink, RefreshCw, Send } from "lucide-react"
import { useAppStore, type WebviewKind } from "@/lib/app-store"
import { StagingShelf } from "@/components/webview/staging-shelf"
import { cn } from "@/lib/utils"

/** 内嵌原网页视图配置：均经 /wv 本地反向代理（登录态保存在本机会话，扫码不受第三方 Cookie 限制） */
const VIEWS: Record<
  WebviewKind,
  { title: string; host: string; src: string; external: string; icon: React.ReactNode }
> = {
  xhs: {
    title: "小红书创作者中心",
    host: "creator.xiaohongshu.com",
    src: "/wv/creator.xiaohongshu.com/publish/publish",
    external: "https://creator.xiaohongshu.com/publish/publish",
    icon: <Send className="size-4" />,
  },
  quark: {
    title: "夸克网盘",
    host: "pan.quark.cn",
    src: "/wv/pan.quark.cn",
    external: "https://pan.quark.cn/",
    icon: <Cloud className="size-4" />,
  },
}

type Nonce = Record<WebviewKind, number>

/**
 * 全屏内嵌网页视图（直接接管整个软件页面）：
 * - 小红书创作者中心 / 夸克网盘原网页铺满整个视口，无小窗口、无内嵌滚动条
 * - iframe 懒挂载且常驻（关闭再打开不丢登录态 / 页面状态）
 * - 登录态走本地代理会话（wv_sid），刷新 / 重开无需重复扫码
 */
export function WebviewOverlay() {
  const webview = useAppStore((s) => s.webview)
  const closeWebview = useAppStore((s) => s.closeWebview)

  // 懒挂载 + 常驻：首次打开才加载，之后隐藏保留状态
  const [mounted, setMounted] = useState<Record<WebviewKind, boolean>>({
    xhs: false,
    quark: false,
  })
  const [loading, setLoading] = useState<Record<WebviewKind, boolean>>({
    xhs: true,
    quark: true,
  })
  const [nonce, setNonce] = useState<Nonce>({ xhs: 0, quark: 0 })

  useEffect(() => {
    if (!webview) return
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      setMounted((prev) => (prev[webview] ? prev : { ...prev, [webview]: true }))
    })
    return () => {
      cancelled = true
    }
  }, [webview])

  if (!mounted.xhs && !mounted.quark) return null

  const active = webview ? VIEWS[webview] : null

  const refresh = (kind: WebviewKind) => {
    setLoading((prev) => ({ ...prev, [kind]: true }))
    setNonce((prev) => ({ ...prev, [kind]: prev[kind] + 1 }))
  }

  return (
    <div
      aria-hidden={!webview}
      className={cn(
        "fixed inset-0 z-50 flex-col bg-background",
        webview ? "flex" : "hidden"
      )}
    >
      {/* 接管视图顶栏：返回工坊 / 站点信息 / 刷新 / 新窗口 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur sm:gap-2.5 sm:px-3">
        <button
          type="button"
          onClick={closeWebview}
          disabled={!webview}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-bold text-primary-foreground shadow-md shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95 sm:px-3.5 sm:text-sm"
        >
          <ArrowLeft className="size-4" />
          返回工坊
        </button>

        {active && (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <span className="flex size-2 shrink-0">
              <span className="absolute inline-flex size-2 animate-ping rounded-full bg-emerald-400/70" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-bold sm:text-sm">
              <span className="shrink-0 text-primary">{active.icon}</span>
              <span className="truncate">
                {active.title}
                <span className="ml-1.5 hidden font-mono text-[10px] font-medium text-muted-foreground sm:inline">
                  {active.host}
                </span>
              </span>
            </span>
          </div>
        )}

        {webview && active && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="刷新内嵌页面"
              onClick={() => refresh(webview)}
              className="inline-flex h-9 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground sm:px-3 sm:text-xs"
            >
              <RefreshCw className={cn("size-3.5", loading[webview] && "animate-spin")} />
              <span className="hidden sm:inline">刷新</span>
            </button>
            <a
              href={active.external}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground sm:px-3 sm:text-xs"
            >
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">新窗口</span>
            </a>
          </div>
        )}
      </header>

      {/* 内嵌原网页：铺满剩余全部视口 */}
      <div className="relative min-h-0 flex-1">
        {mounted.xhs && (
          <div className={cn("absolute inset-0", webview !== "xhs" && "hidden")}>
            {loading.xhs && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
                <span className="size-9 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                <p className="text-xs text-muted-foreground">正在载入小红书创作者中心…</p>
              </div>
            )}
            <iframe
              key={`xhs-${nonce.xhs}`}
              src={VIEWS.xhs.src}
              title="小红书创作者中心（全屏内嵌）"
              onLoad={() => setLoading((prev) => ({ ...prev, xhs: false }))}
              allow="clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-full w-full border-0 bg-white"
            />
          </div>
        )}

        {mounted.quark && (
          <div className={cn("absolute inset-0", webview !== "quark" && "hidden")}>
            {loading.quark && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
                <span className="size-9 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                <p className="text-xs text-muted-foreground">正在载入夸克网盘…</p>
              </div>
            )}
            <iframe
              key={`quark-${nonce.quark}`}
              src={VIEWS.quark.src}
              title="夸克网盘（全屏内嵌）"
              onLoad={() => setLoading((prev) => ({ ...prev, quark: false }))}
              allow="clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-full w-full border-0 bg-white"
            />
          </div>
        )}

        {/* 小红书暂存架：来自壁纸工坊的选图，浮于页面底部可折叠 */}
        {webview === "xhs" && <StagingShelf />}
      </div>
    </div>
  )
}
