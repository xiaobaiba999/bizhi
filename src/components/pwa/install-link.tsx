"use client"

import { usePwaStore } from "@/lib/pwa-store"

/** footer「安装 / 卸载说明」入口：打开安装说明弹窗 */
export function InstallGuideLink() {
  const setDialogOpen = usePwaStore((s) => s.setDialogOpen)
  return (
    <button
      type="button"
      onClick={() => setDialogOpen(true)}
      className="font-semibold text-foreground underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
    >
      安装 / 卸载说明
    </button>
  )
}
