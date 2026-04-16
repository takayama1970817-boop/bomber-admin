import { createContext, useContext, useState } from 'react'

const COMPANIES = {
  rt: {
    key: 'rt',
    name: 'ロイヤルトラスト',
    brand: 'VAVITTE',
    collection: 'rt_projects',
    color: 'indigo',
    bg: 'bg-indigo-600',
    bgLight: 'bg-indigo-50',
    text: 'text-indigo-700',
    border: 'border-indigo-300',
  },
  rc: {
    key: 'rc',
    name: 'ロイヤルコスメ',
    brand: 'VEBOL',
    collection: 'rc_projects',
    color: 'emerald',
    bg: 'bg-emerald-600',
    bgLight: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-300',
  },
}

const CompanyContext = createContext()

export function CompanyProvider({ children }) {
  const [companyKey, setCompanyKey] = useState(
    () => localStorage.getItem('selectedCompany') || 'rt',
  )

  const switchCompany = (key) => {
    setCompanyKey(key)
    localStorage.setItem('selectedCompany', key)
  }

  const company = COMPANIES[companyKey] || COMPANIES.rt

  return (
    <CompanyContext.Provider value={{ company, companyKey, switchCompany, COMPANIES }}>
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  return useContext(CompanyContext)
}

/** サイドバー・ヘッダー用の切替ボタン */
export function CompanySwitcher() {
  const { companyKey, switchCompany, COMPANIES } = useCompany()

  return (
    <div className="flex rounded-lg border border-gray-200 bg-gray-100 p-0.5">
      {Object.values(COMPANIES).map((c) => (
        <button
          key={c.key}
          onClick={() => switchCompany(c.key)}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
            companyKey === c.key
              ? `${c.bg} text-white shadow-sm`
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {c.name}
        </button>
      ))}
    </div>
  )
}
