# DSH web 日志落盘启动脚本（诊断用，可随时删除）
# 作用：在 D:\Apps\deepseek-harness 下启动 `pnpm dsh web --no-open`，
#       把 stdout+stderr 用 *>> 实时追加写盘（pwsh 下为 UTF-8，Windows
#       PowerShell 5 下为 UTF-16；Get-Content 均能直接读），方便抓
#       [im-gateway] 审批/交互的实时日志（比手开终端能长期 tail 与搜索）。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File D:\Coding\DSH-Plugin\dsh-im-gateway\scripts\dev-dsh-log.ps1
#
# 注意:
#   - 运行前请先关闭你手动开着的那个 dsh 终端(否则 3080 端口占用,脚本会退出)。
#   - 日志文件: $env:USERPROFILE\.dsh\dsh-im-gateway-dev.log
#     实时查看: Get-Content $env:USERPROFILE\.dsh\dsh-im-gateway-dev.log -Tail 50 -Wait
#   - 这是诊断脚本,与现有 dsh-web.ps1(计划任务守护)互不影响。

$ErrorActionPreference = 'Continue'
$Checkout = 'D:\Apps\deepseek-harness'
$Pnpm     = 'C:\Users\fuqia\AppData\Local\pnpm\bin\pnpm.CMD'
$LogPath  = Join-Path $env:USERPROFILE '.dsh\dsh-im-gateway-dev.log'

if (-not (Test-Path $Checkout)) { Write-Host "checkout 不存在: $Checkout"; exit 1 }

# 端口占用则退出,避免重复实例
try {
    $busy = Test-NetConnection -ComputerName 127.0.0.1 -Port 3080 -WarningAction SilentlyContinue
    if ($busy.TcpTestSucceeded) {
        Write-Host "3080 已被占用。请先关闭你手动开的 dsh 终端,再运行本脚本。"
        exit 0
    }
} catch { /* 探测失败不阻塞 */ }

Set-Location $Checkout
Write-Host "启动 dsh web,日志写往: $LogPath"
# 诊断用:开启 im-gateway 审批/发送链路文件 trace(写 C:\Users\fuqia\.dsh\dsh-im-gateway-trace.log)
$env:DSH_IM_GATEWAY_TRACE = '1'
# 与 dsh-web.ps1 一致的 *>> 行级追加,确保实时落盘可 tail。
& $Pnpm dsh web --no-open *>> $LogPath
