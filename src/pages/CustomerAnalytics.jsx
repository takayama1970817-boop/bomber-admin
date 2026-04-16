import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchAllSalonAnalyticsFromBcart, summarizeAnalytics } from '../lib/customerAnalytics.js'
import {
  OUTREACH_TEMPLATES,
  renderTemplate,
  buildGmailComposeUrl,
  buildBulkCsv,
  downloadCsv,
  findTemplate,
} from '../lib/salonOutreach.js'
import { useAuth } from '../contexts/AuthContext.jsx'

const fmtYen = (n) => `¥${Math.round(n || 0).toLocaleString()}`

const RISK_META = {
  safe:  { label: '正常',    color: 'bg-green-100 text-green-800',    dot: 'bg-green-500' },
  watch: { label: '要注意',  color: 'bg-yellow-100 text-yellow-800',  dot: 'bg-yellow-500' },
  warn:  { label: '警告',    color: 'bg-orange-100 text-orange-800',  dot: 'bg-orange-500' },
  lost:  { label: '離脱危険', color: 'bg-red-100 text-red-800',        dot: 'bg-red-500' },
}

const TREND_ICON = { up: '▲', down: '▼', flat: '→' }
const TREND_COLOR = { up: 'text-green-600', down: 'text-red-600', flat: 'text-gray-400' }

function SummaryCard({ label, value, sub, color }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${color || 'text-gray-900'}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  )
}

function RiskChip({ risk }) {
  const m = RISK_META[risk]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  )
}

