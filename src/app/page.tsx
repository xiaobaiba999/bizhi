import { WorkshopTab } from "@/components/workshop/workshop-tab"
import { SiteHeader } from "@/components/site/site-header"
import { SiteFooter } from "@/components/site/site-footer"

/**
 * 壁纸工坊主页面（v1.4.6 优化版）
 *
 * v1.4.5 修复：游标深度扫描（4 页一组并行、单轮最多 40 页、自动续扫），
 *   无论下载过多少张，永远能扫到未下载的新壁纸；刷新从源站第 1 页
 *   重新深度扫描，并提示「跳过 N 张、载入 M 张」。
 * v1.4.6 优化：刷新强制回源（绕过页缓存）+ 空轮自动续扫最多 200 页；
 *   图片代理对 CDN 永久 404 缩略图负缓存 5 分钟且不再无谓重试。
 */
export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <WorkshopTab />
      </main>
      <SiteFooter />
    </div>
  )
}
