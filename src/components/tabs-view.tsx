"use client"

import { WorkshopTab } from "@/components/workshop/workshop-tab"
import { WebviewOverlay } from "@/components/webview/webview-overlay"

/**
 * 页面视图：壁纸工坊主界面 + 全屏内嵌网页（小红书创作者中心 / 夸克网盘）。
 * 网页视图直接接管整个软件页面（fixed inset-0），关闭后回到工坊。
 */
export function TabsView() {
  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
          <WorkshopTab />
        </div>
      </div>
      <WebviewOverlay />
    </>
  )
}
