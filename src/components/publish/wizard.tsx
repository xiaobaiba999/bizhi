"use client"

import { AnimatePresence, motion } from "framer-motion"
import { Check, ChevronLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { STEPS } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"
import { MobilePreviewBar } from "./mobile-preview"
import { StepImages } from "./step-images"
import { StepCaption } from "./step-caption"
import { StepOptions } from "./step-options"
import { PreviewCard } from "./preview-card"
import { PublishResult } from "./publish-result"

export function Wizard() {
  const step = usePublishStore((s) => s.step)
  const images = usePublishStore((s) => s.images)
  const title = usePublishStore((s) => s.title)
  const body = usePublishStore((s) => s.body)
  const publishing = usePublishStore((s) => s.publishing)
  const publishError = usePublishStore((s) => s.publishError)
  const publishedNote = usePublishStore((s) => s.publishedNote)
  const next = usePublishStore((s) => s.next)
  const back = usePublishStore((s) => s.back)

  // 第一步需至少 1 张图；第二步需标题与正文；第三步（发布设置全部可选）只需草稿有效
  const validDraft = images.length > 0 && title.trim().length > 0 && body.trim().length > 0
  const canNext =
    step === 0 ? images.length > 0 : step === 1 ? title.trim().length > 0 && body.trim().length > 0 : validDraft

  if (publishedNote) {
    return <PublishResult note={publishedNote} />
  }

  return (
    <div className="w-full">
      {/* 步骤条 */}
      <div className="mb-6 flex items-center justify-center gap-0 sm:gap-2">
        {STEPS.map((s, i) => {
          const done = step > i
          const active = step === i
          return (
            <div key={s.key} className="flex items-center">
              {i > 0 && (
                <div
                  className={cn(
                    "mx-1 h-px w-6 transition-colors sm:mx-2 sm:w-12",
                    done || active ? "bg-primary" : "bg-border"
                  )}
                  aria-hidden
                />
              )}
              <button
                type="button"
                disabled={i > step}
                onClick={() => {
                  if (i < step) usePublishStore.getState().setStep(i as 0 | 1)
                }}
                className={cn(
                  "flex min-w-14 flex-col items-center gap-1 rounded-xl px-2 py-1.5 transition-all sm:min-w-20 sm:flex-row sm:gap-2.5",
                  i < step && "cursor-pointer hover:bg-accent"
                )}
                aria-current={active ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-all",
                    done
                      ? "bg-primary text-primary-foreground"
                      : active
                        ? "bg-primary text-primary-foreground ring-4 ring-primary/15"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {done ? <Check className="size-4" /> : i + 1}
                </span>
                <span className="flex flex-col sm:flex-row sm:items-center sm:gap-1.5">
                  <span
                    className={cn(
                      "text-xs font-medium leading-tight sm:text-sm",
                      active ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="hidden text-xs text-muted-foreground/70 lg:inline">
                    · {s.desc}
                  </span>
                </span>
              </button>
            </div>
          )
        })}
      </div>

      {/* 窄屏迷你预览条（< md）：吸附在 header 下方，随时可打开完整预览 */}
      <div className="sticky top-[68px] z-30 mb-4 md:hidden">
        <MobilePreviewBar />
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {/* 当前用户可见的步骤：选图 → 文案 → 发布设置 */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {step === 0 && <StepImages />}
              {step === 1 && <StepCaption />}
              {step === 2 && <StepOptions />}
            </motion.div>
          </AnimatePresence>

          {/* 底部操作条 */}
          <div className="mt-6 flex items-center gap-3 border-t pt-5">
            {step > 0 ? (
              <button
                type="button"
                onClick={back}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border px-5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
              >
                <ChevronLeft className="size-4" />
                上一步
              </button>
            ) : (
              <p className="hidden text-xs text-muted-foreground sm:block">
                按小红书社区规范，图文笔记至少需要 1 张图片
              </p>
            )}

            <div className="ml-auto flex items-center gap-3">
              {step === 2 && (
                <p className="hidden text-xs text-muted-foreground md:block">
                  声明与组件均为可选，可直接发布
                </p>
              )}
              {step < 2 ? (
                <button
                  type="button"
                  disabled={!canNext || publishing}
                  onClick={next}
                  className="inline-flex h-11 items-center rounded-full bg-primary px-8 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                >
                  下一步
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canNext || publishing}
                  onClick={() => usePublishStore.getState().publish()}
                  className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-8 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                >
                  {publishing && (
                    <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  )}
                  {publishing ? "发布中…" : "发布"}
                </button>
              )}
            </div>
          </div>

          {publishError && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
            >
              {publishError}
            </p>
          )}
        </div>

        {/* 桌面端（≥ md）右侧实时预览 */}
        <aside className="hidden md:block">
          <div className="sticky top-20">
            <p className="mb-3 text-xs font-medium text-muted-foreground">实时预览</p>
            <PreviewCard />
          </div>
        </aside>
      </div>
    </div>
  )
}
