import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import {
  collection, doc, getDocs, getDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, where, orderBy,
} from 'firebase/firestore'
import { db, functions } from '../lib/firebase.js'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '../contexts/AuthContext.jsx'

const STATUS_LABELS = { draft: '下書き', scheduled: '予約中', sending: '送信中', sent: '送信済' }
const STATUS_COLORS = {
  draft: 'bg-gray-100 text-gray-700',
  scheduled: 'bg-yellow-100 text-yellow-700',
  sending: 'bg-blue-100 text-blue-700',
  sent: 'bg-green-100 text-green-700',
}

const SEGMENT_OPTIONS = [
  { key: 'all', label: 'すべての読者' },
  { key: 'salon', label: 'サロンのみ' },
  { key: 'dealer', label: '代理店のみ' },
]

const fmtDate = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── テンプレート管理 ──
const DEFAULT_TEMPLATES = [
  { id: 'new_product', name: '新商品案内', subject: '【VAVITTE】新商品のご案内', body: '{company}様\n\nいつもお世話になっております。\nこの度、新商品をリリースいたしましたのでご案内申し上げます。\n\n■ 商品名\n{product_name}\n\n■ 特徴\n{description}\n\n■ 価格\n{price}\n\nぜひこの機会にお試しください。\n\n━━━━━━━━━━━━━━━\nロイヤルトラスト株式会社\nVAVITTE事業部\n' },
  { id: 'campaign', name: 'キャンペーン告知', subject: '【VAVITTE】期間限定キャンペーンのお知らせ', body: '{company}様\n\nいつもVAVITTEをご愛顧いただき誠にありがとうございます。\n\n下記の通り、期間限定キャンペーンを開催いたします。\n\n━━━━━━━━━━━━━━━\n■ キャンペーン内容\n{campaign_detail}\n\n■ 期間\n{period}\n\n■ 対象商品\n{products}\n━━━━━━━━━━━━━━━\n\nこの機会をぜひご活用ください。\n\nロイヤルトラスト株式会社\nVAVITTE事業部\n' },
  { id: 'restock', name: '再入荷通知', subject: '【VAVITTE】再入荷のお知らせ', body: '{company}様\n\nいつもお世話になっております。\n\n大変お待たせいたしました。\n下記商品が再入荷いたしましたのでお知らせいたします。\n\n■ 商品名\n{product_name}\n\n在庫に限りがございますので、お早めにご注文ください。\n\nロイヤルトラスト株式会社\nVAVITTE事業部\n' },
]

