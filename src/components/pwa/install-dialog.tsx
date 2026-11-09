"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  CheckCircle2,
  Download,
  Eraser,
  ExternalLink,
  Info,
  Laptop,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { APP_VERSION, SETUP_EXE_NAME } from "@/lib/version"
import { usePwaStore } from "@/lib/pwa-store"
import { detectWorkshopMode } from "@/lib/workshop-source"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Platform = "windows" | "macos" | "ios" | "android" | "other"

/** 静态导出子路径（GitHub Pages 项目页如 /bizhi；根路径 / dev / 桌面版为空串） */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ""

const PLATFORM_META: Record<Platform, { label: string; icon: React.ReactNode }> = {
  windows: { label: "Windows", icon: <Monitor className="size-4" /> },
  macos: { label: "macOS", icon: <Laptop className="size-4" /> },
  ios: { label: "iPhone / iPad", icon: <Smartphone className="size-4" /> },
  android: { label: "Android", icon: <Smartphone className="size-4" /> },
  other: { label: "其他平台", icon: <MonitorSmartphone className="size-4" /> },
}

const PLATFORMS: Platform[] = ["windows", "macos", "ios", "android"]

const INSTALL_STEPS: Record<Platform, string[]> = {
  windows: [
    "用 Chrome / Edge 在新标签页打开本站（非内嵌预览）",
    "点击地址栏右侧的「安装」图标，或右上角菜单 → 应用 → 将此网站作为应用安装",
    "桌面与开始菜单会出现「壁纸工坊」，双击即独立窗口运行",
  ],
  macos: [
    "Chrome：右上角菜单 → 安装应用；Safari：菜单栏 文件 → 添加到 Dock",
    "程序坞与启动台会出现「壁纸工坊」图标，点开即独立窗口运行",
  ],
  ios: [
    "务必用 Safari 打开本站（iOS 上其他浏览器无法安装）",
    "点底部「分享」按钮，向下滑动点击「添加到主屏幕」",
    "主屏幕出现「壁纸工坊」图标，点开即为全屏独立应用",
  ],
  android: [
    "用 Chrome 打开本站",
    "右上角菜单 ⋮ → 安装应用（或「添加到主屏幕」）",
    "桌面出现「壁纸工坊」图标，像普通 App 一样全屏使用",
  ],
  other: ["在浏览器菜单中找到「安装应用 / 添加到主屏幕」即可安装"],
}

const UNINSTALL_STEPS: Record<Platform, string[]> = {
  windows: [
    "exe 安装版：开始菜单右键「壁纸工坊」→ 卸载，或 设置 → 应用 → 安装的应用 → 壁纸工坊 → 卸载",
    "卸载只清除程序本体（安装目录）；下载记录永久保留，重装后自动恢复显示",
    "网页版（PWA）：开始菜单右键 → 卸载；或 chrome://apps 右键图标 → 移除 Chrome 应用",
  ],
  macos: ["启动台长按拖入废纸篓；或打开 chrome://apps 右键图标 → 移除 Chrome 应用"],
  ios: ["主屏幕长按「壁纸工坊」图标 → 删除 App → 删除（立即移除，无残留）"],
  android: ["长按图标拖到「卸载」，或 设置 → 应用 → 壁纸工坊 → 卸载（本地数据随应用清除）"],
  other: ["在系统应用列表中找到「壁纸工坊」执行卸载即可"],
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios"
  if (/Android/i.test(ua)) return "android"
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos"
  if (/Windows/i.test(ua)) return "windows"
  return "other"
}

