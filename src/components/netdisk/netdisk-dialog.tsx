"use client"

import { useAppStore } from "@/lib/app-store"
import { WebEmbed } from "@/components/web-embed"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 夸克网盘首页（经 /wv 反向代理剥离 X-Frame-Options 后内嵌） */
const QUARK_URL = "https://pan.quark.cn/"
const QUARK_PROXY_URL = "/wv/pan.quark.cn/"

/**
 * 夸克网盘内嵌窗口（右上角入口调起）：
 * 直接把夸克网盘原网页调到软件里，经本地反向代理去除嵌入限制，
 * 登录态保存在代理会话中，关闭再打开无需重复登录。
 */
export function NetdiskDialog() {
  const open = useAppStore((s) => s.netdiskOpen)
  const setOpen = useAppStore((s) => s.setNetdiskOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[1600px] flex-col gap-3 overflow-hidden p-3 sm:p-4">
        <DialogHeader className="shrink-0 space-y-0.5 text-left">
          <DialogTitle className="text-base font-bold">夸克网盘</DialogTitle>
          <DialogDescription className="text-xs">
            已内嵌夸克网盘原网页 · 未登录时请在页面内登录（登录态保存在本机会话，重开无需再登）
          </DialogDescription>
        </DialogHeader>
        <WebEmbed
          src={QUARK_PROXY_URL}
          externalUrl={QUARK_URL}
          title="夸克网盘"
          host="pan.quark.cn"
          hint="上传 / 下载 / 分享与官网一致"
          className="min-h-0 flex-1"
        />
      </DialogContent>
    </Dialog>
  )
}
