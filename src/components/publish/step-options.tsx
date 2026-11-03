"use client"

import { MessageSquare, Eye } from "lucide-react"
import { cn } from "@/lib/utils"
import { VISIBILITIES } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"
import { DeclarationSection } from "./declaration-section"
import { ComponentsSection } from "./components-section"

/** 第三步：发布设置 —— 自主声明 / 添加组件 / 更多设置，全部可选 */
export function StepOptions() {
  const visibility = usePublishStore((s) => s.visibility)
  const setVisibility = usePublishStore((s) => s.setVisibility)
  const allowComments = usePublishStore((s) => s.allowComments)
  const setAllowComments = usePublishStore((s) => s.setAllowComments)
  const scheduleEnabled = usePublishStore((s) => s.scheduleEnabled)

  return (
    <section aria-label="发布设置" className="space-y-4">
      <header>
        <h2 className="text-lg font-bold">发布设置</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          自主声明与添加组件均为<b className="text-foreground">可选项</b>
          {scheduleEnabled ? "，已设置定时发布" : "，可直接跳过发布"}
        </p>
      </header>

      {/* 自主声明（可选） */}
      <DeclarationSection />

      {/* 添加组件（可选） */}
      <ComponentsSection />

      {/* 更多设置 */}
      <section aria-label="更多设置" className="rounded-2xl border bg-card p-4 sm:p-5">
        <header className="mb-3 flex items-center gap-2">
          <Eye className="size-4 text-primary" />
          <h3 className="text-sm font-bold">可见范围</h3>
        </header>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {VISIBILITIES.map((v) => {
            const active = visibility === v.value
            return (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setVisibility(v.value)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-xl border-2 p-3 text-left transition-all",
                  active
                    ? "border-primary bg-accent shadow-sm"
                    : "border-border bg-background hover:border-primary/40"
                )}
              >
                <span className="text-sm font-semibold">{v.label}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">{v.desc}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-4 flex items-center gap-3 border-t pt-4">
          <MessageSquare className="size-4 text-muted-foreground" />
          <div className="flex-1">
            <p className="text-sm font-semibold">允许评论</p>
            <p className="text-xs text-muted-foreground">关闭后他人无法在笔记下留言</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={allowComments}
            aria-label="允许评论"
            onClick={() => setAllowComments(!allowComments)}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors",
              allowComments ? "bg-primary" : "bg-muted-foreground/25"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                allowComments ? "left-[22px]" : "left-0.5"
              )}
            />
          </button>
        </div>
      </section>
    </section>
  )
}
