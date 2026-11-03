"use client"

import { useAppStore } from "@/lib/app-store"
import { WorkshopTab } from "@/components/workshop/workshop-tab"
import { PublishEmbedTab } from "@/components/publish/publish-embed"
import { NetdiskDialog } from "@/components/netdisk/netdisk-dialog"

/** 页签视图：壁纸工坊 / 小红书（内嵌创作者中心）；夸克网盘走右上角内嵌窗口 */
export function TabsView() {
  const tab = useAppStore((s) => s.tab)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      {tab === "workshop" && (
        <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
          <WorkshopTab />
        </div>
      )}
      {tab === "publish" && <PublishEmbedTab />}
      <NetdiskDialog />
    </div>
  )
}
