import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
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
  title: "壁纸工坊 · 小红书发布 · 夸克网盘",
  description:
    "壁纸工坊：精选高清壁纸，一键发布小红书图文笔记（声明与组件可选），并支持夸克网盘云备份与分享",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#f7f7f8] dark:bg-background">
        {/*
          内嵌网页登录回调救援：登录 SDK 扫码确认后会把 iframe 跳到
          本应用根路径（/?ticket=…，service 为本地 origin 时）。
          此脚本在应用渲染前检测「iframe 内 + 根路径 + 登录票据参数」，
          查询 wv 会话主站后转回 /wv/<主站>/?ticket=… 完成登录。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
var q=location.search;
if(window.self!==window.top&&location.pathname==='/'&&q&&/[?&](ticket|code|token|st|redirect)[=]/i.test(q)){
document.documentElement.style.background='#fff';
fetch('/api/wv-info',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
if(d&&d.host){location.replace('/wv/'+d.host+'/'+q)}
}).catch(function(){})
}
}catch(e){}})()`,
          }}
        />
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
