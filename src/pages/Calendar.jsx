import { useState } from 'react'

const CALENDAR_ID = 'lurbkjiegacljh0v92ubc4h8sk@group.calendar.google.com'
const EMBED_URL = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(CALENDAR_ID)}&ctz=Asia%2FTokyo&hl=ja&showTitle=0&showNav=1&showPrint=0&showTabs=1&showCalendars=0`

// Googleカレンダーの予定作成URLを生成
function buildEventUrl({ title, date, startTime, endTime, description, location }) {
  const start = `${date.replace(/-/g, '')}T${startTime.replace(/:/g, '')}00`
  const end = `${date.replace(/-/g, '')}T${endTime.replace(/:/g, '')}00`
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${start}/${end}`,
    ctz: 'Asia/Tokyo',
  })
  if (description) params.set('details', description)
  if (location) params.set('location', location)
  // 指定カレンダーに追加
  params.set('src', CALENDAR_ID)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

export default function Calendar() {
  const today = new Date().toISOString().slice(0, 10)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(today)
  const [startTime, setStartTime] = useState('10:00')
  const [endTime, setEndTime] = useState('11:00')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')

  const handleCreate = () => {
    if (!title.trim()) { alert('タイトルを入力してください'); return }
    const url = buildEventUrl({ title, date, startTime, endTime, description, location })
    window.open(url, '_blank')
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">カレンダー</h1>
        <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
          Googleカレンダーで開く ↗
        </a>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-4">
        {/* カレンダー表示 */}
        <div className="xl:col-span-3">
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white" style={{ height: 'calc(100vh - 160px)' }}>
            <iframe
              src={EMBED_URL}
              className="h-full w-full border-0"
              title="Googleカレンダー"
            />
          </div>
        </div>

        {/* 予定登録フォーム */}
        <div className="xl:col-span-1">
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-bold text-gray-700">予定を追加</h2>

            <label className="mb-1 block text-xs text-gray-500">タイトル *</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="例：サロン訪問"
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />

            <label className="mb-1 block text-xs text-gray-500">日付</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />

            <div className="mb-3 flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-gray-500">開始</label>
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-gray-500">終了</label>
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              </div>
            </div>

            <label className="mb-1 block text-xs text-gray-500">場所</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="例：東京都渋谷区..."
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />

            <label className="mb-1 block text-xs text-gray-500">メモ</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="備考・連絡事項など"
              rows={3}
              className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />

            <button onClick={handleCreate}
              className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">
              Googleカレンダーに追加
            </button>
            <div className="mt-2 text-[10px] text-gray-400 text-center">
              Googleカレンダーが開き、確認後に保存されます
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
