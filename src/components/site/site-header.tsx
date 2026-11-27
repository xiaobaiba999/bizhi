import Link from "next/link"

/** 站点顶栏：Logo + 站名 + 版本徽标 */
export function SiteHeader() {
  return (
    <header className="border-b bg-card/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="壁纸工坊首页">
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-black text-primary-foreground shadow-md shadow-primary/25"
          >
            壁
          </span>
          <span className="text-base font-black tracking-tight">壁纸工坊</span>
          <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
            v1.4.13 桌面版
          </span>
        </Link>
        <nav aria-label="主导航" className="flex items-center gap-1 text-xs font-semibold">
          <a
            href="https://haowallpaper.com"
            target="_blank"
            rel="noreferrer"
            className="rounded-full px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            数据来源：哲风壁纸
          </a>
        </nav>
      </div>
    </header>
  )
}
