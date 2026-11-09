"use client"

import Link from "next/link"
import { ImageIcon } from "lucide-react"
import { InstallAppButton } from "@/components/pwa/install-button"
import { APP_VERSION } from "@/lib/version"

/** 顶部导航：壁纸工坊（哲风壁纸实时获取 + 下载原图） + 安装应用 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="壁纸工坊首页">
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-sm font-black text-primary-foreground shadow-lg shadow-primary/25">
            壁
          </span>
          <span className="hidden text-base font-bold sm:inline">壁纸工坊</span>
          <span className="hidden rounded-full border px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground sm:inline">
            v{APP_VERSION}
          </span>
        </Link>

        <nav aria-label="主导航" className="ml-auto flex items-center gap-1 sm:gap-1.5">
          {/* 壁纸工坊：应用主页 */}
          <span
            aria-current="page"
            className="relative inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-md shadow-primary/20 sm:px-4 sm:text-sm"
          >
            <ImageIcon className="size-3.5" />
            <span>壁纸工坊</span>
          </span>

          {/* 安装应用：装成桌面软件，独立窗口运行，可正常卸载 */}
          <InstallAppButton />
        </nav>
      </div>
    </header>
  )
}
