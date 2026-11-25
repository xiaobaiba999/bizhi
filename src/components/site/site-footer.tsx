/** 站点页脚：固定吸底（内容不足一屏时贴住视口底部，超出时自然下推） */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t bg-card/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-1.5 px-4 py-4 text-[11px] text-muted-foreground sm:flex-row sm:px-6">
        <p>
          壁纸工坊 · 数据实时来自
          <a
            href="https://haowallpaper.com"
            target="_blank"
            rel="noreferrer"
            className="mx-1 font-semibold text-foreground/80 underline decoration-primary/40 underline-offset-2"
          >
            哲风壁纸
          </a>
          ，版权归原作者所有
        </p>
        <p>v1.4.9 桌面版 · Windows 安装包见 Releases</p>
      </div>
    </footer>
  )
}
