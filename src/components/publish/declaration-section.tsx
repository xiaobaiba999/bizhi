"use client"

import { BadgeCheck, Info, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { DECLARATIONS } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"
import type { DeclarationType } from "@/lib/types"

/** 自主声明（发布时可选项，默认「不添加声明」） */
export function DeclarationSection() {
  const declaration = usePublishStore((s) => s.declaration)
  const setDeclaration = usePublishStore((s) => s.setDeclaration)

  return (
    <section aria-label="自主声明" className="rounded-2xl border bg-card p-4 sm:p-5">
      <header className="mb-3 flex items-center gap-2">
        <ShieldCheck className="size-4 text-primary" />
        <h3 className="text-sm font-bold">自主声明</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
          可选
        </span>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          主动声明，让笔记更透明
        </span>
      </header>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {DECLARATIONS.map((d) => {
          const active = declaration === d.value
          return (
            <button
              key={d.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={d.title}
              onClick={() => setDeclaration(d.value as DeclarationType)}
              className={cn(
                "relative flex flex-col gap-1 rounded-xl border-2 p-3 text-left transition-all",
                active
                  ? "border-primary bg-accent shadow-sm"
                  : "border-border bg-background hover:border-primary/40"
              )}
            >
              {active && (
                <span className="absolute right-2 top-2 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <BadgeCheck className="size-3" />
                </span>
              )}
              <span
                className={cn(
                  "text-sm font-semibold leading-tight",
                  active ? "text-foreground" : "text-foreground/90"
                )}
              >
                {d.title}
              </span>
              <span className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
                <Info className="mt-0.5 size-3 shrink-0" />
                {d.desc}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
