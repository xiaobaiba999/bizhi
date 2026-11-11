import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "壁纸工坊 · 哲风壁纸",
  description:
    "壁纸工坊：实时获取哲风壁纸高清壁纸，分类浏览、原图预览、单张 / 批量下载，下载过的自动隐藏。支持安装到桌面独立运行，卸载不留残留。",
  applicationName: "壁纸工坊",
  // 页面全局不发 Referer：静态版直连 CDN 图片绕过防盗链（服务端代理模式不受影响）
  referrer: "no-referrer",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "壁纸工坊",
  },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e11d48" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#f7f7f8] dark:bg-background">
        {children}
        <PwaProvider />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