export default function CustomerAnalytics() {
  const { isAdmin, profile } = useAuth()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [filter, setFilter] = useState('follow') // all | follow | new | top | mine
  const [keyword, setKeyword] = useState('')
  const [sortKey, setSortKey] = useState('daysSinceLast') // daysSinceLast | ltv | avgOrderValue | totalOrders
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [outreachOpen, setOutreachOpen] = useState(false)
  const [tplId, setTplId] = useState('line_30days_soft')
  const [previewIdx, setPreviewIdx] = useState(0)
  const [copiedIdx, setCopiedIdx] = useState(null)
  const [cachedAt, setCachedAt] = useState(null)
  const [progress, setProgress] = useState('')

  const loadData = (forceRefresh = false) => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    setProgress('Bカート 接続中...')
    fetchAllSalonAnalyticsFromBcart({
      months: 12,
      forceRefresh,
      onProgress: (msg) => { if (!cancelled) setProgress(msg) },
    })
      .then(({ list: l, fetchedAt }) => {
        if (!cancelled) {
          setList(l)
          setCachedAt(fetchedAt)
        }
      })
      .catch((e) => {
        console.error(e)
        if (!cancelled) setErr(e?.message || 'データ取得に失敗しました')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setProgress('')
        }
      })
    return () => { cancelled = true }
  }

  useEffect(() => {
    return loadData(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const summary = useMemo(() => summarizeAnalytics(list), [list])

  const toggleOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAllFiltered = (items) => {
    const allSelected = items.every((s) => selectedIds.has(s.id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) items.forEach((s) => next.delete(s.id))
      else items.forEach((s) => next.add(s.id))
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())

  const selectedSalons = useMemo(
    () => list.filter((s) => selectedIds.has(s.id)),
    [list, selectedIds],
  )

  const tpl = findTemplate(tplId) || OUTREACH_TEMPLATES[0]
  const previewSalon = selectedSalons[previewIdx] || selectedSalons[0]
  const previewRendered = previewSalon ? renderTemplate(tpl, previewSalon) : null

  const openOutreach = () => {
    setPreviewIdx(0)
    setOutreachOpen(true)
  }

  const handleOpenAllGmail = () => {
    // 1件ずつタブで開く（Gmail Web の下書き作成）
    // 件数が多いとポップアップブロックされる可能性があるため警告
    const withEmail = selectedSalons.filter((s) => s.email)
    if (withEmail.length === 0) {
      alert('選択中のサロンにメールアドレスが登録されていません')
      return
    }
    if (withEmail.length > 5) {
      const ok = confirm(
        `${withEmail.length}件のGmail下書きを一度に開きます。\nブラウザの「複数ポップアップ許可」が必要です。続行しますか？`,
      )
      if (!ok) return
    }
    withEmail.forEach((s) => {
      const url = buildGmailComposeUrl(s, tpl)
      window.open(url, '_blank')
    })
  }

  const handleDownloadCsv = () => {
    if (selectedSalons.length === 0) return
    const csv = buildBulkCsv(selectedSalons, tpl)
    const ymd = new Date().toISOString().slice(0, 10)
    downloadCsv(csv, `outreach_${tpl.id}_${ymd}.csv`)
  }

  const handleCopy = async (text, idx) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 1500)
    } catch (e) {
      alert('コピーに失敗しました: ' + e.message)
    }
  }

  const filtered = useMemo(() => {
    let arr = list
    if (filter === 'follow') {
      arr = arr.filter((s) => s.risk !== 'safe' || s.totalOrders === 0)
    } else if (filter === 'new') {
      arr = arr.filter((s) => s.isNew)
    } else if (filter === 'top') {
      arr = arr.filter((s) => s.totalOrders > 0)
    } else if (filter === 'mine') {
      arr = arr.filter((s) => s.assignedUid === profile?.uid)
    }

    if (keyword) {
      const k = keyword.toLowerCase()
      arr = arr.filter((s) => s.name?.toLowerCase().includes(k))
    }

    // ソート
    const sorted = [...arr].sort((a, b) => {
      switch (sortKey) {
        case 'ltv':
          return b.totalRevenue - a.totalRevenue
        case 'avgOrderValue':
          return b.avgOrderValue - a.avgOrderValue
        case 'totalOrders':
          return b.totalOrders - a.totalOrders
        case 'daysSinceLast':
        default: {
          // 離脱日数は大きい順（= 未発注が多い順を上に）。null は最後
          const ad = a.daysSinceLastOrder ?? Infinity
          const bd = b.daysSinceLastOrder ?? Infinity
          return bd - ad
        }
      }
    })
    return sorted
  }, [list, filter, keyword, sortKey, profile])

  const filterBtn = (key, label, count) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        filter === key
          ? 'bg-indigo-600 text-white'
          : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1.5 opacity-80">({count})</span>
      )}
    </button>
  )

  const sortBtn = (key, label) => (
    <button
      key={key}
      onClick={() => setSortKey(key)}
      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
        sortKey === key
          ? 'bg-gray-900 text-white'
          : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  )

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        このページは admin / master 権限のみ閲覧できます。
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">顧客分析（サロン）</h1>
          <p className="text-xs text-gray-500">
            LTV・リピート率・離脱リスクを可視化。社内スタッフの次の一手を提示します。
          </p>
        </div>
        <button
          onClick={() => loadData(true)}
          disabled={loading}
          className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          title="Bカートから最新データを再取得"
        >
          🔄 更新
        </button>
      </div>

      {cachedAt && !loading && (
        <div className="text-xs text-gray-500">
          データ取得日時: {cachedAt}（Bカートデータは1日1回取得。最新にするには「🔄 更新」）
        </div>
      )}

      {loading && progress && (
        <div className="rounded-lg bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {progress}
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          集計中...
        </div>
      )}

      {err && !loading && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">
          {err}
        </div>
      )}

      {!loading && !err && (
        <>
          {/* サマリ */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <SummaryCard
              label="登録サロン"
              value={summary.total.toLocaleString()}
              sub={`発注あり ${summary.activeCount} / 新規 ${summary.newCount}`}
            />
            <SummaryCard
              label="平均 LTV"
              value={fmtYen(summary.avgLtv)}
              sub={`累計 ${fmtYen(summary.totalLtv)}`}
            />
            <SummaryCard
              label="リピート率"
              value={`${summary.repeatRate}%`}
              sub={`2回以上発注 ${summary.repeatCount} / ${summary.activeCount}`}
              color={summary.repeatRate >= 60 ? 'text-green-600' : 'text-orange-600'}
            />
            <SummaryCard
              label="フォロー必要"
              value={summary.followNeededCount.toLocaleString()}
              sub={`要注意 ${summary.counts.watch} / 警告 ${summary.counts.warn} / 離脱 ${summary.counts.lost}`}
              color={summary.followNeededCount > 0 ? 'text-red-600' : 'text-gray-900'}
            />
          </div>

          {/* フィルタ + 検索 */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex flex-wrap gap-2">
              {filterBtn('follow', 'フォロー必要', summary.followNeededCount)}
              {filterBtn('new', '新規', summary.newCount)}
              {filterBtn('top', '発注履歴あり', summary.activeCount)}
              {filterBtn('mine', '自分の担当')}
              {filterBtn('all', 'すべて', summary.total)}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="サロン名で検索..."
                className="flex-1 min-w-[200px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-gray-500">並び:</span>
                {sortBtn('daysSinceLast', '離脱日数')}
                {sortBtn('ltv', 'LTV')}
                {sortBtn('avgOrderValue', '平均単価')}
                {sortBtn('totalOrders', '発注回数')}
              </div>
            </div>
          </div>

          {/* 選択アクションバー */}
          {selectedIds.size > 0 && (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-indigo-300 bg-indigo-50 p-3 shadow-sm">
              <div className="text-sm font-medium text-indigo-900">
                🎯 {selectedIds.size} 件のサロンを選択中
              </div>
              <button
                onClick={openOutreach}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
              >
                LINE/メルマガ 下書き生成 →
              </button>
              <button
                onClick={clearSelection}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
              >
                選択解除
              </button>
            </div>
          )}

          {/* テーブル */}
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="w-10 px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-gray-300"
                        checked={
                          filtered.length > 0 &&
                          filtered.every((s) => selectedIds.has(s.id))
                        }
                        onChange={() => toggleAllFiltered(filtered)}
                        title="表示中のすべてを選択/解除"
                      />
                    </th>
                    <th className="px-3 py-2 text-left">サロン名</th>
                    <th className="px-3 py-2 text-right">LTV</th>
                    <th className="px-3 py-2 text-right">発注回数</th>
                    <th className="px-3 py-2 text-right">平均単価</th>
                    <th className="px-3 py-2 text-right">平均間隔</th>
                    <th className="px-3 py-2 text-right">最終発注</th>
                    <th className="px-3 py-2 text-center">推移(90日)</th>
                    <th className="px-3 py-2 text-center">状態</th>
                    <th className="px-3 py-2 text-left">次の一手</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={10} className="py-8 text-center text-xs text-gray-400">
                        該当するサロンがありません
                      </td>
                    </tr>
                  )}
                  {filtered.map((s) => (
                    <tr key={s.id} className={`hover:bg-gray-50 ${selectedIds.has(s.id) ? 'bg-indigo-50/40' : ''}`}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-gray-300"
                          checked={selectedIds.has(s.id)}
                          onChange={() => toggleOne(s.id)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {s.isPseudo ? (
                          <div className="flex items-center gap-2">
                            <span>{s.name}</span>
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              未登録
                            </span>
                          </div>
                        ) : (
                          <Link
                            to={`/salons/${s.id}`}
                            className="text-indigo-600 hover:underline"
                          >
                            {s.name}
                          </Link>
                        )}
                        {s.isNew && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800">
                            新規
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-gray-900">
                        {fmtYen(s.totalRevenue)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {s.totalOrders}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {s.totalOrders > 0 ? fmtYen(s.avgOrderValue) : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {s.avgDaysBetween !== null ? `${s.avgDaysBetween}日` : '-'}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {s.daysSinceLastOrder !== null
                          ? `${s.daysSinceLastOrder}日前`
                          : '未発注'}
                      </td>
                      <td className={`px-3 py-2 text-center font-bold ${TREND_COLOR[s.trend]}`}>
                        {TREND_ICON[s.trend]}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <RiskChip risk={s.risk} />
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">
                        {s.nextAction}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-xs text-indigo-900">
            <strong>使い方：</strong>「フォロー必要」タブから優先度の高いサロンを確認し、「次の一手」列に沿って
            担当スタッフが行動してください。LINE は公式アカウント、メルマガは /admin/newsletter から送信できます。
          </div>
        </>
      )}

      {/* ====== アウトリーチ・モーダル ====== */}
      {outreachOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOutreachOpen(false)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
              <div>
                <div className="text-base font-bold text-gray-900">
                  LINE / メルマガ 下書き生成
                </div>
                <div className="text-xs text-gray-500">
                  選択サロン {selectedSalons.length} 件 ／ テンプレート：{tpl.label}
                </div>
              </div>
              <button
                onClick={() => setOutreachOpen(false)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* ボディ（左：テンプレ選択・対象リスト／右：プレビュー） */}
            <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-[340px_1fr]">
              {/* 左ペイン */}
              <div className="flex flex-col gap-3 overflow-y-auto border-r border-gray-100 p-4">
                <div>
                  <div className="mb-2 text-xs font-bold text-gray-600">
                    テンプレート
                  </div>
                  <div className="space-y-1">
                    {OUTREACH_TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { setTplId(t.id); setPreviewIdx(0) }}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                          t.id === tplId
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-900'
                            : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <div className="font-medium">{t.label}</div>
                        <div className="mt-0.5 text-[10px] text-gray-500">
                          {t.type === 'mail' ? '📧 メール' : '💬 LINE'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-bold text-gray-600">
                    対象サロン（プレビュー切替）
                  </div>
                  <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-1">
                    {selectedSalons.map((s, i) => (
                      <button
                        key={s.id}
                        onClick={() => setPreviewIdx(i)}
                        className={`w-full rounded px-2 py-1.5 text-left text-xs ${
                          i === previewIdx
                            ? 'bg-indigo-100 font-medium text-indigo-900'
                            : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <div className="truncate">{s.name}</div>
                        <div className="text-[10px] text-gray-500">
                          {s.risk === 'lost' ? '離脱' : s.risk === 'warn' ? '警告' : s.risk === 'watch' ? '要注意' : '正常'}
                          ／最終 {s.daysSinceLastOrder ?? '-'}日前
                          {!s.email && tpl.type === 'mail' && ' ／⚠️ メール未登録'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 右ペイン：プレビュー */}
              <div className="flex flex-1 flex-col overflow-hidden">
                {previewRendered ? (
                  <>
                    <div className="border-b border-gray-100 p-4">
                      <div className="text-xs text-gray-500">宛先サロン</div>
                      <div className="text-sm font-bold text-gray-900">
                        {previewSalon.name}
                        {previewSalon.email && (
                          <span className="ml-2 text-xs font-normal text-gray-500">
                            ({previewSalon.email})
                          </span>
                        )}
                      </div>
                      {tpl.type === 'mail' && previewRendered.subject && (
                        <div className="mt-2">
                          <div className="text-xs text-gray-500">件名</div>
                          <div className="text-sm font-medium text-gray-900">
                            {previewRendered.subject}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-800">
{previewRendered.body}
                      </pre>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
                    サロンが選択されていません
                  </div>
                )}
              </div>
            </div>

            {/* フッター：アクション */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3">
              <div className="text-xs text-gray-600">
                {tpl.type === 'mail'
                  ? `📧 Gmail 下書きを開く（メール登録済み ${selectedSalons.filter((s) => s.email).length} 件 / 全 ${selectedSalons.length} 件）`
                  : `💬 LINE 公式配信用のテキスト（コピーまたは CSV で一斉配信ツールへ）`}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {previewRendered && (
                  <button
                    onClick={() => handleCopy(previewRendered.body, previewIdx)}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {copiedIdx === previewIdx ? '✓ コピー済' : 'このサロンのテキストをコピー'}
                  </button>
                )}
                <button
                  onClick={handleDownloadCsv}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  📥 CSV で一括エクスポート
                </button>
                {tpl.type === 'mail' && (
                  <button
                    onClick={handleOpenAllGmail}
                    className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
                  >
                    📧 Gmail 下書きを一括で開く
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
