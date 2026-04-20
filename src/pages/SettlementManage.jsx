/**
 * 取引精算（Settlement）統合ビュー — Phase 1
 *
 * 目的:
 *   請求書と KB清算を「取引精算」1画面に統合。ただし内部ロジックは一切統合しない。
 *
 * 分岐ルール（絶対維持）:
 *   - dealers.kbGroup === 'A' or 'B' → KB清算（kickbacks collection）
 *   - dealers.kbGroup === 'C'        → 請求書（invoices collection）
 *
 * Phase 1 スコープ（今回）:
 *   - UI統合のみ。月 × 代理店の既存データを統合一覧表示
 *   - 「詳細を開く」「+ 新規作成」ボタンから既存画面（KickbackManage / InvoiceManage）へ遷移
 *   - 計算ロジック / ステータス遷移 / 既存コレクションは一切変更しない
 *
 * Phase 2（次スプリント以降）:
 *   - 月初自動作成（Cloud Functions、Bカート同期後トリガー）
 *   - 条件付き自動送信（AWS SES、dealers.autoSendInvoice / autoSendKickback フラグ）
 *   - settings/settlement_automation コレクション
 *   - auditLogs（自動作成・自動送信・設定変更）
 *
 * 設計禁止事項（指示書より）:
 *   - KB と請求のロジック統合 → 禁止（既存画面をそのまま呼ぶ）
 *   - Firestoreコレクション統合 → 禁止
 *   - 計算式・ステータス変更 → 禁止
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { canExportSettlement } from '../lib/permissions.js'

function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`

const KB_STATUS_LABEL = {
  draft: '下書き',
  sent: '送信済',
  confirmed: '確定',
  paid: '支払済',
}
const INV_STATUS_LABEL = {
  draft: '下書き',
  sent: '送信済',
  paid: '入金済',
  overdue: '支払期限切れ',
}

export default function SettlementManage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [dealers, setDealers] = useState([])
  const [kickbacks, setKickbacks] = useState([])
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const [month, setMonth] = useState(currentMonth())
  const [dealerFilter, setDealerFilter] = useState('') // '' = 全て

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      const [dealerSnap, kbSnap, invSnap] = await Promise.all([
        getDocs(collection(db, 'allowedEmails')),
        getDocs(query(collection(db, 'kickbacks'), orderBy('month', 'desc'))),
        getDocs(query(collection(db, 'invoices'), orderBy('month', 'desc'))),
      ])
      setDealers(
        dealerSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((d) => d.role === 'dealer' && d.dealerCode),
      )
      setKickbacks(kbSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setInvoices(invSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setErr(e?.message || 'データ取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  // SettlementRow 統合ビュー：月と代理店でフィルタ
  const rows = useMemo(() => {
    const dealerMap = new Map(dealers.map((d) => [d.dealerCode, d]))

    // KB側
    const kbRows = kickbacks
      .filter((k) => !month || k.month === month)
      .filter((k) => !dealerFilter || k.dealerCode === dealerFilter)
      .map((k) => {
        const d = dealerMap.get(k.dealerCode) || {}
        const total = k.finalSettlement
          ?? k.netSettlement
          ?? k.grandTotal
          ?? k.totalKickback
          ?? 0
        return {
          id: k.id,
          type: 'kb',
          dealerCode: k.dealerCode,
          dealerName: k.dealerName || d.companyName || k.dealerCode,
          kbGroup: d.kbGroup || 'A',
          month: k.month,
          total,
          status: k.status || 'draft',
          raw: k,
        }
      })

    // 請求書側（kbGroup === 'C' 想定）
    const invRows = invoices
      .filter((i) => !month || i.month === month)
      .filter((i) => !dealerFilter || i.dealerCode === dealerFilter)
      .map((i) => {
        const d = dealerMap.get(i.dealerCode) || {}
        return {
          id: i.id,
          type: 'invoice',
          dealerCode: i.dealerCode,
          dealerName: i.dealerName || d.companyName || i.dealerCode,
          kbGroup: d.kbGroup || 'C',
          month: i.month,
          total: i.total ?? i.subtotal ?? 0,
          status: i.status || 'draft',
          raw: i,
        }
      })

    return [...kbRows, ...invRows].sort((a, b) => {
      // 月降順、同月内は dealerCode
      const mcmp = (b.month || '').localeCompare(a.month || '')
      if (mcmp !== 0) return mcmp
      return (a.dealerCode || '').localeCompare(b.dealerCode || '')
    })
  }, [dealers, kickbacks, invoices, month, dealerFilter])

  // 該当月 × 該当代理店に既存レコードが無い → 新規作成ボタン
  const missingDealers = useMemo(() => {
    if (!month || !dealerFilter) return null
    const existing = rows.find((r) => r.dealerCode === dealerFilter && r.month === month)
    if (existing) return null
    const d = dealers.find((x) => x.dealerCode === dealerFilter)
    return d || null
  }, [rows, month, dealerFilter, dealers])

  const openDetail = (row) => {
    // 内部分離維持：既存画面にそのまま遷移（月・dealer を query で渡す）
    const params = new URLSearchParams({ dealer: row.dealerCode, month: row.month })
    if (row.type === 'kb') {
      navigate(`/admin/kickback?${params.toString()}`)
    } else {
      navigate(`/admin/invoices?${params.toString()}`)
    }
  }

  const createNew = () => {
    if (!missingDealers) return
    const params = new URLSearchParams({
      dealer: missingDealers.dealerCode,
      month,
    })
    // kbGroup で分岐
    if (missingDealers.kbGroup === 'C') {
      navigate(`/admin/invoices?${params.toString()}`)
    } else {
      navigate(`/admin/kickback?${params.toString()}`)
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">取引精算</h1>
          <p className="text-xs text-gray-500">
            月次の代理店精算を統合表示。KB清算（A/B）と請求書（C）を 1 画面で俯瞰します。
            計算ロジック・ステータス遷移は既存画面を経由します（内部は分離維持）。
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          🔄 再取得
        </button>
      </div>

      {/* Phase 2 予告バナー */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-900">
        <strong>Phase 1 仕様：</strong>
        一覧表示と既存画面への導線のみ。月初自動作成・条件付き自動送信（SES）は Phase 2 で対応予定。
        代理店別の `autoSendInvoice` / `autoSendKickback` / `settlementEmail` 設定は Phase 2 で有効化。
      </div>

      {/* フィルタ */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700">対象月</label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs font-medium text-gray-700">代理店</label>
            <select
              value={dealerFilter}
              onChange={(e) => setDealerFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">全代理店（{dealers.length} 社）</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.dealerCode}>
                  {d.companyName}（{d.dealerCode} / KB={d.kbGroup || 'A'}）
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 新規作成ボタン（月 × 代理店 を指定していて未作成の時のみ） */}
        {missingDealers && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {missingDealers.companyName}（KB={missingDealers.kbGroup || 'A'}）の
                <strong> {month} </strong> は未作成です。
              </span>
              <button
                onClick={createNew}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
              >
                {missingDealers.kbGroup === 'C' ? '+ 請求書を作成' : '+ KB清算を作成'}
              </button>
            </div>
          </div>
        )}
      </div>

      {err && <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{err}</div>}

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">読み込み中...</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          該当する精算データがありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">種別</th>
                  <th className="px-3 py-2 text-left">代理店</th>
                  <th className="px-3 py-2 text-center">KB</th>
                  <th className="px-3 py-2 text-left">対象月</th>
                  <th className="px-3 py-2 text-right">金額</th>
                  <th className="px-3 py-2 text-center">状態</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={`${r.type}:${r.id}`} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      {r.type === 'kb' ? (
                        <span className="rounded bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-800">KB清算</span>
                      ) : (
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">請求書</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{r.dealerName}</div>
                      <div className="font-mono text-[10px] text-gray-400">{r.dealerCode}</div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-mono">{r.kbGroup}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{r.month}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtYen(r.total)}</td>
                    <td className="px-3 py-2 text-center text-xs text-gray-600">
                      {r.type === 'kb' ? (KB_STATUS_LABEL[r.status] || r.status) : (INV_STATUS_LABEL[r.status] || r.status)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => openDetail(r)} className="text-xs text-indigo-600 hover:underline">
                        詳細を開く →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 内部分離の注記 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
        <strong>設計メモ：</strong>
        本画面は UI 統合のみ。Firestore は <code className="rounded bg-white px-1">kickbacks</code>（A/B）と
        <code className="mx-1 rounded bg-white px-1">invoices</code>（C）で完全分離維持。
        計算式・ステータス遷移は既存画面（KickbackManage / InvoiceManage）で実行します。
      </div>
    </div>
  )
}
