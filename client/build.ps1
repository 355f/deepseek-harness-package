# DeepSeek Harness 便携客户端 —— 一键打包脚本
# 用法（本地或 GitHub Actions Windows runner）：
#   powershell -ExecutionPolicy Bypass -File build.ps1 [-Version 0.1.0-rc.7]
# 从零产出单文件便携 exe（含 dsh 运行时 + Electron 壳 + 自动更新能力）

param(
  [string]$Version = ""          # 目标 dsh 版本，留空则取 npm 最新
)

$ErrorActionPreference = "Stop"
# 路径解析（关键坑）：GitHub Actions 把 powershell 步骤包成 `powershell -command ". '脚本'"`（点源执行），
# 此时 $PSScriptRoot / $MyInvocation.MyCommand.Path / $PWD 都不可靠。CI 下最稳妥的锚点是
# 环境变量 $env:GITHUB_WORKSPACE（恒等于仓库 checkout 根目录）；本地运行回退到脚本真实路径/当前目录。
$RepoRoot = $env:GITHUB_WORKSPACE
if (-not $RepoRoot -or -not (Test-Path (Join-Path $RepoRoot "client"))) {
  if ($MyInvocation.MyCommand.Path) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
  } elseif ($PSScriptRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  } else {
    $RepoRoot = $PWD.ProviderPath
  }
}
$Client = Join-Path $RepoRoot "client"
$ScriptDir = Join-Path $Client "build"
$Root = $RepoRoot
if (-not (Test-Path $Client)) { throw "无法定位 client 目录: RepoRoot=$RepoRoot" }
Write-Host "RepoRoot=$RepoRoot"
$Staging = Join-Path $Client "staging-clean"
$OutDir = Join-Path $Root "build-output"

# 第三方 LLM SDK（无 @deepseek-ai 依赖，可安全删除以减小体积）
$SdkToPrune = @("@mistralai", "@google", "@anthropic-ai", "@aws-sdk",
                "@aws-crypto", "@smithy", "@aws", "openai")

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 1. 准备运行时依赖树
# ---------------------------------------------------------------------------
Step "准备 dsh 运行时依赖"
$Runtime = Join-Path $Client "dsh-runtime"
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

# 若尚无 node_modules 则安装（npm 解析 @deepseek-ai/dsh 完整依赖树）
$PkgJson = Join-Path $Runtime "package.json"
if (-not (Test-Path $PkgJson)) {
  @'
{"name":"dsh-runtime","private":true,"version":"1.0.0"}
'@ | Set-Content -Path $PkgJson -Encoding UTF8
}
$DshSpec = "@deepseek-ai/dsh"
if ($Version) { $DshSpec = "@deepseek-ai/dsh@$Version" }
Write-Host "安装 $DshSpec ..."
Push-Location $Runtime
try { npm install $DshSpec --no-audit --no-fund --prefer-offline } finally { Pop-Location }

# 解析实际安装到的版本号
$DshPkg = Join-Path $Runtime "node_modules\@deepseek-ai\dsh\package.json"
if (-not (Test-Path $DshPkg)) { throw "dsh 安装失败：未找到 $DshPkg" }
$InstalledVersion = (Get-Content $DshPkg -Raw | ConvertFrom-Json).version
Write-Host "dsh 版本：$InstalledVersion"

# ---------------------------------------------------------------------------
# 2. 准备 Electron 壳
# ---------------------------------------------------------------------------
Step "准备 Electron"
$ElectronDir = Join-Path $Client "electron"
New-Item -ItemType Directory -Force -Path $ElectronDir | Out-Null
if (-not (Test-Path (Join-Path $ElectronDir "package.json"))) {
  @'
{"name":"electron-shell","private":true,"version":"1.0.0"}
'@ | Set-Content -Path (Join-Path $ElectronDir "package.json") -Encoding UTF8
}
Push-Location $ElectronDir
try { npm install electron@43.4.0 --no-audit --no-fund --prefer-offline } finally { Pop-Location }
$ElectronDist = Join-Path $ElectronDir "node_modules\electron\dist"
# CI 的 npm 缓存有时会跳过 electron 的 postinstall 二进制下载（dist/electron.exe 缺失），
# 这里显式运行 electron 自带 install.js 强制下载，避免“Electron 二进制缺失”导致构建失败。
if (-not (Test-Path (Join-Path $ElectronDist "electron.exe"))) {
  Write-Host "Electron 二进制缺失，显式运行 install.js 下载..."
  $env:ELECTRON_SKIP_BINARY_DOWNLOAD = "0"
  Push-Location $ElectronDir
  try { node (Join-Path $ElectronDir "node_modules\electron\install.js") } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $ElectronDist "electron.exe"))) { throw "Electron 二进制缺失（下载失败）" }

# ---------------------------------------------------------------------------
# 2b. 生成图标（若本地缺失，CI 通常会走到这里）
# ---------------------------------------------------------------------------
Step "生成图标（如缺失）"
if (-not (Test-Path (Join-Path $Client "build\icon.ico"))) {
  Write-Host "icon.ico 缺失，尝试生成..."
  Push-Location $Root
  try {
    npm install sharp --no-audit --no-fund --prefer-offline 2>&1 | Out-Null
    node (Join-Path $Client "build" "generate-icon.js")
  } finally { Pop-Location }
} else {
  Write-Host "icon.ico 已存在，跳过生成"
}

# ---------------------------------------------------------------------------
# 3. 组装 staging（Electron 壳 + app + dsh 运行时）
# ---------------------------------------------------------------------------
Step "组装 staging"
if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
$App = Join-Path $Staging "app"
New-Item -ItemType Directory -Force -Path (Join-Path $App "resources\app\build") | Out-Null

