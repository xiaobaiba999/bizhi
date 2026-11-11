/**
 * 壁纸工坊 · NSIS 定制脚本（electron-builder include，安装器与卸载器共用）
 *
 * v1.4.2 升级数据保护（对应「屏蔽记录随版本丢失」的三重修复）：
 *  ① 升级护送：跑旧版静默卸载器之前，把用户数据目录（%APPDATA%\壁纸工坊，
 *     屏蔽/下载数据库所在）改名转移到 .wf-upgrade-backup，安装完成后原样放回 ——
 *     无论旧卸载器做什么都删不到数据；安装器崩溃/中断没放回的，由桌面主进程
 *     启动时自动恢复（desktop/main.js，按数据库体积择优）。
 *  ② 转移失败（目录被占用）→ 跳过旧版静默卸载：改名旧卸载器使其无法启动
 *     （仍失败则清掉卸载注册表值），改用「外科清理」——只清安装目录内文件，
 *     绝不碰用户数据。
 *  ③ 卸载器：仅用户主动勾选「同时删除应用数据」时才删数据；
 *     静默卸载（升级链路）永不删除。
 *
 * 另含覆盖安装自愈（v1.2.4）：旧卸载器未完成/失败时不弹错中止安装，
 * 自动清理安装目录残留后继续。
 *
 * 宏展开时机说明（勿改结构）：
 *  - customInit / customInstall / customUnInstallCheck 等官方钩子在
 *    .onInit / 安装分节 / handleUninstallResult 内展开（位于全部标准 include 之后，
 *    LogicLib / nsExec 可用）；
 *  - 独立 Function（wfDoEscort / 页面函数）统一定义在 customPageAfterChangeDir
 *    与 customUnWelcomePage 的展开体内（顶层位置，晚于 MUI2 / common.nsh），
 *    否则会在 LogicLib 定义之前编译函数体导致报错。
 */

/* ------------------------- 全局变量（按构建侧分别声明，避免 -WX 未引用警告） ------------------------- */

/* 安装器侧：升级护送状态（仅在安装器构建中引用） */
!ifndef BUILD_UNINSTALLER
  Var wfDataEscorted   ; 0=未护送 1=已护送待恢复 2=转移失败→跳过静默卸载
  Var wfDataDir        ; 用户数据目录（Electron userData = %APPDATA%\壁纸工坊）
  Var wfBackupDir      ; 护送临时位置（.wf-upgrade-backup）
  Var wfOldInstallDir  ; 旧版安装目录（注册表 InstallLocation）
!endif

/* 卸载器侧：删除数据勾选（仅在卸载器构建中引用） */
!ifdef BUILD_UNINSTALLER
  Var wfDelData        ; 是否删除应用数据（勾选框 / --delete-app-data）
  Var wfDelDataCk      ; 勾选框控件句柄
!endif

/* ------------------------- 安装器：升级护送 ------------------------- */

!macro customInit
  StrCpy $wfDataEscorted "0"
  StrCpy $wfDataDir ""
  StrCpy $wfBackupDir ""
  StrCpy $wfOldInstallDir ""
  ; 静默升级（/S，无页面流程）→ 直接护送；交互安装由「升级保护页」触发
  ${if} ${Silent}
    Call wfDoEscort
  ${endif}
!macroend

/**
 * 展开于「选择安装目录」页之后、安装分节之前（顶层）：
 * 定义护送函数 + 升级保护页 + 取消恢复钩子，并注册页面。
 */
