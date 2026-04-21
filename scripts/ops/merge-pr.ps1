<#
.SYNOPSIS
    指定 PR 番号を squash merge し、ブランチを削除する。

.DESCRIPTION
    動作：
      1. -PrNumber 引数必須
      2. gh auth status で認証確認
      3. gh pr view で PR の状態（mergeable）を確認
      4. mergeable != MERGEABLE なら exit 1（衝突解消は手動）
      5. gh pr merge --squash --delete-branch

.PARAMETER PrNumber
    マージする PR 番号（必須）

.EXAMPLE
    .\scripts\ops\merge-pr.ps1 -PrNumber 24

.NOTES
    ・AI が叩くスクリプトではない（社長 or CI 専用）
    ・失敗時は exit 1、人に判断を求めない
    ・衝突解消・approval 確認は事前に済ませておくこと
    ・単体完結：他 .ps1 への依存なし
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$PrNumber
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
Write-Info "対象 PR: #$PrNumber"

# ========================================
# Step 1: gh 認証確認
# ========================================
Write-Info '[1/4] gh auth status 確認...'
& gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Err 'gh CLI が未認証です'
    Write-Err '対応: `gh auth login` で認証してから再実行してください'
    exit 1
}
Write-Done 'gh CLI 認証済み'

# ========================================
# Step 2: PR の状態を確認
# ========================================
Write-Info "[2/4] PR #$PrNumber の状態を確認..."
$prJson = & gh pr view $PrNumber --json state,mergeable,mergeStateStatus,title 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "PR #$PrNumber の取得に失敗しました: $prJson"
    exit 1
}

try {
    $pr = $prJson | ConvertFrom-Json
} catch {
    Write-Err "PR 情報の JSON パースに失敗しました: $_"
    exit 1
}

Write-Info "タイトル : $($pr.title)"
Write-Info "state    : $($pr.state)"
Write-Info "mergeable: $($pr.mergeable)"
Write-Info "merge状態: $($pr.mergeStateStatus)"

# ========================================
# Step 3: マージ可能性チェック
# ========================================
if ($pr.state -ne 'OPEN') {
    Write-Err "PR #$PrNumber は OPEN 状態ではありません（state=$($pr.state)）"
    Write-Err '対応: 既にマージ済み/クローズ済みの可能性。PR を確認してください'
    exit 1
}

if ($pr.mergeable -ne 'MERGEABLE') {
    Write-Err "PR #$PrNumber はマージ不可状態です（mergeable=$($pr.mergeable)）"
    Write-Err '対応: 衝突解消・CI 緑化・レビュー承認を先に済ませてください'
    exit 1
}
Write-Done "PR #$PrNumber はマージ可能"

# ========================================
# Step 4: squash merge + ブランチ削除
# ========================================
Write-Info "[3/4] PR #$PrNumber を squash merge + ブランチ削除..."
& gh pr merge $PrNumber --squash --delete-branch
if ($LASTEXITCODE -ne 0) {
    Write-Err "PR #$PrNumber のマージに失敗しました"
    exit 1
}
Write-Done "PR #$PrNumber マージ完了"

# ========================================
# Step 5: 完了表示
# ========================================
Write-Info '[4/4] 完了確認...'
Write-Host ''
Write-Done '=============================================='
Write-Done "PR #$PrNumber のマージが完了しました"
Write-Done '=============================================='
Write-Host ''
Write-Info "GitHub: https://github.com/takayama1970817-boop/bomber-admin/pull/$PrNumber"

exit 0
