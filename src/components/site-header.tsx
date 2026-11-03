"use client"

import Link from "next/link"
import { Cloud, ImageIcon, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore, type AppTab } from "@/lib/app-store"

const TABS: { key: AppTab; label: string; icon: React.ReactNode }[] = [
  { key: "workshop", label: "壁纸工坊", icon: <ImageIcon className="size-3.5" /> },
  { key: "publish", label: "小红书", icon: <Send className="size-3.5" /> },
]

/** 顶部导航：壁纸工坊 / 小红书页签 + 夸克网盘入口（最右上角，调起内嵌原网页） */
export function SiteHeader() {
  const tab = useAppStore((s) => s.tab)
  const setTab = useAppStore((s) => s.setTab)
  const netdiskOpen = useAppStore((s) => s.netdiskOpen)
  const setNetdiskOpen = useAppStore((s) => s.setNetdiskOpen)

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
          {TABS.map((t) => {
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => setTab(t.key)}
                className={cn(
                  "relative inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors sm:px-4 sm:text-sm",
                  active
                    ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            )
          })}

          {/* 夸克网盘入口：最右上角，调起内嵌原网页窗口 */}
          <button
            type="button"
            aria-pressed={netdiskOpen}
            onClick={() => setNetdiskOpen(true)}
            className={cn(
              "ml-1.5 inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-primary/50 bg-primary/10 px-3 text-xs font-bold text-primary transition-all hover:bg-primary/15 active:scale-95 sm:px-4 sm:text-sm",
              netdiskOpen && "bg-primary text-primary-foreground shadow-md shadow-primary/20"
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