!macro customPageAfterChangeDir
  !include "nsDialogs.nsh"

  /**
   * 升级护送主体：检测旧版 → 请应用退出（解锁数据库）→ 数据目录改名到安全位置。
   * 转移失败 → 置 2 并使旧卸载器无法启动（改名 / 清卸载注册表值）。
   */
  Function wfDoEscort
    ${if} $wfDataEscorted != "0"
      Return
    ${endif}

    StrCpy $wfDataDir "$APPDATA\${PRODUCT_FILENAME}"
    StrCpy $wfBackupDir "$APPDATA\${PRODUCT_FILENAME}.wf-upgrade-backup"

    ; Electron 数据目录始终在当前用户名下（即便按全机器安装）
    SetShellVarContext current

    ; 检测旧版安装（卸载注册表；当前用户优先，再查全机器）
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${if} $0 == ""
      ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${endif}
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${if} $0 == ""
        ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
      ${endif}
    !endif
    ${if} $0 == ""
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
      Return ; 全新安装：无需护送
    ${endif}

    ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${if} $1 == ""
      ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${endif}
    StrCpy $wfOldInstallDir "$1"

    ; 上次护送中断的自愈：数据目录不在但备份在 → 维持护送态，安装完成后恢复
    ${unless} ${FileExists} "$wfDataDir"
      ${if} ${FileExists} "$wfBackupDir"
        StrCpy $wfDataEscorted "1"
      ${endif}
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
      Return
    ${endif}

    ; 数据目录与护送副本同时存在（上次护送中断遗留，如安装中被取消/断电）：
    ; 副本停放让位（应用启动时按数据库体积择优处理），本次护送照常进行
    ${if} ${FileExists} "$wfBackupDir"
      RMDir /r "$APPDATA\${PRODUCT_FILENAME}.wf-upgrade-parked"
      ClearErrors
      Rename "$wfBackupDir" "$APPDATA\${PRODUCT_FILENAME}.wf-upgrade-parked"
      ClearErrors
    ${endif}

    ; 应用仍在运行会锁住数据库文件 → 先请它退出（与安装分节内的检查等价，提前做）
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $2
    Sleep 600

    ; 护送：改名转移（失败自动重试两次，等待进程句柄释放）
    ClearErrors
    Rename "$wfDataDir" "$wfBackupDir"
    ${if} ${Errors}
      Sleep 900
      ClearErrors
      Rename "$wfDataDir" "$wfBackupDir"
    ${endif}
    ${if} ${Errors}
      Sleep 1800
      ClearErrors
      Rename "$wfDataDir" "$wfBackupDir"
    ${endif}

    ${if} ${Errors}
      ; 转移失败（目录被占用）→ 跳过静默卸载，改走外科清理：
      ; 改名旧卸载器使其无法启动（启动失败 → 自愈钩子外科清理安装目录）
      StrCpy $wfDataEscorted "2"
      DetailPrint `wf: 数据目录被占用，跳过旧版静默卸载，安装时外科清理（不触碰用户数据）`
      ${if} $wfOldInstallDir != ""
        ClearErrors
        Rename "$wfOldInstallDir\${UNINSTALL_FILENAME}" "$wfOldInstallDir\${UNINSTALL_FILENAME}.wf-skip"
        ${if} ${Errors}
          ; 连旧卸载器都无法改名（锁定）→ 最后手段：清掉卸载入口，让旧卸载器不被触发
          DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
          DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
          !ifdef UNINSTALL_REGISTRY_KEY_2
            DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
          !endif
        ${endif}
      ${endif}
    ${else}
      StrCpy $wfDataEscorted "1"
      DetailPrint `wf: 已护送用户数据目录 → $wfBackupDir`
    ${endif}

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  FunctionEnd

  ; 升级保护页：让用户看到数据正在被保护（无旧版/无数据时自动跳过）
  Function wfUpgradeGuardPage
    Call wfDoEscort
    ${if} $wfDataEscorted == "0"
      Abort ; 无旧版或无用户数据：跳过本页
    ${endif}
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 4u 100% 18u "升级保护已开启"
    Pop $0
    ${if} $wfDataEscorted == "1"
      ${NSD_CreateLabel} 0 30u 100% 72u "您的壁纸数据（屏蔽记录、下载数据库）已临时转移到安全位置，$\r$\n安装期间的旧版卸载步骤无法触碰；$\r$\n安装完成后自动恢复原位。"
    ${else}
      ${NSD_CreateLabel} 0 30u 100% 72u "数据目录暂时被占用（应用可能仍在运行）。$\r$\n安装将跳过旧版卸载步骤，仅清理安装目录内的文件，$\r$\n您的壁纸数据不受任何影响。"
    ${endif}
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Page custom wfUpgradeGuardPage
!macroend

