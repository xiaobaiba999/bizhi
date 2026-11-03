"use client"

import { useRef } from "react"
import { toast } from "sonner"
import { AtSign, Hash, PenLine, Smile } from "lucide-react"
import { cn } from "@/lib/utils"
import { BODY_MAX, QUICK_EMOJIS, RECOMMEND_TOPICS, TITLE_MAX } from "@/lib/publish-data"
import { usePublishStore } from "@/lib/store"

export function StepCaption() {
  const title = usePublishStore((s) => s.title)
  const body = usePublishStore((s) => s.body)
  const setTitle = usePublishStore((s) => s.setTitle)
  const setBody = usePublishStore((s) => s.setBody)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const insertAtCursor = (text: string) => {
    const el = bodyRef.current
    if (!el) {
      setBody(body + text)
      return
    }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const nextBody = body.slice(0, start) + text + body.slice(end)
    setBody(nextBody)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
    })
  }

  const addTopic = (name: string) => {
    if (body.includes(`#${name}`)) {
      toast.error("正文中已有该话题")
      return
    }
    insertAtCursor(`#${name} `)
  }

  return (
    <section aria-label="完成文案">
      <header className="mb-4">
        <h2 className="text-lg font-bold">完成文案</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          好标题+真诚分享更容易被推荐，正文可插入话题与 @ 好友
        </p>
      </header>

      <div className="space-y-4">
        {/* 标题 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="note-title" className="flex items-center gap-1.5 text-sm font-semibold">
              <PenLine className="size-4 text-primary" />
              标题
            </label>
            <span
              className={cn(
                "text-xs tabular-nums",
                title.length >= TITLE_MAX ? "font-bold text-primary" : "text-muted-foreground"
              )}
            >
              {title.length}/{TITLE_MAX}
            </span>
          </div>
          <input
            id="note-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="20 字内吸引人的标题，例：藏在武康路的宝藏咖啡馆"
            className="h-12 w-full rounded-xl border bg-background px-4 text-base outline-none transition-all placeholder:text-muted-foreground/60 focus:border-primary focus:ring-4 focus:ring-primary/10"
            maxLength={TITLE_MAX}
          />
        </div>

        {/* 正文 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="note-body" className="text-sm font-semibold">
              正文
            </label>
            <span
              className={cn(
                "text-xs tabular-nums",
                body.length >= BODY_MAX ? "font-bold text-primary" : "text-muted-foreground"
              )}
            >
              {body.length}/{BODY_MAX}
            </span>
          </div>
          <textarea
            id="note-body"
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"写下这一刻的想法…\n#话题名 会自动高亮，可以 @ 好友一起看"}
            rows={8}
            maxLength={BODY_MAX}
            className="w-full resize-none rounded-xl border bg-background p-4 text-[15px] leading-relaxed outline-none transition-all placeholder:text-muted-foreground/60 focus:border-primary focus:ring-4 focus:ring-primary/10"
          />
        </div>

        {/* 快捷 emoji */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          <Smile className="size-4 shrink-0 text-muted-foreground" />
          <div className="custom-scrollbar flex gap-1.5">
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => insertAtCursor(e)}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-base transition-transform hover:scale-125 hover:bg-accent"
                aria-label={`插入表情 ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* 推荐话题 */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Hash className="size-4 text-primary" />
            插入话题
            <span className="text-xs font-normal text-muted-foreground">点击加入正文</span>
          </div>
          <div className="custom-scrollbar flex flex-wrap gap-2">
            {RECOMMEND_TOPICS.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => addTopic(t.name)}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
              >
                <span className="text-primary">#</span>
                {t.name}
                <span className="text-[10px] text-muted-foreground">
                  {formatHot(t.hot)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* @ 好友提示：具体在第三步「添加组件」中选择，这里支持手动输入 */}
        <div className="flex items-start gap-2 rounded-xl bg-muted/60 p-3.5 text-xs text-muted-foreground">
          <AtSign className="mt-0.5 size-4 shrink-0" />
          <p>
            小贴士：正文中手动输入 <span className="font-semibold text-foreground">@昵称</span>{" "}
            可提及好友；也可以在下一步「添加组件」中挂载位置、话题、@ 提及、定时发布等组件。
          </p>
        </div>
      </div>
    </section>
  )
}

function formatHot(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : `${n}`
}
