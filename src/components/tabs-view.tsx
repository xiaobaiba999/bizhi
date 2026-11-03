"use client"

import { useAppStore } from "@/lib/app-store"
import { WorkshopTab } from "@/components/workshop/workshop-tab"
import { NetdiskTab } from "@/components/netdisk/netdisk-tab"
import { Wizard } from "@/components/publish/wizard"

/** 三个功能页签：壁纸工坊 / 小红书发布 / 夸克网盘 */
export function TabsView() {
  const tab = useAppStore((s) => s.tab)

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      {tab === "workshop" && (
        <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
          <WorkshopTab />
        </div>
      )}
      {tab === "publish" && (
        <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
          <div className="mb-6 flex flex-col items-start gap-1.5">
            <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">发布图文笔记</h1>
            <p className="text-sm text-muted-foreground">
              三步完成：选择图片 → 完成文案 → 发布设置（自主声明与添加组件均为可选）
            </p>
          </div>
          <Wizard />
        </div>
      )}
      {tab === "netdisk" && (
        <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
          <NetdiskTab />
        </div>
      )}
    </div>
  )
}
