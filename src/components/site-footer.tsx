import { InstallGuideLink } from "@/components/pwa/install-link"
import { APP_VERSION } from "@/lib/version"

/** 底部：sticky footer（短页贴底、长页自然下推） */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:px-6">
        <p>
          © 2026 壁纸工坊 v{APP_VERSION} · 壁纸来自
          <a
            href="https://haowallpaper.com"
            target="_blank"
            rel="noreferrer"
            className="mx-1 font-semibold text-foreground underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            哲风壁纸
          </a>
        </p>
        <p className="flex items-center gap-3">
          <InstallGuideLink />
          <span aria-hidden>·</span>
          <span>壁纸协议</span>
          <span aria-hidden>·</span>
          <span>社区规范</span>
          <span aria-hidden>·</span>
          <span>关于我们</span>
        </p>
      </div>
    </footer>
  )
}
