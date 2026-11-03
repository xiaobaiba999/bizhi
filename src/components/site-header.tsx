"use client"

import Link from "next/link"
import { Cloud, ImageIcon, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/app-store"

/** 顶部导航：壁纸工坊（应用页） + 小红书（全屏接管创作者中心） + 夸克网盘（右上角，全屏接管） */
export function SiteHeader() {
  const webview = useAppStore((s) => s.webview)
  const openWebview = useAppStore((s) => s.openWebview)
  const closeWebview = useAppStore((s) => s.closeWebview)

  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="壁纸工坊首页">
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-sm font-black text-primary-foreground shadow-lg shadow-primary/25">
            壁
          </span>
          <span className="hidden text-base font-bold sm:inline">壁纸工坊</span>
          <span className="hidden rounded-full border px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground sm:inline">
            v1.0.10
          </span>
        </Link>

        <nav aria-label="主导航" className="ml-auto flex items-center gap-1 sm:gap-1.5">
          {/* 壁纸工坊：应用主页（网页视图打开时被全屏接管覆盖） */}
          <button
            type="button"
            aria-current="page"
            onClick={() => closeWebview()}
            className={cn(
              "relative inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors sm:px-4 sm:text-sm",
              !webview
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <ImageIcon className="size-3.5" />
            <span>壁纸工坊</span>
          </button>

          {/* 小红书：直接全屏接管创作者中心原网页 */}
          <button
            type="button"
            onClick={() => openWebview("xhs")}
            className={cn(
              "relative inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors sm:px-4 sm:text-sm",
              webview === "xhs"
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Send className="size-3.5" />
            <span>小红书</span>
          </button>

          {/* 夸克网盘：最右上角，直接全屏接管原网页 */}
          <button
            type="button"
            aria-pressed={webview === "quark"}
            onClick={() => openWebview("quark")}
            className={cn(
              "ml-1.5 inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-primary/50 bg-primary/10 px-3 text-xs font-bold text-primary transition-all hover:bg-primary/15 active:scale-95 sm:px-4 sm:text-sm",
              webview === "quark" && "bg-primary text-primary-foreground shadow-md shadow-primary/20"
            )}
          >
            <Cloud className="size-4" />
            <span className="hidden xs:inline sm:inline">夸克网盘</span>
          </button>
        </nav>
      </div>
    </header>
  )
}
