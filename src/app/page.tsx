import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { Wizard } from "@/components/publish/wizard"

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        <div className="mb-6 flex flex-col items-start gap-1.5">
          <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">
            发布图文笔记
          </h1>
          <p className="text-sm text-muted-foreground">
            三步完成：选择图片 → 完成文案 → 发布设置（自主声明与添加组件均为可选）
          </p>
        </div>

        <div className="rounded-3xl border bg-background p-4 shadow-sm sm:p-6 lg:p-8">
          <Wizard />
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
