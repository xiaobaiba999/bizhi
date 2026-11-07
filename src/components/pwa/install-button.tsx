"use client"

import { useState } from "react"
import { toast } from "sonner"
import { MonitorSmartphone } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePwaStore } from "@/lib/pwa-store"

/**
 * 顶栏「安装应用」按钮：
 * - 原生安装事件可用 → 点击直接唤起浏览器安装弹窗
 * - 不可用（Safari / 内嵌预览）→ 打开安装说明弹窗（手动步骤 + 卸载方法）
 * - 已是安装版独立窗口 → 隐藏
 */
export function InstallAppButton({ className }: { className?: string }) {
  const deferredPrompt = usePwaStore((s) => s.deferredPrompt)
  const standalone = usePwaStore((s) => s.standalone)
  const setDialogOpen = usePwaStore((s) => s.setDialogOpen)
  const [busy, setBusy] = useState(false)

  if (standalone) return null

  const onClick = async () => {
    if (deferredPrompt && !busy) {
      setBusy(true)
      try {
        await deferredPrompt.prompt()
        const { outcome } = await deferredPrompt.userChoice
        if (outcome === "accepted") toast.success("正在安装「壁纸工坊」…")
        else toast.info("已取消安装，之后可随时再点「安装应用」")
      } catch {
        // 静默：回落到说明弹窗
      }
      setBusy(false)
      return
    }
    setDialogOpen(true)
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={cn(
        "ml-1.5 inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-primary/50 bg-primary/10 px-3 text-xs font-bold text-primary transition-all hover:bg-primary/15 active:scale-95 sm:px-4 sm:text-sm",
        className
      )}
    >
      <MonitorSmartphone className="size-4" />
      <span>安装应用</span>
    </button>
  )
}
