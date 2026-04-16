import { useMemo, useState } from 'react'
import {
  Timestamp,
  collection,
  doc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'

const today = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const blankItem = () => ({ name: '', qty: 1, price: 0 })

export default function OrderForm({ salonId, currentLastOrderDate, onSaved, onCancel }) {
  const [orderDate, setOrderDate] = useState(today())
  const [items, setItems] = useState([blankItem()])
  const [memo, setMemo] = useState('')
  const [saving, setSaving] = useState(false)

  const total = useMemo(
    () =>
      items.reduce((sum, it) => {
        const q = Number(it.qty) || 0
        const p = Number(it.price) || 0
        return sum + q * p
      }, 0),
    [items],
  )

  const updateItem = (idx, key, val) => {
    setItems((arr) =>
      arr.map((it, i) => (i === idx ? { ...it, [key]: val } : it)),
    )
  }

  const addItem = () => setItems((arr) => [...arr, blankItem()])
  const removeItem = (idx) =>
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr))

  const save = async () => {
    // バリデーション
    const validItems = items
      .map((it) => ({
        name: it.name.trim(),
        qty: Number(it.qty) || 0,
        price: Number(it.price) || 0,
      }))
      .filter((it) => it.name && it.qty > 0)

    if (validItems.length === 0) {
      alert('商品を1行以上入力してください（商品名と数量は必須）')
      return
    }
    if (!orderDate) {
      alert('発注日を入力してください')
      return
    }

    setSaving(true)
    try {
      // batch write: orders 追加 + salons.lastOrderDate 更新
      const batch = writeBatch(db)
      const orderRef = doc(collection(db, 'orders'))
      const orderDateTs = Timestamp.fromDate(new Date(orderDate))

      batch.set(orderRef, {
        salonId,
        orderDate: orderDateTs,
        total,
        items: validItems,
        memo,
        source: 'manual',
        createdAt: serverTimestamp(),
      })

      // 既存の lastOrderDate より新しい場合のみ更新
      const existingLast = currentLastOrderDate?.toDate
        ? currentLastOrderDate.toDate()
        : currentLastOrderDate
          ? new Date(currentLastOrderDate)
          : null
      const newDate = new Date(orderDate)
      if (!existingLast || newDate > existingLast) {
        batch.update(doc(db, 'salons', salonId), {
          lastOrderDate: orderDateTs,
          updatedAt: serverTimestamp(),
        })
      }

      await batch.commit()
      onSaved?.()
    } catch (e) {
      console.error(e)
      alert('保存に失敗しました: ' + (e?.code || e?.message || ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/30 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">発注を追加</h3>
        <button
          onClick={onCancel}
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          ✕ キャンセル
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-gray-500">発注日</label>
          <input
            type="date"
            value={orderDate}
            onChange={(e) => setOrderDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">合計（自動）</label>
          <div className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-right text-sm font-semibold text-gray-900">
            ¥{total.toLocaleString('ja-JP')}
          </div>
        </div>
      </div>

      <div className="mb-3">
        <label className="mb-2 block text-xs text-gray-500">商品明細</label>
        <div className="space-y-2">
          <div className="grid grid-cols-12 gap-2 text-[10px] uppercase text-gray-400">
            <div className="col-span-6">商品名</div>
            <div className="col-span-2 text-right">数量</div>
            <div className="col-span-3 text-right">単価</div>
            <div className="col-span-1"></div>
          </div>
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <input
                type="text"
                value={it.name}
                onChange={(e) => updateItem(idx, 'name', e.target.value)}
                placeholder="ボンバークリーム"
                className="col-span-6 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="number"
                min="0"
                value={it.qty}
                onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                className="col-span-2 rounded-lg border border-gray-300 bg-white px-2 py-2 text-right text-sm focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="number"
                min="0"
                value={it.price}
                onChange={(e) => updateItem(idx, 'price', e.target.value)}
                className="col-span-3 rounded-lg border border-gray-300 bg-white px-2 py-2 text-right text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => removeItem(idx)}
                disabled={items.length === 1}
                className="col-span-1 rounded-lg border border-gray-300 bg-white text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                title="削除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addItem}
          className="mt-2 text-xs text-indigo-600 hover:underline"
        >
          + 商品を追加
        </button>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs text-gray-500">メモ</label>
        <textarea
          rows={2}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          キャンセル
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? '保存中...' : '発注を保存'}
        </button>
      </div>
    </div>
  )
}
