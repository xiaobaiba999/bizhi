"use client"

import { create } from "zustand"
import type {
  DeclarationType,
  NoteRecord,
  PublishImage,
  Visibility,
} from "./types"

export type WizardStep = 0 | 1 | 2

interface PublishState {
  step: WizardStep
  /** 已选图片（首张为封面） */
  images: PublishImage[]
  title: string
  body: string
  /** 自主声明（发布时可选，默认 none） */
  declaration: DeclarationType
  /** 添加组件 —— 全部可选 */
  location: string | null
  topics: string[]
  mentions: string[]
  collection: string | null
  scheduleEnabled: boolean
  scheduledAt: string | null
  visibility: Visibility
  allowComments: boolean

  publishing: boolean
  publishedNote: NoteRecord | null
  publishError: string | null

  setStep: (step: WizardStep) => void
  next: () => void
  back: () => void

  addImages: (imgs: PublishImage[]) => void
  removeImage: (id: string) => void
  moveImage: (from: number, to: number) => void

  setTitle: (t: string) => void
  setBody: (b: string) => void

  setDeclaration: (d: DeclarationType) => void
  setLocation: (l: string | null) => void
  toggleTopic: (name: string) => void
  toggleMention: (name: string) => void
  setCollection: (c: string | null) => void
  setSchedule: (enabled: boolean, at?: string | null) => void
  setVisibility: (v: Visibility) => void
  setAllowComments: (b: boolean) => void

  publish: () => Promise<void>
  resetDraft: () => void
}

const initial = {
  step: 0 as WizardStep,
  images: [] as PublishImage[],
  title: "",
  body: "",
  declaration: "none" as DeclarationType,
  location: null as string | null,
  topics: [] as string[],
  mentions: [] as string[],
  collection: null as string | null,
  scheduleEnabled: false,
  scheduledAt: null as string | null,
  visibility: "public" as Visibility,
  allowComments: true,
  publishing: false,
  publishedNote: null as NoteRecord | null,
  publishError: null as string | null,
}

export const usePublishStore = create<PublishState>((set, get) => ({
  ...initial,

  setStep: (step) => set({ step }),
  next: () => set((s) => ({ step: Math.min(2, s.step + 1) as WizardStep })),
  back: () => set((s) => ({ step: Math.max(0, s.step - 1) as WizardStep })),

  addImages: (imgs) =>
    set((s) => {
      const remain = 18 - s.images.length
      if (remain <= 0) return s
      return { images: [...s.images, ...imgs.slice(0, remain)] }
    }),

  removeImage: (id) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })),

  moveImage: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.images.length || to >= s.images.length)
        return s
      const next = [...s.images]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { images: next }
    }),

  setTitle: (t) => set({ title: t.slice(0, 20) }),
  setBody: (b) => set({ body: b.slice(0, 1000) }),

  setDeclaration: (d) => set({ declaration: d }),
  setLocation: (l) => set({ location: l }),
  toggleTopic: (name) =>
    set((s) => ({
      topics: s.topics.includes(name)
        ? s.topics.filter((t) => t !== name)
        : [...s.topics, name].slice(0, 5),
    })),
  toggleMention: (name) =>
    set((s) => ({
      mentions: s.mentions.includes(name)
        ? s.mentions.filter((m) => m !== name)
        : [...s.mentions, name],
    })),
  setCollection: (c) => set({ collection: c }),
  setSchedule: (enabled, at) =>
    set((s) => ({
      scheduleEnabled: enabled,
      scheduledAt: enabled ? (at ?? s.scheduledAt ?? defaultScheduleAt()) : null,
    })),
  setVisibility: (v) => set({ visibility: v }),
  setAllowComments: (b) => set({ allowComments: b }),

  publish: async () => {
    const s = get()
    if (s.images.length === 0 || !s.title.trim() || !s.body.trim() || s.publishing) return
    set({ publishing: true, publishError: null })
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: s.title.trim(),
          body: s.body.trim(),
          images: s.images.map((i) => i.src),
          declaration: s.declaration,
          location: s.location,
          topics: s.topics,
          mentions: s.mentions,
          collection: s.collection,
          scheduledAt: s.scheduleEnabled ? s.scheduledAt : null,
          visibility: s.visibility,
          allowComments: s.allowComments,
        }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => null)
        throw new Error(msg?.error ?? "发布失败，请稍后重试")
      }
      const note: NoteRecord = await res.json()
      set({ publishing: false, publishedNote: note, step: 2 })
    } catch (e) {
      set({ publishing: false, publishError: e instanceof Error ? e.message : "发布失败" })
    }
  },

  resetDraft: () => set({ ...initial }),
}))

function defaultScheduleAt() {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  // datetime-local 格式
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
