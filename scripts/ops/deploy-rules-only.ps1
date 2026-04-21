<#
.SYNOPSIS
    firestore.rules のみを本番 Firebase プロジェクトへデプロイする。

.DESCRIPTION
    rules だけ変更した PR の後、hosting は触らずに rules のみ反映したい時に使う。
    動作：
      1. firebase use が production エイリアスであることを確認
      2. 違えば `firebase use production` に自動切替
      3. firebase deploy --only firestore:rules --dry-run で構文チェック
      4. 問題なければ本番 deploy

.NOTES
    ・AI が叩くスクリプトではない（社長 or CI 専用）
    ・失敗時は exit 1、人に判断を求めない
    ・dry-run を必ず先に通すので安全（構文エラーの本番反映を防ぐ）
    ・単体完結：他 .ps1 への依存なし
#>

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

# ========================================
# Step 1: firebase use 確認 → production に切替
# ========================================
Write-Info '[1/4] firebase use 確認...'
$useBefore = (& firebase use 2>&1 | Out-String).Trim()
Write-Info "現在: $useBefore"

Write-Info '[2/4] firebase use production に切替...'
& firebase use production | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Err 'firebase use production に失敗しました'
    exit 1
}
$useAfter = (& firebase use 2>&1 | Out-String).Trim()
Write-Info "切替後: $useAfter"
if (-not ($useAfter -match 'bomber-admin' -or $useAfter -match 'production')) {
    Write-Err "期待した production プロジェクトに切替できませんでした: $useAfter"
    exit 1
}
Write-Done 'firebase use = production を確認'

# ========================================
# Step 3: dry-run で構文チェック
# ========================================
Write-Info '[3/4] firebase deploy --only firestore:rules --dry-run 実行...'
& firebase deploy --only firestore:rules --dry-run
if ($LASTEXITCODE -ne 0) {
    Write-Err 'firestore:rules の dry-run に失敗しました（構文エラー等）'
    Write-Err '対応: firestore.rules の内容を修正してから再実行してください'
    exit 1
}
Write-Done 'dry-run 成功（構文OK）'

# ========================================
# Step 4: 本番 deploy
# ========================================
Write-Info '[4/4] firebase deploy --only firestore:rules 実行（本番反映）...'
& firebase deploy --only firestore:rules
if ($LASTEXITCODE -ne 0) {
    Write-Err 'firestore:rules デプロイに失敗しました'
    exit 1
}

Write-Host ''
Write-Done '=============================================='
Write-Done 'firestore:rules デプロイ完了（rules のみ本番反映）'
Write-Done '=============================================='
Write-Host ''
Write-Info 'Console: https://console.firebase.google.com/project/bomber-admin/firestore/rules'

exit 0