# 3a. Electron 分发文件 → 根
Copy-Item -Path (Join-Path $ElectronDist "*") -Destination $App -Recurse -Force
Remove-Item -Force (Join-Path $App "resources\default_app.asar") -ErrorAction SilentlyContinue
Rename-Item (Join-Path $App "electron.exe") "DeepSeek Harness.exe"

# 3b. 应用源码 + 图标
Copy-Item (Join-Path $Client "main.js") (Join-Path $App "resources\app\main.js")
Copy-Item (Join-Path $Client "updater.js") (Join-Path $App "resources\app\updater.js")
Copy-Item (Join-Path $Client "package.json") (Join-Path $App "resources\app\package.json")
# 嵌入 app 的版本号强制同步为实际 dsh 版本，保证与 Release tag / exe 文件名一致
$PkgDst = Join-Path $App "resources\app\package.json"
$PkgObj = Get-Content $PkgDst -Raw | ConvertFrom-Json
$PkgObj.version = $InstalledVersion
$PkgObj | ConvertTo-Json -Depth 10 | Set-Content -Path $PkgDst -Encoding UTF8
Copy-Item (Join-Path $Client "build\icon.ico") (Join-Path $App "resources\app\build\icon.ico")
Copy-Item (Join-Path $Client "build\icon.png") (Join-Path $App "resources\app\build\icon.png")

# 3c. dsh 运行时
$DstNm = Join-Path $App "resources\dsh-runtime\node_modules"
New-Item -ItemType Directory -Force -Path $DstNm | Out-Null
Copy-Item -Path (Join-Path $Runtime "node_modules\*") -Destination $DstNm -Recurse -Force

# ---------------------------------------------------------------------------
# 4. 裁剪体积
# ---------------------------------------------------------------------------
Step "裁剪体积"
# node-pty：仅保留 win32-x64 预编译，删除其他平台 + 编译源码
$Np = Join-Path $DstNm "node-pty"
foreach ($p in @("darwin-x64", "win32-arm64")) {
  Remove-Item -Recurse -Force (Join-Path $Np "prebuilds\$p") -ErrorAction SilentlyContinue
}
foreach ($d in @("third_party", "deps", "build")) {
  Remove-Item -Recurse -Force (Join-Path $Np $d) -ErrorAction SilentlyContinue
}
# 无依赖的第三方 LLM SDK
foreach ($s in $SdkToPrune) {
  Remove-Item -Recurse -Force (Join-Path $DstNm $s) -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 5. 定位 NSIS（makensis）
# ---------------------------------------------------------------------------
Step "定位 NSIS"
$Makensis = Get-Command makensis -ErrorAction SilentlyContinue
if ($Makensis) {
  $MakensisExe = $Makensis.Source
} else {
  $Candidates = @(
    "$env:LOCALAPPDATA\electron-builder\Cache\nsis-3.0.4.1",
    "C:\Program Files (x86)\NSIS\Bin",
    "C:\Program Files (x86)\NSIS"
  )
  $Found = $null
  foreach ($c in $Candidates) {
    if (Test-Path $c) {
      $Found = Get-ChildItem -Path $c -Filter makensis.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($Found) { break }
    }
  }
  if ($Found) { $MakensisExe = $Found.FullName }
  else { throw "未找到 makensis.exe（请安装 NSIS 或 choco install nsis -y）" }
}
Write-Host "makensis: $MakensisExe"

# ---------------------------------------------------------------------------
# 6. 生成 NSIS 脚本并编译
# ---------------------------------------------------------------------------
Step "编译 NSIS"
$Nsi = @"
Unicode True
!define APP_VERSION "$InstalledVersion"
!define EXTRACT_TAG "`${APP_VERSION}"
Name "DeepSeek Harness"
OutFile "DeepSeek-Harness-`${APP_VERSION}-portable.exe"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "icon.ico"
SilentInstall silent
AutoCloseWindow true
!define MARKER ".extracted-`${EXTRACT_TAG}"
Section
  StrCpy `$0 "`$LOCALAPPDATA\DeepSeek Harness\app-`${EXTRACT_TAG}"
  SetOutPath "`$0"
  IfFileExists "`$0\`${MARKER}" launch
  File /r "..\staging-clean\app\*"
  FileOpen `$1 "`$0\`${MARKER}" w
  FileWrite `$1 "extracted `${EXTRACT_TAG}"
  FileClose `$1
launch:
  Exec '"`$0\DeepSeek Harness.exe" --portable-exe="`$EXEPATH"'
SectionEnd
"@
$NsiPath = Join-Path $Client "build\portable.gen.nsi"
Set-Content -Path $NsiPath -Value $Nsi -Encoding ASCII

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Push-Location (Join-Path $Client "build")
try {
  & $MakensisExe $NsiPath
  if ($LASTEXITCODE -ne 0) { throw "makensis 编译失败，exit=$LASTEXITCODE" }
} finally { Pop-Location }

$Exe = Join-Path $Client "build\DeepSeek-Harness-$InstalledVersion-portable.exe"
if (-not (Test-Path $Exe)) { throw "未产出 exe" }
Copy-Item $Exe (Join-Path $OutDir "DeepSeek-Harness-$InstalledVersion-portable.exe") -Force

Step "完成"
Write-Host "产物：$OutDir\DeepSeek-Harness-$InstalledVersion-portable.exe"
Write-Host "VERSION=$InstalledVersion"
