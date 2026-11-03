import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { TabsView } from "@/components/tabs-view"

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <TabsView />
      </main>
      <SiteFooter />
    </div>
  )
}
