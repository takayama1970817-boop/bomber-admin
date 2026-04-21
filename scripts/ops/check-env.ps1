<#
.SYNOPSIS
    現在の実行環境を読み取り専用で一覧表示する（診断用）。

.DESCRIPTION
    副作用ゼロ。以下を表示して exit 0 固定。
      - firebase use（現在のプロジェクト）
      - git status --short
      - git log -1 --oneline
      - git branch --show-current
      - .env.local の存在確認（キー名のみ、値は表示しない）
      - node --version / npm --version

    デプロイや同期の前に「今どこにいるか」を確認するために使う。

.NOTES
    ・AI が叩くスクリプトではない（社長 or CI 専用）
    ・読み取り専用・副作用なし
    ・どのコマンドが失敗しても exit 0（診断が目的、全体で止める価値がない）
    ・単体完結：他 .ps1 への依存なし
#>

$ErrorActionPreference = 'Continue'  # 診断用のみ Continue（個別コマンドが落ちても他を表示したい）

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

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '環境診断（check-env.ps1）' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''
Write-Info "作業ディレクトリ: $projectRoot"
Write-Host ''

# ========================================
# [1] firebase use
# ========================================
Write-Host '--- [1] firebase use ---' -ForegroundColor Yellow
try {
    $useOutput = & firebase use 2>&1
    Write-Host ($useOutput | Out-String).Trim()
} catch {
    Write-Warn "firebase CLI が見つかりません or 実行失敗: $_"
}
Write-Host ''

# ========================================
# [2] git status
# ========================================
Write-Host '--- [2] git status --short ---' -ForegroundColor Yellow
try {
    $status = & git status --short 2>&1
    if ($status) {
        Write-Host ($status | Out-String).Trim()
    } else {
        Write-Info 'clean（変更なし）'
    }
} catch {
    Write-Warn "git status 実行失敗: $_"
}
Write-Host ''

# ========================================
# [3] git log -1
# ========================================
Write-Host '--- [3] git log -1 --oneline ---' -ForegroundColor Yellow
try {
    $logLine = & git log -1 --oneline 2>&1
    Write-Host ($logLine | Out-String).Trim()
} catch {
    Write-Warn "git log 実行失敗: $_"
}
Write-Host ''

# ========================================
# [4] git branch
# ========================================
Write-Host '--- [4] git branch --show-current ---' -ForegroundColor Yellow
try {
    $branch = (& git branch --show-current 2>&1 | Out-String).Trim()
    Write-Host $branch
} catch {
    Write-Warn "git branch 実行失敗: $_"
}
Write-Host ''

# ========================================
# [5] .env.local の存在とキー名一覧（値は表示しない）
# ========================================
Write-Host '--- [5] .env.local 内のキー名（値は非表示） ---' -ForegroundColor Yellow
$envLocal = Join-Path $projectRoot '.env.local'
if (Test-Path $envLocal) {
    Write-Info ".env.local 存在: $envLocal"
    $lines = Get-Content $envLocal
    $keys = @()
    foreach ($line in $lines) {
        if ($line -match '^([A-Z0-9_]+)=') {
            $keys += $matches[1]
        }
    }
    if ($keys.Count -eq 0) {
        Write-Warn '.env.local にキーが定義されていません'
    } else {
        Write-Info "定義済みキー数: $($keys.Count)"
        foreach ($k in $keys) {
            Write-Host "  - $k"
        }
    }
} else {
    Write-Warn ".env.local が存在しません（場所: $envLocal）"
    Write-Warn '対応: .env.local.example をコピーして値を入れてください'
}
Write-Host ''

# ========================================
# [6] node / npm バージョン
# ========================================
Write-Host '--- [6] node / npm バージョン ---' -ForegroundColor Yellow
try {
    $nodeVer = (& node --version 2>&1 | Out-String).Trim()
    Write-Host "node: $nodeVer"
} catch {
    Write-Warn "node が見つかりません: $_"
}
try {
    $npmVer = (& npm --version 2>&1 | Out-String).Trim()
    Write-Host "npm:  $npmVer"
} catch {
    Write-Warn "npm が見つかりません: $_"
}
Write-Host ''

# ========================================
# 完了
# ========================================
Write-Host '==============================================' -ForegroundColor Green
Write-Done '環境診断完了（読み取り専用・副作用なし）'
Write-Host '==============================================' -ForegroundColor Green

exit 0