/** 各平台安装 / 卸载步骤列表（当前平台高亮排最前） */
function StepList({
  platform,
  current,
  steps,
}: {
  platform: Platform
  current: boolean
  steps: string[]
}) {
  const meta = PLATFORM_META[platform]
  return (
    <div
      className={cn(
        "rounded-2xl border p-3.5",
        current ? "border-primary/40 bg-primary/5" : "border-border bg-background"
      )}
    >
      <p className="flex items-center gap-2 text-xs font-bold">
        <span className={cn("text-muted-foreground", current && "text-primary")}>{meta.icon}</span>
        <span>{meta.label}</span>
        {current && (
          <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
            当前平台
          </span>
        )}
      </p>
      <ol className="mt-2 space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * 安装 / 卸载说明弹窗：
 * - 安装：原生一键安装（可用时）+ 各平台手动步骤（当前平台高亮）
 * - 卸载：各平台卸载方法（exe 版卸载只清程序本体，下载记录永久保留）
 * - 数据说明：下载记录存用户数据目录（重装自动恢复）/ localStorage（网页版），
 *   「彻底清除本地数据」按钮可一键重置
 */
export function AppInstallDialog() {
  const open = usePwaStore((s) => s.dialogOpen)
  const setOpen = usePwaStore((s) => s.setDialogOpen)
  const deferredPrompt = usePwaStore((s) => s.deferredPrompt)
  const setDeferredPrompt = usePwaStore((s) => s.setDeferredPrompt)
  const standalone = usePwaStore((s) => s.standalone)

  // 纯静态托管（GitHub Pages）：不随站分发 exe 安装包，隐藏下载卡片、PWA 成为唯一安装方式
  const [isStatic, setIsStatic] = useState(false)
  useEffect(() => {
    void detectWorkshopMode().then((m) => setIsStatic(m === "static"))
  }, [])

  // 平台 / 是否内嵌框架：挂载时一次性检测（弹窗内容仅在打开后渲染，无 SSR 不匹配）
  const [platform] = useState<Platform>(() =>
    typeof window === "undefined" ? "other" : detectPlatform()
  )
  const [inFrame] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    try {
      return window.top !== window.self
    } catch {
      return true
    }
  })
  const [installing, setInstalling] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  /** 唤起浏览器原生一键安装 */
  const doInstall = async () => {
    if (!deferredPrompt || installing) return
    setInstalling(true)
    try {
      await deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === "accepted") toast.success("正在安装「壁纸工坊」…")
      else toast.info("已取消安装，之后可随时点「安装应用」")
      setDeferredPrompt(null)
    } catch {
      // 浏览器环境不支持时静默，回落到手动步骤
    }
    setInstalling(false)
  }

  /** 清除本应用在浏览器里的全部本地数据（缓存 / 存储 / Service Worker） */
  const clearLocalData = async () => {
    if (clearing) return
    setClearing(true)
    const done: string[] = []
    try {
      if ("caches" in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
        if (keys.length > 0) done.push(`缓存 ×${keys.length}`)
      }
    } catch {
      // 忽略
    }
    try {
      const n = localStorage.length
      localStorage.clear()
      if (n > 0) done.push(`本地存储 ×${n}`)
    } catch {
      // 忽略
    }
    try {
      sessionStorage.clear()
    } catch {
      // 忽略
    }
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
        if (regs.length > 0) done.push(`Service Worker ×${regs.length}`)
      }
    } catch {
      // 忽略
    }
    setCleared(true)
    toast.success(done.length ? `已清除：${done.join("、")}` : "本地没有残留数据，已是干净状态")
    setClearing(false)
  }

  const orderedPlatforms: Platform[] = platform === "other" ? PLATFORMS : [platform, ...PLATFORMS.filter((p) => p !== platform)]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="custom-scrollbar max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone className="size-5 text-primary" />
            安装「壁纸工坊」到桌面
          </DialogTitle>
          <DialogDescription>
            {isStatic
              ? "用浏览器一键安装，独立窗口运行，卸载不留残留"
              : "Windows 可下载 exe 安装包；其他平台可用浏览器安装。均能正常卸载、不留残留"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          {/* 方式一（静态托管下不展示）：Windows exe 安装包 */}
          {!isStatic && (
          <section aria-label="Windows 桌面安装包下载">
            <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-4">
              <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                <Monitor className="size-4 text-primary" />
                Windows 桌面版（exe 安装包）
                <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                  推荐
                </span>
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                正经的桌面软件安装包：向导式安装、独立窗口运行、桌面与开始菜单快捷方式、
                壁纸自动存入「下载」文件夹，可在「下载位置」里调起系统磁盘文件夹任意选择保存位置；
                卸载只清程序本体，下载记录永久保留，重装后自动恢复。
              </p>
              <a
                href={`${BASE_PATH}/desktop/${SETUP_EXE_NAME}`}
                download
                className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-[0.98]"
              >
                <Download className="size-4" />
                下载安装包（v{APP_VERSION} · 约 175MB）
              </a>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                v{APP_VERSION} 更新：① 壁纸显示全面提速 —— 图片持久缓存跨版本保留
                （升级 / 重装后已看过的壁纸秒开，不再每次重新慢慢加载）、首屏高优先级
                加载、空闲预取下一页；② 下载记录三层永久保险（本地数据库 + JSON 档案
                + 浏览器镜像，启动自动合并）—— 换装任何新版本都会记住并继续隐藏之前
                已下载 / 屏蔽的壁纸；③ 桌面版同样启用图片缓存。保留此前全部能力
                （GitHub Pages 网页版、卸载保留用户数据、下载统一转存 JPG、剔除动态
                壁纸、右侧已选清单同步、中文路径安装、覆盖安装免卸载）。未签名应用首次
                运行时 SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。
              </p>
            </div>
          </section>
          )}

          {/* 当前状态 */}
          {standalone ? (
            <p className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400">
              <CheckCircle2 className="size-4 shrink-0" />
              当前已是安装版：正以独立窗口运行，无需重复安装
            </p>
          ) : inFrame ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
              <p className="font-bold">当前处于内嵌预览框架，无法直接安装</p>
              <p className="mt-1">请先在独立标签页打开本站，再按下方步骤安装：</p>
              <button
                type="button"
                onClick={() => {
                  const w = window.open(window.location.href, "_blank", "noopener")
                  if (!w) toast.error("新窗口被拦截，请使用预览面板上方的「Open in New Tab」按钮")
                }}
                className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-amber-600 px-3.5 text-[11px] font-bold text-white transition-all hover:bg-amber-700 active:scale-95"
              >
                <ExternalLink className="size-3.5" />
                在新标签页打开
              </button>
            </div>
          ) : deferredPrompt ? (
            <button
              type="button"
              onClick={() => void doInstall()}
              disabled={installing}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
            >
              <Download className="size-4" />
              {installing ? "正在唤起安装…" : "一键安装到桌面"}
            </button>
          ) : null}

          {/* 安装步骤 */}
          <section aria-label="各平台安装步骤">
            <h3 className="mb-2 text-sm font-bold">
              {isStatic ? "安装到桌面 / 手机（PWA，免下载安装包）" : "方式二：浏览器安装（PWA，免下载安装包）"}
            </h3>
            <div className="space-y-2">
              {orderedPlatforms.map((p) => (
                <StepList
                  key={p}
                  platform={p}
                  current={p === platform}
                  steps={INSTALL_STEPS[p]}
                />
              ))}
            </div>
          </section>

          <Separator />

          {/* 卸载说明 */}
          <section aria-label="卸载说明">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
              <Trash2 className="size-4 text-destructive" />
              卸载方法（正常卸载，无残留）
            </h3>
            <div className="space-y-2">
              {(platform === "other" ? (["other"] as Platform[]) : [platform]).map((p) => (
                <StepList key={p} platform={p} current steps={UNINSTALL_STEPS[p]} />
              ))}
            </div>
            <p className="mt-3 flex gap-2 rounded-2xl bg-muted px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <Info className="size-4 shrink-0 translate-y-0.5" />
              exe 安装版卸载时由 NSIS 卸载器清理安装目录（程序本体）；用户数据目录
              （下载记录数据库、设置）永久保留 —— 重装后自动恢复已下载记录；如需彻底清理
              可用下方「清除本地数据」按钮。网页版在本地只占用「缓存 + 本地存储」，
              卸载时自动一并清除。下载的壁纸保存在用户「下载」文件夹，属于用户自己的文件。
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void clearLocalData()}
                disabled={clearing}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-destructive/40 px-4 text-xs font-bold text-destructive transition-all hover:bg-destructive/10 active:scale-95 disabled:opacity-60"
              >
                <Eraser className={cn("size-3.5", clearing && "animate-pulse")} />
                {clearing ? "正在清除…" : "彻底清除本地数据（含下载记录）"}
              </button>
              {cleared && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >
                  <RefreshCw className="size-3.5" />
                  刷新页面
                </button>
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