/** 安装完成后：恢复护送的数据目录；清理跳过卸载时的改名残留 */
!macro customInstall
  ${if} $wfDataEscorted == "1"
    SetShellVarContext current
    ClearErrors
    ${if} ${FileExists} "$wfDataDir"
      RMDir "$wfDataDir" ; 仅当空壳目录时成功（理论上不应存在）
      ClearErrors
    ${endif}
    ${if} ${FileExists} "$wfDataDir"
      DetailPrint `wf: 数据目录已存在，护送副本保留在 $wfBackupDir（启动应用时自动恢复）`
    ${else}
      Rename "$wfBackupDir" "$wfDataDir"
      ${if} ${Errors}
        ClearErrors
        DetailPrint `wf: 恢复用户数据目录失败，护送副本保留在 $wfBackupDir（启动应用时自动恢复）`
      ${else}
        DetailPrint `wf: 用户数据目录已恢复原位`
      ${endif}
    ${endif}
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
  ${if} $wfDataEscorted == "2"
    ${if} $wfOldInstallDir != ""
      Delete "$wfOldInstallDir\${UNINSTALL_FILENAME}.wf-skip"
    ${endif}
  ${endif}
!macroend

/* ------------- 覆盖安装自愈（v1.2.4 行为保留并强化） ------------- */

/**
 * 旧卸载器未跑成 / 未完成 / 被跳过时：不弹错误、不中止安装，
 * 外科清理旧安装目录（只清安装目录内文件，绝不碰用户数据）后继续。
 * 展开于 handleUninstallResult（installUtil.nsh）内。
 */
!macro wfUninstallSelfHeal
  ${if} $R0 != 0
  ${orIf} ${Errors}
  ${orIf} $wfDataEscorted == "2"
    DetailPrint `wf: 旧版卸载未正常完成（code=$R0），外科清理安装目录后继续安装`
    ${if} $wfOldInstallDir != ""
      SetOutPath $TEMP
      ClearErrors
      RMDir /r "$wfOldInstallDir"
      ClearErrors
    ${endif}
    ClearErrors
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro wfUninstallSelfHeal
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro wfUninstallSelfHeal
!macroend

/* ------------------------- 卸载器：数据删除改为主动勾选 ------------------------- */

/** 卸载初始化：默认不删数据；仅显式 --delete-app-data 参数才预置删除 */
!macro customUnInit
  StrCpy $wfDelData "0"
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${ifNot} ${Errors}
    StrCpy $wfDelData "1"
  ${endif}
  ClearErrors
!macroend

/**
 * 自定义卸载首页（替换默认欢迎页）：确认 + 「同时删除应用数据」勾选框。
 * 静默卸载（/S，升级链路）不显示任何页面 → 永不删数据。
 */
!macro customUnWelcomePage
  !include "nsDialogs.nsh"
  UninstPage custom un.WfWelcomeCreate un.WfWelcomeLeave

  Function un.WfWelcomeCreate
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 2u 100% 20u "即将卸载 壁纸工坊"
    Pop $0
    ${NSD_CreateLabel} 0 30u 100% 48u "已下载的壁纸文件保存在您自己选择的下载目录中，卸载不会删除它们。$\r$\n如需同时清理本机应用数据（下载数据库、屏蔽记录、设置），请勾选下方选项。"
    Pop $0
    ${NSD_CreateCheckbox} 0 92u 100% 14u "同时删除应用数据（下载数据库、屏蔽记录、设置）"
    Pop $wfDelDataCk
    nsDialogs::Show
  FunctionEnd

  Function un.WfWelcomeLeave
    ${NSD_GetState} $wfDelDataCk $0
    ${if} $0 == 1
      StrCpy $wfDelData "1"
    ${endif}
  FunctionEnd
!macroend

/** 卸载执行：仅在勾选（或显式参数）时删除用户数据目录（与 electron-builder 模板同口径：三个可能的历史命名一并清理） */
!macro customUnInstall
  ${if} $wfDelData == "1"
    SetShellVarContext current
    RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    DetailPrint `wf: 已删除应用数据目录 $APPDATA\${PRODUCT_FILENAME}`
  ${endif}
!macroend
