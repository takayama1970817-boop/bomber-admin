import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { assertCan, canManageTraining } from '../lib/permissions.js'
import {
  APPLICATION_TYPE,
  APPLICATION_TYPE_LABEL,
  TRAINER_TYPE,
  TRAINING_STATUS,
  TRAINING_STATUS_LABEL,
  TRAINING_STATUS_COLOR,
  QUICK_FILTERS,
  generateApplicationNumber,
  matchQuickFilter,
} from '../lib/trainingStatus.js'

/**
 * 研修案件 一覧（PR-1）
 * - コレクション: trainingApplications
 * - 新規作成はモーダルから最小項目だけで登録
 * - 絞り込み: 申込区分 / ステータス / 研修種別 / フリーテキスト
 * - 本格的な絞り込み（日付レンジ / 未発行 / 未発送 / 未受取）は PR-4
 */

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const EMPTY_NEW = {
  applicationType: 'head_office_direct',
  trainerType: 'head_office',
  attendeeName: '',
  attendeeContact: '',
  attendeeAffiliation: '',
  salonId: '',
  salonName: '',
  salonRepresentativeName: '',
  dealerCode: '',
  dealerName: '',
  dealerPersonName: '',
  trainingTypeId: '',
  trainingScheduledDate: '',
  instructorId: '', // PR-B: 認定インストラクター（発行時必須）
  instructorName: '', // PR-B: スナップショット
  note: '',
}

