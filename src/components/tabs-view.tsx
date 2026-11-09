import { WorkshopTab } from "@/components/workshop/workshop-tab"

/** 页面视图：壁纸工坊主界面（哲风壁纸实时获取 + 下载原图） */
export function TabsView() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
        <WorkshopTab />
      </div>
    </div>
  )
}
