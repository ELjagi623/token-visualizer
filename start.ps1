# Token Visualizer - PowerShell 启动脚本
# 用法：.\start.ps1 [--no-open] [--port <n>]
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'Token Visualizer'

$minNode = if ($env:TV_MIN_NODE) { $env:TV_MIN_NODE } else { '22.18' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '============================================================'
  Write-Host ' 没有检测到 Node.js，无法启动 Token Visualizer。'
  Write-Host ''
  Write-Host " 请先安装 Node.js（需要 $minNode 或更高版本，建议 LTS）："
  Write-Host '   https://nodejs.org/zh-cn/download'
  Write-Host ' 安装完成后，重新运行 start.ps1 即可。'
  Write-Host '============================================================'
  if (-not $env:TV_NO_PAUSE) { Read-Host '按回车键退出' | Out-Null }
  exit 1
}

$have = [version](& node -p "process.versions.node")
$need = [version]$minNode
if ($have -lt $need) {
  Write-Host ''
  Write-Host '============================================================'
  Write-Host " 当前的 Node.js 版本过低（$have），Token Visualizer 需要 $minNode 或更高版本。"
  Write-Host ' 请升级 Node.js（建议 LTS）：https://nodejs.org/zh-cn/download'
  Write-Host '============================================================'
  if (-not $env:TV_NO_PAUSE) { Read-Host '按回车键退出' | Out-Null }
  exit 1
}

& node (Join-Path $PSScriptRoot 'src/server/index.ts') @args
$rc = $LASTEXITCODE
if ($rc -ne 0) {
  Write-Host ''
  Write-Host "服务已退出，错误码 $rc。请把上面的提示截图或复制给开发者。"
  if (-not $env:TV_NO_PAUSE) { Read-Host '按回车键退出' | Out-Null }
}
exit $rc