export default function NewsletterManage() {
  const { isAdmin } = useAuth()
  const [newsletters, setNewsletters] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showEditor, setShowEditor] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [readerCount, setReaderCount] = useState({ all: 0, salon: 0, dealer: 0 })
  const [sendingId, setSendingId] = useState(null)
  const [showLog, setShowLog] = useState(null)
  const [logs, setLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)

  // データ読み込み
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nlSnap, tplSnap, readerSnap] = await Promise.all([
        getDocs(query(collection(db, 'newsletters'), orderBy('createdAt', 'desc'))),
        getDocs(collection(db, 'nl_templates')),
        getDocs(collection(db, 'nl_readers')),
      ])
      setNewsletters(nlSnap.docs.map((d) => ({ id: d.id, ...d.data() })))

      const tpls = tplSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setTemplates(tpls.length > 0 ? tpls : DEFAULT_TEMPLATES)

      const readers = readerSnap.docs.map((d) => d.data())
      const active = readers.filter((r) => r.status === 'active')
      setReaderCount({
        all: active.length,
        salon: active.filter((r) => r.type === 'salon').length,
        dealer: active.filter((r) => r.type === 'dealer').length,
      })
    } catch (e) {
      console.error('メルマガ読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 新規作成
  const handleNew = () => {
    setEditTarget(null)
    setShowEditor(true)
  }

  // 編集
  const handleEdit = (nl) => {
    setEditTarget(nl)
    setShowEditor(true)
  }

  // 保存
  const handleSave = async (data) => {
    if (editTarget) {
      await updateDoc(doc(db, 'newsletters', editTarget.id), { ...data, updatedAt: serverTimestamp() })
      setNewsletters((prev) => prev.map((n) => n.id === editTarget.id ? { ...n, ...data } : n))
    } else {
      const ref = await addDoc(collection(db, 'newsletters'), {
        ...data, status: 'draft', sentCount: 0, openCount: 0, clickCount: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      })
      setNewsletters((prev) => [{ id: ref.id, ...data, status: 'draft', sentCount: 0, openCount: 0, clickCount: 0 }, ...prev])
    }
    setShowEditor(false)
  }

  // 削除
  const handleDelete = async (nl) => {
    if (nl.status === 'sent') { alert('送信済みのメルマガは削除できません'); return }
    if (!confirm(`「${nl.subject}」を削除しますか？`)) return
    await deleteDoc(doc(db, 'newsletters', nl.id))
    setNewsletters((prev) => prev.filter((n) => n.id !== nl.id))
  }

  // 送信
  const handleSend = async (nl) => {
    const seg = SEGMENT_OPTIONS.find((s) => s.key === (nl.segment || 'all'))
    const count = readerCount[nl.segment || 'all'] || 0
    if (!confirm(`「${nl.subject}」を${seg?.label || 'すべて'}（${count}件）に送信しますか？`)) return

    setSendingId(nl.id)
    try {
      const sendFn = httpsCallable(functions, 'sendNewsletter')
      const result = await sendFn({ newsletterId: nl.id })
      const data = result.data
      alert(`送信完了: ${data.sent}件成功 / ${data.failed}件失敗`)
      await updateDoc(doc(db, 'newsletters', nl.id), {
        status: 'sent', sentAt: serverTimestamp(),
        sentCount: data.sent, updatedAt: serverTimestamp(),
      })
      setNewsletters((prev) => prev.map((n) => n.id === nl.id ? { ...n, status: 'sent', sentCount: data.sent } : n))
    } catch (e) {
      console.error('送信エラー:', e)
      alert('送信に失敗しました: ' + e.message)
    } finally {
      setSendingId(null)
    }
  }

  // テスト送信
  const handleTestSend = async (nl) => {
    const testEmail = prompt('テスト送信先メールアドレスを入力:')
    if (!testEmail) return
    setSendingId(nl.id)
    try {
      const sendFn = httpsCallable(functions, 'sendNewsletter')
      await sendFn({ newsletterId: nl.id, testEmail })
      alert(`テスト送信完了: ${testEmail}`)
    } catch (e) {
      alert('テスト送信失敗: ' + e.message)
    } finally {
      setSendingId(null)
    }
  }

  // 配信ログ表示
  const handleShowLog = async (nl) => {
    setShowLog(nl)
    setLogsLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'nl_logs'), where('newsletterId', '==', nl.id)))
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.sentAt?.seconds || 0) - (a.sentAt?.seconds || 0)))
    } catch (e) {
      console.error('ログ読み込みエラー:', e)
    } finally {
      setLogsLoading(false)
    }
  }

  if (!isAdmin) {
    return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">管理者のみ使用可能です</div>
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">メルマガ管理</h1>
          <p className="mt-1 text-sm text-gray-500">メルマガの作成・配信・効果測定</p>
        </div>
        <button onClick={handleNew}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">
          + 新規メルマガ作成
        </button>
      </div>

      {/* サマリー */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">メルマガ数</div>
          <div className="mt-1 text-2xl font-bold">{newsletters.length}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">配信可能読者</div>
          <div className="mt-1 text-2xl font-bold text-green-600">{readerCount.all}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">サロン</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{readerCount.salon}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
          <div className="text-xs text-gray-500">代理店</div>
          <div className="mt-1 text-2xl font-bold text-orange-600">{readerCount.dealer}件</div>
        </div>
      </div>

      {/* メルマガ一覧 */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : newsletters.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          メルマガがありません。「+ 新規メルマガ作成」から始めましょう。
        </div>
      ) : (
        <div className="space-y-3">
          {newsletters.map((nl) => (
            <div key={nl.id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`rounded-full px-3 py-0.5 text-xs font-medium ${STATUS_COLORS[nl.status] || STATUS_COLORS.draft}`}>
                      {STATUS_LABELS[nl.status] || '下書き'}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${
                      nl.format === 'html' ? 'bg-purple-50 text-purple-700' : 'bg-gray-50 text-gray-600'
                    }`}>
                      {nl.format === 'html' ? 'HTML' : 'テキスト'}
                    </span>
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                      {SEGMENT_OPTIONS.find((s) => s.key === (nl.segment || 'all'))?.label || 'すべて'}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-gray-900 truncate">{nl.subject || '（件名なし）'}</h3>
                  <div className="mt-1 text-xs text-gray-400">
                    作成: {fmtDate(nl.createdAt)}
                    {nl.sentAt && <span className="ml-3">送信: {fmtDate(nl.sentAt)}</span>}
                    {nl.scheduledAt && nl.status === 'scheduled' && <span className="ml-3">予約: {fmtDate(nl.scheduledAt)}</span>}
                  </div>
                </div>

                {/* 送信実績 */}
                {nl.status === 'sent' && (
                  <div className="ml-4 flex gap-4 text-center">
                    <div>
                      <div className="text-lg font-bold text-gray-900">{nl.sentCount || 0}</div>
                      <div className="text-[10px] text-gray-400">送信数</div>
                    </div>
                    <div>
                      <div className="text-lg font-bold text-green-600">{nl.openCount || 0}</div>
                      <div className="text-[10px] text-gray-400">開封</div>
                    </div>
                    <div>
                      <div className="text-lg font-bold text-blue-600">{nl.clickCount || 0}</div>
                      <div className="text-[10px] text-gray-400">クリック</div>
                    </div>
                  </div>
                )}
              </div>

              {/* アクション */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {nl.status === 'draft' && (
                  <>
                    <button onClick={() => handleEdit(nl)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                      ✏️ 編集
                    </button>
                    <button onClick={() => handleTestSend(nl)} disabled={sendingId === nl.id}
                      className="rounded-lg border border-blue-300 px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                      🧪 テスト送信
                    </button>
                    <button onClick={() => handleSend(nl)} disabled={sendingId === nl.id}
                      className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                      {sendingId === nl.id ? '送信中...' : '📧 配信する'}
                    </button>
                    <button onClick={() => handleDelete(nl)}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50">
                      🗑 削除
                    </button>
                  </>
                )}
                {nl.status === 'sent' && (
                  <button onClick={() => handleShowLog(nl)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                    📊 配信ログ
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* エディタモーダル */}
      {showEditor && (
        <NewsletterEditor
          newsletter={editTarget}
          templates={templates}
          onClose={() => setShowEditor(false)}
          onSave={handleSave}
        />
      )}

      {/* 配信ログモーダル */}
      {showLog && (
        <LogModal newsletter={showLog} logs={logs} loading={logsLoading} onClose={() => setShowLog(null)} />
      )}
    </div>
  )
}

// ── メルマガエディタ ──
function NewsletterEditor({ newsletter, templates, onClose, onSave }) {
  const [form, setForm] = useState({
    subject: newsletter?.subject || '',
    body: newsletter?.body || '',
    htmlBody: newsletter?.htmlBody || '',
    format: newsletter?.format || 'text',
    segment: newsletter?.segment || 'all',
    fromName: newsletter?.fromName || 'VAVITTE',
    scheduledAt: newsletter?.scheduledAt || '',
  })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const iframeRef = useRef(null)

  const applyTemplate = (tplId) => {
    const tpl = templates.find((t) => t.id === tplId)
    if (tpl) setForm({ ...form, subject: tpl.subject, body: tpl.body })
  }

  const handleSave = async () => {
    if (!form.subject.trim()) { alert('件名を入力してください'); return }
    if (form.format === 'text' && !form.body.trim()) { alert('本文を入力してください'); return }
    if (form.format === 'html' && !form.htmlBody.trim()) { alert('HTML本文を入力してください'); return }
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  // HTMLプレビュー
  useEffect(() => {
    if (preview && form.format === 'html' && iframeRef.current) {
      const doc = iframeRef.current.contentDocument
      doc.open()
      doc.write(form.htmlBody)
      doc.close()
    }
  }, [preview, form.htmlBody, form.format])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-4xl max-h-[95vh] overflow-y-auto rounded-2xl bg-white p-6">
        <h2 className="mb-4 text-xl font-bold text-gray-900">
          {newsletter ? 'メルマガ編集' : '新規メルマガ作成'}
        </h2>

        <div className="space-y-4">
          {/* テンプレート選択 */}
          {!newsletter && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">テンプレートから作成</label>
              <select onChange={(e) => applyTemplate(e.target.value)} defaultValue=""
                className="w-full rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-700">
                <option value="">-- テンプレートを選択 --</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          {/* 形式 */}
          <div className="flex gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="format" value="text" checked={form.format === 'text'}
                onChange={() => setForm({ ...form, format: 'text' })} />
              テキストメール
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="format" value="html" checked={form.format === 'html'}
                onChange={() => setForm({ ...form, format: 'html' })} />
              HTMLメール
            </label>
          </div>

          {/* 配信先セグメント */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">配信先</label>
            <div className="flex gap-2">
              {SEGMENT_OPTIONS.map((s) => (
                <button key={s.key}
                  onClick={() => setForm({ ...form, segment: s.key })}
                  className={`rounded-lg px-4 py-2 text-xs font-medium transition-colors ${
                    form.segment === s.key ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* 差出人名 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">差出人名</label>
            <input type="text" value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>

          {/* 件名 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">件名 *</label>
            <input type="text" value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="例: 【VAVITTE】新商品のご案内"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>

          {/* 本文 */}
          {form.format === 'text' ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">本文 *</label>
              <textarea value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={16}
                placeholder="メール本文を入力...&#10;&#10;差し込み変数: {company} {name} {email}"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none" />
              <div className="mt-1 text-xs text-gray-400">
                差し込み変数: {'{company}'} → 会社名、{'{name}'} → 名前、{'{email}'} → メールアドレス
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-gray-600">HTML本文 *</label>
                <button onClick={() => setPreview(!preview)}
                  className="rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50">
                  {preview ? '✏️ エディタ' : '👁 プレビュー'}
                </button>
              </div>
              {preview ? (
                <iframe ref={iframeRef} className="w-full rounded-lg border border-gray-300" style={{ height: 400 }} />
              ) : (
                <textarea value={form.htmlBody}
                  onChange={(e) => setForm({ ...form, htmlBody: e.target.value })}
                  rows={16}
                  placeholder="<html><body>...</body></html>"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none" />
              )}
            </div>
          )}
        </div>

        <div className="mt-5 flex gap-3">
          <button onClick={onClose}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 hover:bg-gray-50">
            キャンセル
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中...' : '💾 保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 配信ログモーダル ──
function LogModal({ newsletter, logs, loading, onClose }) {
  const successCount = logs.filter((l) => l.status === 'sent').length
  const failedCount = logs.filter((l) => l.status === 'failed').length
  const openedCount = logs.filter((l) => l.openedAt).length
  const clickedCount = logs.filter((l) => l.clickedAt).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <h3 className="mb-2 text-lg font-bold text-gray-900">配信ログ</h3>
        <p className="mb-4 text-sm text-gray-500">{newsletter.subject}</p>

        {/* 集計 */}
        <div className="mb-4 grid grid-cols-4 gap-3">
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-center">
            <div className="text-lg font-bold text-gray-900">{successCount}</div>
            <div className="text-[10px] text-gray-400">送信成功</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-center">
            <div className="text-lg font-bold text-red-600">{failedCount}</div>
            <div className="text-[10px] text-gray-400">送信失敗</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-center">
            <div className="text-lg font-bold text-green-600">{openedCount}</div>
            <div className="text-[10px] text-gray-400">開封</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-center">
            <div className="text-lg font-bold text-blue-600">{clickedCount}</div>
            <div className="text-[10px] text-gray-400">クリック</div>
          </div>
        </div>

        {/* 開封率・クリック率 */}
        {successCount > 0 && (
          <div className="mb-4 flex gap-4 text-sm">
            <span>開封率: <strong>{(openedCount / successCount * 100).toFixed(1)}%</strong></span>
            <span>クリック率: <strong>{(clickedCount / successCount * 100).toFixed(1)}%</strong></span>
          </div>
        )}

        {/* ログ一覧 */}
        {loading ? (
          <div className="py-8 text-center text-sm text-gray-400">読み込み中...</div>
        ) : (
          <div className="overflow-auto rounded-lg border border-gray-200" style={{ maxHeight: 400 }}>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50">
                <tr className="border-b text-left text-gray-500">
                  <th className="px-3 py-2">メール</th>
                  <th className="px-3 py-2">ステータス</th>
                  <th className="px-3 py-2">送信日時</th>
                  <th className="px-3 py-2">開封</th>
                  <th className="px-3 py-2">クリック</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono">{l.email}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 ${
                        l.status === 'sent' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                      }`}>{l.status === 'sent' ? '成功' : '失敗'}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-400">{fmtDate(l.sentAt)}</td>
                    <td className="px-3 py-2">{l.openedAt ? `✅ ${fmtDate(l.openedAt)}` : '—'}</td>
                    <td className="px-3 py-2">{l.clickedAt ? `✅ ${fmtDate(l.clickedAt)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4">
          <button onClick={onClose}
            className="w-full rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 hover:bg-gray-50">
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
