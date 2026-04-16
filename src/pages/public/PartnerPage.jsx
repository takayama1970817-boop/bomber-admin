import { useState } from 'react'

const dealerBenefits = [
  {
    title: '高収益モデル',
    desc: '高付加価値のサロン専売品だからこそ実現できる利益率。継続的な収益をお約束します。',
  },
  {
    title: '充実したサポート体制',
    desc: '販促資料・研修・マーケティング支援まで、パートナーの成功を全面的にバックアップ。',
  },
  {
    title: '独自のエリア戦略',
    desc: 'エリアごとの戦略的な展開で、代理店様のビジネスチャンスを最大化します。',
  },
  {
    title: 'ブランド力の向上',
    desc: '結果で選ばれるVAVITTEブランド。導入サロンの満足度98%が信頼の証です。',
  },
]

const salonBenefits = [
  {
    title: 'お客様の満足度向上',
    desc: '「結果が出る」商品だからこそ、施術の付加価値とお客様のリピート率が向上します。',
  },
  {
    title: '差別化メニューの構築',
    desc: 'サロン専売品ならではの限定感で、他店との差別化を実現できます。',
  },
  {
    title: '導入研修・施術サポート',
    desc: '商品の効果を最大限に引き出す施術方法を、専門スタッフが丁寧にレクチャーします。',
  },
  {
    title: '販促・集客支援',
    desc: 'SNS投稿素材やPOP、キャンペーン企画など、集客につながるツールを提供します。',
  },
]

const initialForm = {
  name: '',
  company: '',
  email: '',
  phone: '',
  type: 'dealer',
  message: '',
}

export default function PartnerPage() {
  const [form, setForm] = useState(initialForm)
  const [submitted, setSubmitted] = useState(false)

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    // 送信処理は後日実装
    setSubmitted(true)
    setForm(initialForm)
  }

  return (
    <>
      {/* ヘッダー */}
      <section className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white py-20 sm:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-amber-400 text-xs tracking-[0.3em] font-semibold mb-4">
            PARTNERSHIP
          </p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            パートナー募集
          </h1>
          <p className="mt-4 text-slate-300 text-sm sm:text-base max-w-xl mx-auto">
            VAVITTEと共に成長する代理店・サロンパートナーを募集しています
          </p>
        </div>
      </section>

      {/* 代理店募集 */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <p className="text-amber-600 text-xs tracking-[0.25em] font-semibold mb-3">
              FOR DEALERS
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900">
              代理店募集
            </h2>
            <p className="mt-3 text-slate-600 text-sm max-w-xl mx-auto">
              急成長するサロン専売化粧品市場で、VAVITTEの代理店として新たなビジネスを始めませんか。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {dealerBenefits.map((b) => (
              <div
                key={b.title}
                className="bg-slate-50 rounded-xl p-6 hover:bg-indigo-50/50 transition-colors"
              >
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 text-sm font-bold">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  <h3 className="font-bold text-slate-900">{b.title}</h3>
                </div>
                <p className="text-sm text-slate-500 leading-relaxed pl-11">
                  {b.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* サロン導入 */}
      <section className="py-16 sm:py-24 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <p className="text-amber-600 text-xs tracking-[0.25em] font-semibold mb-3">
              FOR SALONS
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900">
              サロン導入
            </h2>
            <p className="mt-3 text-slate-600 text-sm max-w-xl mx-auto">
              「結果が出る」商品をサロンメニューに加えることで、お客様満足度とリピート率の向上を実現します。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {salonBenefits.map((b) => (
              <div
                key={b.title}
                className="bg-white rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-700 text-sm font-bold">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                    </svg>
                  </span>
                  <h3 className="font-bold text-slate-900">{b.title}</h3>
                </div>
                <p className="text-sm text-slate-500 leading-relaxed pl-11">
                  {b.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* お問い合わせフォーム */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <p className="text-amber-600 text-xs tracking-[0.25em] font-semibold mb-3">
              CONTACT
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900">
              お問い合わせ
            </h2>
            <p className="mt-3 text-slate-600 text-sm">
              代理店・サロン導入に関するご相談はこちらから
            </p>
          </div>

          {submitted && (
            <div className="mb-8 bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
              <p className="text-emerald-800 font-semibold text-sm">
                お問い合わせありがとうございます
              </p>
              <p className="text-emerald-600 text-xs mt-1">
                内容を確認の上、担当者よりご連絡いたします。
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* お問い合わせ種別 */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                お問い合わせ種別
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="type"
                    value="dealer"
                    checked={form.type === 'dealer'}
                    onChange={handleChange}
                    className="w-4 h-4 text-indigo-600"
                  />
                  <span className="text-sm text-slate-700">代理店について</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="type"
                    value="salon"
                    checked={form.type === 'salon'}
                    onChange={handleChange}
                    className="w-4 h-4 text-indigo-600"
                  />
                  <span className="text-sm text-slate-700">サロン導入について</span>
                </label>
              </div>
            </div>

            {/* 氏名 */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                お名前 <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                name="name"
                required
                value={form.name}
                onChange={handleChange}
                placeholder="山田 太郎"
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              />
            </div>

            {/* 会社名 */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                会社名・サロン名
              </label>
              <input
                type="text"
                name="company"
                value={form.company}
                onChange={handleChange}
                placeholder="株式会社○○ / ○○サロン"
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              />
            </div>

            {/* メール */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                メールアドレス <span className="text-rose-500">*</span>
              </label>
              <input
                type="email"
                name="email"
                required
                value={form.email}
                onChange={handleChange}
                placeholder="info@example.com"
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              />
            </div>

            {/* 電話番号 */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                電話番号
              </label>
              <input
                type="tel"
                name="phone"
                value={form.phone}
                onChange={handleChange}
                placeholder="03-0000-0000"
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              />
            </div>

            {/* メッセージ */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                お問い合わせ内容 <span className="text-rose-500">*</span>
              </label>
              <textarea
                name="message"
                required
                rows={5}
                value={form.message}
                onChange={handleChange}
                placeholder="ご質問やご要望をお書きください"
                className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-full bg-indigo-700 text-white font-semibold py-3 text-sm hover:bg-indigo-800 transition-colors shadow-lg"
            >
              送信する
            </button>
          </form>
        </div>
      </section>

      {/* 会社情報 */}
      <section className="py-16 bg-slate-50 border-t border-slate-100">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h3 className="text-lg font-bold text-slate-900 mb-6">運営会社</h3>
          <div className="inline-block text-left text-sm text-slate-600 leading-relaxed space-y-1">
            <p>
              <span className="inline-block w-24 text-slate-400">社名</span>
              ロイヤルトラスト株式会社
            </p>
            <p>
              <span className="inline-block w-24 text-slate-400">英文社名</span>
              Royal Trust Co., Ltd.
            </p>
            <p>
              <span className="inline-block w-24 text-slate-400">ブランド</span>
              VAVITTE（バビッテ）
            </p>
            <p>
              <span className="inline-block w-24 text-slate-400">事業内容</span>
              化粧品の企画・製造・販売
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
