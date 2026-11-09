/**
 * 壁纸工坊 · NSIS 安装器定制钩子（electron-builder include）
 *
 * ① 覆盖安装自愈（customInit）：
 *    旧版（≤1.2.2）卸载器在含中文的安装路径（如 E:\壁纸工坊\）下自校验失败，
 *    electron-builder 原生流程会静默重试旧卸载器 5 次、全部失败后弹错误框，
 *    用户被迫「手动删除整个目录」才能重装 —— 即「卸载总坏」的根因。
 *    本钩子在原生 uninstallOldVersion 之前抢先自愈：
 *      1) 旧卸载器存在 → 复制到临时目录静默同步执行一次（--updated 保留用户数据）
 *      2) 执行失败 / 卸载器缺失 / 目录仍有残留 → 直接 RMDir /r 清空旧目录
 *      3) 抹掉旧版卸载注册表键 → 原生流程视为全新安装，无感继续
 *    （NSIS Unicode 构建，中文路径本身可正常处理；清理由新安装器执行，
 *     不经过旧卸载器的校验逻辑，故中文路径下同样自愈。）
 *
 * ② 卸载兜底（customUnInstall）：
 *    卸载收尾时再清一次 $INSTDIR（应用正在运行等场景下个别文件第一遍删不掉），
 *    确保安装目录无残留。用户数据目录由 deleteAppDataOnUninstall 管理。
 */

!include LogicLib.nsh

!macro customInit
  ; customInit 在 .onInit 内、initMultiUser 之后执行：
  ; $perUserInstallationFolder 已由 initMultiUser 从注册表读出（本应用为 per-user 安装）
  InitPluginsDir

  ${If} $perUserInstallationFolder != ""
    ; ---------- ① 静默执行旧卸载器（一次即可，不重试） ----------
    ${If} ${FileExists} "$perUserInstallationFolder\uninstall.exe"
      ClearErrors
      CopyFiles /SILENT "$perUserInstallationFolder\uninstall.exe" "$PLUGINSDIR\wf-old-uninstall.exe"
      ${If} ${FileExists} "$PLUGINSDIR\wf-old-uninstall.exe"
        ; _?= 使卸载器同步执行且不删除自身（便于执行后统一清理）
        ExecWait '"$PLUGINSDIR\wf-old-uninstall.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$perUserInstallationFolder' $R0
      ${Else}
        StrCpy $R0 1 ; 卸载器复制失败（被占用 / 权限）→ 视同卸载失败
      ${EndIf}
      Delete "$PLUGINSDIR\wf-old-uninstall.exe"
      Delete "$perUserInstallationFolder\uninstall.exe"
    ${EndIf}

    ; ---------- ② 兜底清理旧目录残留（无论①结果如何） ----------
    ${If} ${FileExists} "$perUserInstallationFolder\*.*"
      RMDir /r "$perUserInstallationFolder"
    ${EndIf}

    ; ---------- ③ 抹掉旧版注册表 → 后续按全新安装继续 ----------
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
    DeleteRegKey HKCU "Software\${APP_GUID}"
  ${EndIf}
!macroend

!macro customUnInstall
  ; 卸载收尾兜底：再清一次安装目录残留（应用运行中卸载时个别文件会占用失败）
  ${If} ${FileExists} "$INSTDIR\*.*"
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend
