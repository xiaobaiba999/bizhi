"use client"

import { useEffect, useRef, useState } from "react"
import { ExternalLink, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"

interface WebEmbedProps {
  /** iframe 加载地址（跨站直连或 /wv 代理地址） */
  src: string
  /** 无障碍标题 */
  title: string
  /** 新窗口打开的原始地址 */
  externalUrl: string
  /** 外部域名展示 */
  host: string
  /** 额外提示文案 */
  hint?: string
  className?: string
  /** iframe 高度类（默认撑满容器） */
  fill?: boolean
}

/**
 * 内嵌原网页面板：加载态 + 工具栏（刷新 / 新窗口打开）+ iframe。
 * 用于小红书创作者中心（直连可嵌）与夸克网盘（/wv 代理去 XFO）。
 */
export function WebEmbed({
  src,
  title,
  externalUrl,
  host,
  hint,
  className,
  fill = true,
}: WebEmbedProps) {
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // 切换 src 时重置加载态（微任务，避免 effect 内同步 setState）
  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true)
    })
    return () => {
      cancelled = true
    }
  }, [src, nonce])

  const reload = () => {
    setNonce((n) => n + 1)
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          已内嵌原网页 · {host}
        </span>
        {hint && (
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{hint}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={reload}
            aria-label="刷新内嵌页面"
            className="inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            刷新
          </button>
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            新窗口打开
          </a>
        </span>
      </div>

      {/* 内嵌页面 */}
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border bg-white",
          fill ? "min-h-[60vh] flex-1" : ""
        )}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <span className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            <p className="text-xs text-muted-foreground">正在载入 {host} …</p>
          </div>
        )}
        <iframe
          ref={frameRef}
          key={`${src}#${nonce}`}
          src={src}
          title={title}
          onLoad={() => setLoading(false)}
          allow="clipboard-read; clipboard-write; fullscreen"
          referrerPolicy="no-referrer-when-downgrade"
          className={cn(
            "block w-full border-0 bg-white",
            fill ? "h-full min-h-[60vh] w-full" : "h-[520px]"
          )}
        />
      </div>
    </div>
  )
}
