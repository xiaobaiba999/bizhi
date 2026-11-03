import Link from "next/link"
import { Sparkles } from "lucide-react"

/** 顶部导航：小红书创作中心风格 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="小红书创作中心首页">
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-sm font-black text-primary-foreground shadow-lg shadow-primary/25">
            书
          </span>
          <span className="hidden text-base font-bold sm:inline">
            小红书<span className="ml-1.5 text-xs font-medium text-muted-foreground">创作中心</span>
          </span>
        </Link>

        <nav aria-label="主导航" className="ml-auto flex items-center gap-1 sm:gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground">
            <Sparkles className="size-3.5" />
            发布笔记
          </span>
          <span className="hidden rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground md:inline">
            数据看板
          </span>
          <span className="hidden rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground md:inline">
            评论管理
          </span>
          <span
            aria-hidden
            className="ml-1 flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground"
          >
            红
          </span>
        </nav>
      </div>
    </header>
  )
}
