<#
.SYNOPSIS
    Square Bookings 同期を dry-run または production モードで実行する。

.DESCRIPTION
    scripts/sync-square-bookings.mjs を以下の環境変数付きで起動する。
      - DRY_RUN    : true (dry-run) / false (production)
      - OPERATOR   : 監査ログに残す実行者名

    .env.local の存在を確認し、なければ exit 1。
    node の終了コードをそのまま伝搬（sync-square-bookings.mjs 側の失敗も検知）。

.PARAMETER Mode
    'dry-run' または 'production' のいずれか（必須）

.PARAMETER Operator
    監査ログに残す実行者名（任意、既定: "unknown"）

.EXAMPLE
    # dry-run（書き込みなし）
    .\scripts\ops\sync-square.ps1 -Mode dry-run

.EXAMPLE
    # 本番同期
    .\scripts\ops\sync-square.ps1 -Mode production -Operator "社長 ボンバー"

.NOTES
    ・AI が叩くスクリプトではない（社長 or CI 専用）
    ・失敗時は exit 1、人に判断を求めない
    ・既定値は安全側（Mode 必須、production は明示しないと動かない）
    ・単体完結：他 .ps1 への依存なし（sync-square-bookings.mjs は本スクリプトの目的）
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dry-run', 'production')]
    [string]$Mode,

    [Parameter(Mandatory = $false)]
    [string]$Operator = 'unknown'
)

$ErrorActionPreference = 'Stop'

# ========================================
# ログヘルパー（各 .ps1 にコピペ、DRY より単体完結を優先）
# ========================================
function Write-Info { param($Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Write-Warn { param($Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err  { param($Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Done { param($Msg) Write-Host "[DONE]  $Msg" -ForegroundColor Green }

# ========================================
# 作業ディレクトリをプロジェクト直下に寄せる
# ========================================
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir '..\..')
Set-Location $projectRoot
Write-Info "作業ディレクトリ: $projectRoot"
Write-Info "モード: $Mode"
Write-Info "OPERATOR: $Operator"

# ========================================
# Step 1: 前提ファイル存在確認
# ========================================
Write-Info '[1/3] 前提ファイル確認...'

$envLocal = Join-Path $projectRoot '.env.local'
if (-not (Test-Path $envLocal)) {
    Write-Err '.env.local が見つかりません'
    Write-Err "場所: $envLocal"
    Write-Err '対応: .env.local.example をコピーして SQUARE_* 変数を入れてください'
    exit 1
}
Write-Info '.env.local 存在確認OK'

$syncScript = Join-Path $projectRoot 'scripts\sync-square-bookings.mjs'
if (-not (Test-Path $syncScript)) {
    Write-Err 'scripts/sync-square-bookings.mjs が見つかりません'
    Write-Err "場所: $syncScript"
    exit 1
}
Write-Info 'sync-square-bookings.mjs 存在確認OK'
Write-Done '前提ファイル確認完了'

# ========================================
# Step 2: 環境変数セット → node 実行
# ========================================
Write-Info '[2/3] Square 同期スクリプト起動...'

# Mode → DRY_RUN 文字列へ変換
if ($Mode -eq 'dry-run') {
    $env:DRY_RUN = 'true'
} else {
    $env:DRY_RUN = 'false'
}
$env:OPERATOR = $Operator

Write-Info "DRY_RUN=$($env:DRY_RUN)"
Write-Info "OPERATOR=$($env:OPERATOR)"

# node 実行。終了コードを取得して判定する
& node scripts/sync-square-bookings.mjs
$nodeExit = $LASTEXITCODE

if ($nodeExit -ne 0) {
    Write-Err "Square 同期スクリプトが失敗しました (exit=$nodeExit)"
    exit 1
}

# ========================================
# Step 3: 完了表示
# ========================================
Write-Info '[3/3] 完了'
Write-Host ''
Write-Done '=============================================='
if ($Mode -eq 'dry-run') {
    Write-Done 'Square 同期 DRY RUN 完了（書き込みなし）'
    Write-Info '本番実行するには: -Mode production を指定してください'
} else {
    Write-Done 'Square 同期 本番実行完了'
    Write-Info '監査ログ: Firebase Console → Firestore → squareSyncLogs'
}
Write-Done '=============================================='

exit 0
