"use client"

import Link from "next/link"
import { CloudUpload, ImageIcon, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore, type AppTab } from "@/lib/app-store"
import { usePublishStore } from "@/lib/store"

const TABS: { key: AppTab; label: string; icon: React.ReactNode }[] = [
  { key: "workshop", label: "壁纸工坊", icon: <ImageIcon className="size-3.5" /> },
  { key: "publish", label: "小红书发布", icon: <Send className="size-3.5" /> },
  { key: "netdisk", label: "夸克网盘", icon: <CloudUpload className="size-3.5" /> },
]

/** 顶部导航：壁纸工坊 · 三大功能页签 */
export function SiteHeader() {
  const tab = useAppStore((s) => s.tab)
  const setTab = useAppStore((s) => s.setTab)
  const imageCount = usePublishStore((s) => s.images.length)

  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="壁纸工坊首页">
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-sm font-black text-primary-foreground shadow-lg shadow-primary/25">
            壁
          </span>
          <span className="hidden text-base font-bold sm:inline">壁纸工坊</span>
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
                <span className={cn(t.key === "publish" && "hidden xs:inline sm:inline")}>
                  {t.label}
                </span>
                {t.key === "publish" && imageCount > 0 && !active && (
                  <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                    {imageCount}
                  </span>
                )}
              </button>
            )
          })}
          <span
            aria-hidden
            className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground"
          >
            壁
          </span>
        </nav>
      </div>
    </header>
  )
}