export default function TrainingApplications() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [types, setTypes] = useState([])
  const [dealers, setDealers] = useState([])
  const [salons, setSalons] = useState([])
  const [dealerSalonsLinks, setDealerSalonsLinks] = useState([]) // PR-A: 代理店↔サロン紐付け（companyName ベース）
  const [instructors, setInstructors] = useState([]) // PR-B: 認定インストラクター一覧
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newForm, setNewForm] = useState(EMPTY_NEW)
  const [busy, setBusy] = useState(false)

  const [fType, setFType] = useState('all')
  const [fStatus, setFStatus] = useState('all')
  const [fTrainingType, setFTrainingType] = useState('all')
  const [fKeyword, setFKeyword] = useState('')
  // PR-4: クイックフィルタ + 日付レンジ
  const [fQuick, setFQuick] = useState('all')
  const [fAppDateFrom, setFAppDateFrom] = useState('')
  const [fAppDateTo, setFAppDateTo] = useState('')
  const [fTrDateFrom, setFTrDateFrom] = useState('')
  const [fTrDateTo, setFTrDateTo] = useState('')

  const canEdit = canManageTraining(profile)

  async function loadAll() {
    setLoading(true)
    try {
      const [appsSnap, typesSnap, dealersSnap, salonsSnap, linksSnap, instSnap] = await Promise.all([
        getDocs(query(collection(db, 'trainingApplications'), orderBy('applicationDate', 'desc'))),
        getDocs(query(collection(db, 'trainingTypes'), orderBy('sortOrder', 'asc'))),
        getDocs(collection(db, 'dealers')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'salons')).catch(() => ({ docs: [] })),
        // PR-A: dealerSalons（companyName ⇔ dealerCode 紐付け）
        getDocs(collection(db, 'dealerSalons')).catch(() => ({ docs: [] })),
        // PR-B: 認定インストラクター一覧
        getDocs(query(collection(db, 'certifiedInstructors'), orderBy('name', 'asc'))).catch(() => ({ docs: [] })),
      ])
      setRows(appsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setTypes(typesSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setDealers(dealersSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setSalons(salonsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setDealerSalonsLinks(linksSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setInstructors(instSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setMessage(`読み込みエラー: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  const typeById = useMemo(() => {
    const m = {}
    types.forEach((t) => { m[t.id] = t })
    return m
  }, [types])

  // 日付比較ヘルパー（Firestore Timestamp / Date / string を吸収して yyyy-mm-dd 前提で比較）
  function toYmd(ts) {
    if (!ts) return ''
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    if (isNaN(d.getTime())) return ''
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const filtered = useMemo(() => {
    const k = fKeyword.trim().toLowerCase()
    return rows.filter((r) => {
      // PR-4: クイックフィルタ優先適用（「すべて」なら素通り）
      if (!matchQuickFilter(fQuick, r.status)) return false

      if (fType !== 'all' && r.applicationType !== fType) return false
      if (fStatus !== 'all' && r.status !== fStatus) return false
      if (fTrainingType !== 'all' && r.trainingTypeId !== fTrainingType) return false

      // PR-4: 日付レンジ（申込日）
      if (fAppDateFrom || fAppDateTo) {
        const ymd = toYmd(r.applicationDate)
        if (!ymd) return false
        if (fAppDateFrom && ymd < fAppDateFrom) return false
        if (fAppDateTo && ymd > fAppDateTo) return false
      }

      // PR-4: 日付レンジ（研修日 = 実施日優先、なければ予定日で判定）
      if (fTrDateFrom || fTrDateTo) {
        const ymd = toYmd(r.trainingCompletedDate) || toYmd(r.trainingScheduledDate)
        if (!ymd) return false
        if (fTrDateFrom && ymd < fTrDateFrom) return false
        if (fTrDateTo && ymd > fTrDateTo) return false
      }

      if (!k) return true
      const hay = [
        r.applicationNumber, r.attendeeName, r.salonName,
        r.dealerName, r.dealerCode, r.trainingName,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(k)
    })
  }, [rows, fType, fStatus, fTrainingType, fKeyword, fQuick, fAppDateFrom, fAppDateTo, fTrDateFrom, fTrDateTo])

  // PR-A: dealerCode から dealerName を解決（dealers コレクションの companyName / name を優先）
  function dealerNameOf(dealerCode) {
    if (!dealerCode) return ''
    const d = dealers.find((x) => x.dealerCode === dealerCode)
    return d?.companyName || d?.name || d?.dealerName || ''
  }

  // PR-A: salon から dealerCode を解決
  //   1. salon.dealerCode があればそれ
  //   2. なければ dealerSalons を companyName で引き、最新 updatedAt 1件を採用
  function resolveDealerCodeFromSalon(salon) {
    if (!salon) return ''
    if (salon.dealerCode) return salon.dealerCode
    const links = dealerSalonsLinks.filter((l) => l.companyName === salon.companyName)
    if (links.length === 0) return ''
    // updatedAt が無ければ createdAt、それも無ければ 0 で降順
    const ts = (x) => {
      const t = x.updatedAt?.toMillis?.() ?? x.createdAt?.toMillis?.() ?? 0
      return t
    }
    links.sort((a, b) => ts(b) - ts(a))
    return links[0]?.dealerCode || ''
  }

  // PR-A: 自動決定ルール（ログインユーザー > サロン選択 > UI 選択）
  //   1. profile.role === 'dealer' && profile.dealerCode → それを使う（将来の代理店セルフ申込向け）
  //   2. salon 選択済み → resolveDealerCodeFromSalon
  //   3. 上記不可 → UI で選択
  function autoResolveDealerCode({ applicationType, salonId }) {
    if (applicationType !== 'dealer') return ''
    if (profile?.role === 'dealer' && profile?.dealerCode) return profile.dealerCode
    if (salonId) {
      const s = salons.find((x) => x.id === salonId)
      const code = resolveDealerCodeFromSalon(s)
      if (code) return code
    }
    return ''
  }

  function openNew() {
    // PR-A: dealer ロールで開くと applicationType='dealer' + dealerCode 自動セット
    const isDealerUser = profile?.role === 'dealer' && profile?.dealerCode
    const initialApplicationType = isDealerUser ? 'dealer' : 'head_office_direct'
    const initialDealerCode = isDealerUser ? profile.dealerCode : ''
    setNewForm({
      ...EMPTY_NEW,
      applicationType: initialApplicationType,
      trainerType: isDealerUser ? 'dealer' : 'head_office',
      dealerCode: initialDealerCode,
      dealerName: initialDealerCode ? dealerNameOf(initialDealerCode) : '',
    })
    setShowNew(true)
    setMessage('')
  }

  function onSelectSalon(salonId) {
    const s = salons.find((x) => x.id === salonId)
    setNewForm((prev) => {
      // PR-A: サロン選択で dealerCode を自動解決。既に dealerCode 設定済みなら上書きしない
      //   （ログインユーザーが dealer ロール等、優先度の高い自動決定で入った値を尊重）
      let nextDealerCode = prev.dealerCode
      let nextDealerName = prev.dealerName
      if (prev.applicationType === 'dealer' && !prev.dealerCode && s) {
        const resolved = resolveDealerCodeFromSalon(s)
        if (resolved) {
          nextDealerCode = resolved
          nextDealerName = dealerNameOf(resolved)
        }
      }
      return {
        ...prev,
        salonId,
        salonName: s?.companyName || prev.salonName,
        salonRepresentativeName: s?.representativeName || prev.salonRepresentativeName,
        dealerCode: nextDealerCode,
        dealerName: nextDealerName,
      }
    })
  }

  function onSelectDealer(dealerCode) {
    // PR-A: dealerName は手入力せず、選択された dealers レコードから自動取得する
    setNewForm((prev) => ({
      ...prev,
      dealerCode: dealerCode || '',
      dealerName: dealerCode ? dealerNameOf(dealerCode) : '',
    }))
  }

  async function createApplication() {
    try {
      assertCan(canManageTraining, profile, {
        userMessage: '研修案件の作成権限がありません',
      })
      if (!newForm.attendeeName.trim()) {
        setMessage('受講者名は必須です')
        return
      }
      if (!newForm.trainingTypeId) {
        setMessage('研修種別を選択してください')
        return
      }
      if (newForm.applicationType === 'dealer' && !newForm.dealerCode) {
        setMessage('代理店経由の申込では代理店（dealerCode）の選択が必須です。手入力は廃止されました。')
        return
      }
      setBusy(true)
      const selectedType = typeById[newForm.trainingTypeId]
      const scheduled = newForm.trainingScheduledDate
        ? new Date(newForm.trainingScheduledDate)
        : null
      const initialStatus = scheduled
        ? TRAINING_STATUS.TRAINING_SCHEDULED
        : TRAINING_STATUS.APPLICATION_RECEIVED

      const payload = {
        applicationNumber: generateApplicationNumber(),
        applicationDate: serverTimestamp(),
        applicationType: newForm.applicationType,
        trainerType: newForm.trainerType,
        attendeeName: newForm.attendeeName.trim(),
        attendeeContact: newForm.attendeeContact || '',
        attendeeAffiliation: newForm.attendeeAffiliation || '',
        salonId: newForm.salonId || null,
        salonName: newForm.salonName || '',
        salonRepresentativeName: newForm.salonRepresentativeName || '',
        dealerCode: newForm.applicationType === 'dealer' ? (newForm.dealerCode || '') : '',
        dealerName: newForm.applicationType === 'dealer' ? (newForm.dealerName || '') : '',
        dealerPersonName: newForm.applicationType === 'dealer' ? (newForm.dealerPersonName || '') : '',
        dealerReportConfirmed: false,
        dealerReportConfirmedAt: null,
        trainingTypeId: newForm.trainingTypeId,
        trainingTypeCode: selectedType?.code || '',
        trainingName: selectedType?.name || '',
        trainingScheduledDate: scheduled,
        trainingCompletedDate: null,
        // PR-B: 認定インストラクター（未選択でも申込登録は可、発行時に必須チェック）
        instructorId: newForm.instructorId || null,
        instructorName: newForm.instructorName || '',
        status: initialStatus,
        note: newForm.note || '',
        shippedAt: null,
        shippedMethod: '',
        trackingNumber: '',
        receivedAt: null,
        createdAt: serverTimestamp(),
        createdBy: profile?.uid || null,
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      }
      const ref = await addDoc(collection(db, 'trainingApplications'), payload)
      // 初期ステータスを履歴に記録
      await addDoc(collection(db, 'trainingApplications', ref.id, 'history'), {
        from: null,
        to: initialStatus,
        actorUid: profile?.uid || null,
        actorName: profile?.name || profile?.email || '',
        comment: '申込登録',
        createdAt: serverTimestamp(),
      })
      setShowNew(false)
      setMessage(`申込を登録しました: ${payload.applicationNumber}`)
      navigate(`/admin/training-applications/${ref.id}`)
    } catch (e) {
      console.error(e)
      setMessage(`登録エラー: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (!canEdit) {
    return <div className="p-6 text-sm text-red-600">この画面の閲覧権限がありません。</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">研修案件管理</h1>
        <div className="flex gap-2">
          <a
            href="/docs/training-manual.pdf"
            download="VAVITTE研修管理_操作マニュアル.pdf"
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            title="研修管理 操作マニュアル（PDF をダウンロードします）"
          >
            説明書（DL）
          </a>
          <Link
            to="/admin/training-types"
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            研修種別マスタ
          </Link>
          <button
            onClick={openNew}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            + 新規申込
          </button>
        </div>
      </div>

      {/* PR-4: クイックフィルタ（ピル式） */}
      <div className="flex flex-wrap gap-2">
        {QUICK_FILTERS.map((q) => {
          const count = q.key === 'all'
            ? rows.length
            : rows.filter((r) => matchQuickFilter(q.key, r.status)).length
          const isActive = fQuick === q.key
          return (
            <button
              key={q.key}
              onClick={() => setFQuick(q.key)}
              className={`rounded-full border px-3 py-1 text-xs ${
                isActive
                  ? 'border-indigo-600 bg-indigo-600 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {q.label} <span className={`ml-1 ${isActive ? 'text-indigo-100' : 'text-gray-400'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* PR-4: 日付レンジフィルタ */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-white p-3 md:grid-cols-4">
        <label className="block text-sm">
          <span className="text-xs text-gray-500">申込日 From</span>
          <input
            type="date"
            value={fAppDateFrom}
            onChange={(e) => setFAppDateFrom(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-gray-500">申込日 To</span>
          <input
            type="date"
            value={fAppDateTo}
            onChange={(e) => setFAppDateTo(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-gray-500">研修日 From（実施日→予定日の順で判定）</span>
          <input
            type="date"
            value={fTrDateFrom}
            onChange={(e) => setFTrDateFrom(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-gray-500">研修日 To</span>
          <input
            type="date"
            value={fTrDateTo}
            onChange={(e) => setFTrDateTo(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-2 rounded-lg border border-gray-200 bg-white p-3 md:grid-cols-4">
        <label className="block text-sm">
          <span className="text-xs text-gray-500">申込区分</span>
          <select
            value={fType}
            onChange={(e) => setFType(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="all">すべて</option>
            <option value={APPLICATION_TYPE.HEAD_OFFICE_DIRECT}>本社直</option>
            <option value={APPLICATION_TYPE.DEALER}>代理店経由</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-gray-500">ステータス</span>
          <select
            value={fStatus}
            onChange={(e) => setFStatus(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="all">すべて</option>
            {Object.entries(TRAINING_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-gray-500">研修種別</span>
          <select
            value={fTrainingType}
            onChange={(e) => setFTrainingType(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="all">すべて</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-gray-500">キーワード（受講者 / サロン / 代理店 / 申込番号）</span>
          <input
            type="text"
            value={fKeyword}
            onChange={(e) => setFKeyword(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="氏名や会社名で検索"
          />
        </label>
      </div>

      {message && (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {message}
        </div>
      )}

      <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-3 py-2">申込番号</th>
              <th className="px-3 py-2">申込日</th>
              <th className="px-3 py-2">区分</th>
              <th className="px-3 py-2">研修種別</th>
              <th className="px-3 py-2">受講者</th>
              <th className="px-3 py-2">サロン</th>
              <th className="px-3 py-2">代理店</th>
              <th className="px-3 py-2">研修日</th>
              <th className="px-3 py-2">ステータス</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">読み込み中...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-400">
                  {rows.length === 0
                    ? 'まだ研修案件がありません。「+ 新規申込」から登録してください。'
                    : '条件に一致する案件がありません。'}
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr
                key={r.id}
                onClick={() => navigate(`/admin/training-applications/${r.id}`)}
                className="cursor-pointer border-t border-gray-100 hover:bg-gray-50"
              >
                <td className="px-3 py-2 font-mono text-xs">{r.applicationNumber || r.id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(r.applicationDate)}</td>
                <td className="px-3 py-2">{APPLICATION_TYPE_LABEL[r.applicationType] || '—'}</td>
                <td className="px-3 py-2">{r.trainingName || '—'}</td>
                <td className="px-3 py-2">{r.attendeeName || '—'}</td>
                <td className="px-3 py-2">{r.salonName || '—'}</td>
                <td className="px-3 py-2">{r.dealerName || '—'}</td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {r.trainingCompletedDate
                    ? `完了 ${fmtDate(r.trainingCompletedDate)}`
                    : r.trainingScheduledDate
                      ? `予定 ${fmtDate(r.trainingScheduledDate)}`
                      : '—'}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${TRAINING_STATUS_COLOR[r.status] || 'bg-gray-100 text-gray-600'}`}>
                    {TRAINING_STATUS_LABEL[r.status] || r.status || '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-lg font-bold">新規 研修申込</h2>

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-xs text-gray-500">申込区分</span>
                <select
                  value={newForm.applicationType}
                  onChange={(e) => setNewForm({
                    ...newForm,
                    applicationType: e.target.value,
                    trainerType: e.target.value === 'dealer' ? TRAINER_TYPE.DEALER : TRAINER_TYPE.HEAD_OFFICE,
                  })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                >
                  <option value={APPLICATION_TYPE.HEAD_OFFICE_DIRECT}>本社直</option>
                  <option value={APPLICATION_TYPE.DEALER}>代理店経由</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">研修実施主体</span>
                <select
                  value={newForm.trainerType}
                  onChange={(e) => setNewForm({ ...newForm, trainerType: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                >
                  <option value={TRAINER_TYPE.HEAD_OFFICE}>本社</option>
                  <option value={TRAINER_TYPE.DEALER}>代理店</option>
                </select>
              </label>

              <label className="block text-sm">
                <span className="text-xs text-gray-500">研修種別</span>
                <select
                  value={newForm.trainingTypeId}
                  onChange={(e) => setNewForm({ ...newForm, trainingTypeId: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                >
                  <option value="">選択してください</option>
                  {types.filter((t) => t.isActive !== false).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">研修予定日（任意）</span>
                <input
                  type="date"
                  value={newForm.trainingScheduledDate}
                  onChange={(e) => setNewForm({ ...newForm, trainingScheduledDate: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="col-span-2 block text-sm">
                <span className="text-xs text-gray-500">
                  認定インストラクター（発行時必須・選択式）
                  {!newForm.trainingTypeId && <span className="ml-1 text-amber-600">先に研修種別を選んでください</span>}
                </span>
                <select
                  value={newForm.instructorId}
                  onChange={(e) => {
                    const id = e.target.value
                    const inst = instructors.find((x) => x.id === id)
                    setNewForm({
                      ...newForm,
                      instructorId: id,
                      instructorName: inst?.name || '',
                    })
                  }}
                  disabled={!newForm.trainingTypeId}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm disabled:bg-gray-50"
                >
                  <option value="">選択してください</option>
                  {instructors
                    .filter((i) => i.isActive !== false)
                    .filter((i) => !newForm.trainingTypeId
                      || (Array.isArray(i.certifications) && i.certifications.includes(newForm.trainingTypeId)))
                    .map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                </select>
                <span className="mt-1 block text-[11px] text-gray-500">
                  選択した研修種別を担当できるアクティブな講師のみ表示されます（/admin/certified-instructors で管理）。
                </span>
              </label>

              <label className="block text-sm">
                <span className="text-xs text-gray-500">受講者名（必須）</span>
                <input
                  type="text"
                  value={newForm.attendeeName}
                  onChange={(e) => setNewForm({ ...newForm, attendeeName: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">受講者 連絡先</span>
                <input
                  type="text"
                  value={newForm.attendeeContact}
                  onChange={(e) => setNewForm({ ...newForm, attendeeContact: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                  placeholder="メール / 電話"
                />
              </label>
              <label className="col-span-2 block text-sm">
                <span className="text-xs text-gray-500">所属</span>
                <input
                  type="text"
                  value={newForm.attendeeAffiliation}
                  onChange={(e) => setNewForm({ ...newForm, attendeeAffiliation: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>

              <div className="col-span-2 mt-1 border-t border-gray-100 pt-2 text-sm font-semibold text-gray-700">サロン情報</div>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">サロンを選択（任意）</span>
                <select
                  value={newForm.salonId}
                  onChange={(e) => onSelectSalon(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                >
                  <option value="">（未選択・手入力）</option>
                  {salons.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.companyName || s.name || s.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-xs text-gray-500">サロン名</span>
                <input
                  type="text"
                  value={newForm.salonName}
                  onChange={(e) => setNewForm({ ...newForm, salonName: e.target.value, salonId: '' })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
              <label className="col-span-2 block text-sm">
                <span className="text-xs text-gray-500">代表者名</span>
                <input
                  type="text"
                  value={newForm.salonRepresentativeName}
                  onChange={(e) => setNewForm({ ...newForm, salonRepresentativeName: e.target.value })}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>

              {newForm.applicationType === 'dealer' && (
                <>
                  <div className="col-span-2 mt-1 border-t border-gray-100 pt-2 text-sm font-semibold text-gray-700">
                    代理店情報 <span className="text-[11px] font-normal text-gray-500">（PR-A: 手入力は廃止・選択のみ）</span>
                  </div>
                  <label className="block text-sm">
                    <span className="text-xs text-gray-500">代理店（必須・選択）</span>
                    <select
                      value={newForm.dealerCode}
                      onChange={(e) => onSelectDealer(e.target.value)}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                    >
                      <option value="">選択してください</option>
                      {dealers
                        .filter((d) => d.dealerCode)
                        .map((d) => (
                          <option key={d.id} value={d.dealerCode}>
                            [{d.dealerCode}] {d.companyName || d.name || d.dealerName || d.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="block text-sm">
                    <span className="text-xs text-gray-500">代理店名（自動表示）</span>
                    <div className="mt-1 w-full rounded border border-gray-200 bg-gray-50 px-2 py-2 text-sm text-gray-700">
                      {newForm.dealerName || <span className="text-gray-400">未選択</span>}
                    </div>
                  </div>
                  <label className="col-span-2 block text-sm">
                    <span className="text-xs text-gray-500">代理店担当者名（任意・個人名の手入力可）</span>
                    <input
                      type="text"
                      value={newForm.dealerPersonName}
                      onChange={(e) => setNewForm({ ...newForm, dealerPersonName: e.target.value })}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                    />
                  </label>
                </>
              )}

              <label className="col-span-2 block text-sm">
                <span className="text-xs text-gray-500">備考</span>
                <textarea
                  value={newForm.note}
                  onChange={(e) => setNewForm({ ...newForm, note: e.target.value })}
                  rows={2}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                />
              </label>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowNew(false)}
                disabled={busy}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={createApplication}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                登録
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
