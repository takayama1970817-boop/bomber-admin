<#
.SYNOPSIS
    本番 Firebase プロジェクトへ firestore.rules と hosting を一括デプロイする。

.DESCRIPTION
    Windows / PowerShell 専用。以下を完全自動で実行する。
      1. firebase use が production エイリアスであることを確認
      2. 違えば `firebase use production` に自動切替
      3. npm run build
      4. firebase deploy --only firestore:rules
      5. firebase deploy --only hosting
    すべて成功すれば exit 0、どこかで失敗すれば exit 1。

.NOTES
    ・AI が叩くスクリプトではない（社長 or CI 専用）
    ・失敗時は exit 1、人に判断を求めない
    ・本番触る前に必ず firebase use を確認する
    ・単体完結：他 .ps1 への依存なし
    ・禁止事項: 対話入力/DRY なし/部分成功で続行 — すべて NG
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
# 作業ディレクトリを bomber-admin プロジェクト直下に寄せる
# （scripts/ops/ から実行しても、プロジェクト直下から実行してもOK）
# ========================================
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir '..\..')
Set-Location $projectRoot
Write-Info "作業ディレクトリ: $projectRoot"

# ========================================
# Step 1: firebase use が production か確認
# ========================================
Write-Info '[1/6] firebase use 確認...'
$useOutput = & firebase use 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "firebase use の実行に失敗しました: $useOutput"
    exit 1
}
$useText = ($useOutput | Out-String).Trim()
Write-Info "現在の firebase use: $useText"

# production エイリアスに切替（既に production なら no-op に近い）
Write-Info '[2/6] firebase use production に切替...'
& firebase use production | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Err 'firebase use production に失敗しました'
    exit 1
}

# 切替結果を再確認。bomber-admin または production の文字列を含むことを期待
$useAfter = (& firebase use 2>&1 | Out-String).Trim()
Write-Info "切替後 firebase use: $useAfter"
if (-not ($useAfter -match 'bomber-admin' -or $useAfter -match 'production')) {
    Write-Err "期待した production プロジェクトに切替できませんでした: $useAfter"
    exit 1
}
Write-Done 'firebase use = production を確認'

# ========================================
# Step 3: npm run build
# ========================================
Write-Info '[3/6] npm run build 実行...'
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Err 'npm run build に失敗しました'
    exit 1
}
Write-Done 'ビルド成功'

# ========================================
# Step 4: firestore:rules デプロイ
# ========================================
Write-Info '[4/6] firebase deploy --only firestore:rules 実行...'
& firebase deploy --only firestore:rules
$rulesExit = $LASTEXITCODE
if ($rulesExit -ne 0) {
    Write-Err "firestore:rules デプロイに失敗しました (exit=$rulesExit)"
    exit 1
}
Write-Done 'firestore:rules デプロイ成功'

# ========================================
# Step 5: hosting デプロイ
# ========================================
Write-Info '[5/6] firebase deploy --only hosting 実行...'
& firebase deploy --only hosting
$hostingExit = $LASTEXITCODE
if ($hostingExit -ne 0) {
    # 部分成功（rules 成功 / hosting 失敗）は「成功/失敗が曖昧な実装」として扱わず、明示的に失敗報告
    Write-Err "hosting デプロイに失敗しました (exit=$hostingExit)"
    Write-Err '状態: firestore:rules は成功、hosting が失敗（部分成功）'
    Write-Err '対応: hosting のみ再デプロイが必要。原因調査後に `firebase deploy --only hosting` を手実行してください'
    exit 1
}
Write-Done 'hosting デプロイ成功'

# ========================================
# Step 6: 完了表示
# ========================================
Write-Info '[6/6] デプロイ完了'
Write-Host ''
Write-Done '=============================================='
Write-Done '本番デプロイ完了（rules + hosting）'
Write-Done '=============================================='
Write-Host ''
Write-Info '本番URL  : https://bomber-admin.web.app'
Write-Info 'Console : https://console.firebase.google.com/project/bomber-admin/overview'

exit 0
