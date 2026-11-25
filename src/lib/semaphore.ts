/**
 * 简易 FIFO 信号量（v1.4.4）：
 * 控制同一时刻最多 N 个「重活」并发执行（如原图回源下载），
 * 其余请求按先来先服务排队，等待超时抛错由调用方转化为友好响应。
 *
 * 动机：批量下载 18 张原图时全部并发回源，会挤占用户上行带宽并触发
 * CDN 限流——缩略图代理跟着超时，网格图片「直接不显示」。
 * 限流后大文件 3 张一批排队走，图片代理与列表接口始终保持秒开。
 */

interface Waiter {
  resolve: () => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface Semaphore {
  /** 占一个槽位：有空位立即成功；否则 FIFO 排队，等待超 maxWaitMs 抛错 */
  acquire(): Promise<void>
  /** 释放一个槽位并唤醒队首 */
  release(): void
  /** 当前并发数 / 排队数（诊断用） */
  readonly stats: { active: number; queued: number }
}

/** 创建并发上限 max 的 FIFO 信号量（排队等待超过 maxWaitMs 抛 DOWNLOAD_QUEUE_TIMEOUT） */
export function createSemaphore(max: number, maxWaitMs: number): Semaphore {
  let active = 0
  const queue: Waiter[] = []

  const pump = () => {
    while (queue.length > 0 && active < max) {
      const w = queue.shift()!
      clearTimeout(w.timer)
      active += 1
      w.resolve()
    }
  }

  return {
    acquire: () =>
      new Promise<void>((resolve, reject) => {
        if (active < max) {
          active += 1
          resolve()
          return
        }
        const w: Waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = queue.indexOf(w)
            if (i !== -1) {
              queue.splice(i, 1)
              w.reject(
                new Error(`DOWNLOAD_QUEUE_TIMEOUT:${Math.round(maxWaitMs / 1000)}`)
              )
            }
          }, maxWaitMs),
        }
        queue.push(w)
      }),
    release: () => {
      active = Math.max(0, active - 1)
      pump()
    },
    get stats() {
      return { active, queued: queue.length }
    },
  }
}
