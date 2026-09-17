import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import Header from './components/Header'
import SmartInput from './components/SmartInput'
import ResultCard from './components/ResultCard'
import SkeletonState from './components/SkeletonState'
import ErrorAlert from './components/ErrorAlert'
import BentoPlatforms from './components/BentoPlatforms'
import { useFetch } from './hooks/useFetch'
import { checkHealth } from './services/api'

const HistoryList = lazy(() => import('./components/HistoryList'))

export default function App() {
  const { data, loading, error, analyze, reset } = useFetch()
  const [currentUrl, setCurrentUrl] = useState('')
  const [history, setHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('download_history')); return Array.isArray(saved) ? saved.filter(item => item && typeof item.url === 'string').slice(0, 10) : []
    } catch {
      return []
    }
  })

  const [isMounted, setIsMounted] = useState(false)

  // ล็อกเป็นธีม Obsidian Space สีเดียว ถาวร (เรียบหรูระดับพรีเมียม) + ปลุกเซิร์ฟเวอร์ (Warm-up Render) + ทริกเกอร์ Entrance Animation
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'obsidian')
    checkHealth().catch(() => {})
    const timer = setTimeout(() => setIsMounted(true), 30)
    return () => clearTimeout(timer)
  }, [])

  // บันทึกประวัติการดาวน์โหลดสำเร็จ
  useEffect(() => {
    if (data && currentUrl) {
      setHistory((prev) => {
        const filtered = prev.filter((item) => item.url !== currentUrl)
        const newItem = {
          url: currentUrl,
          title: data.title,
          thumbnail: data.thumbnail,
          platform: data.platform,
          timestamp: Date.now(),
        }
        const updated = [newItem, ...filtered].slice(0, 10)
        try { localStorage.setItem('download_history', JSON.stringify(updated)) } catch { /* Storage may be unavailable */ }
        return updated
      })
    }
  }, [data, currentUrl])

  const handleSubmit = useCallback((url) => {
    setCurrentUrl(url)
    analyze(url)
  }, [analyze])

  const handleSelectHistory = useCallback((historyUrl) => {
    setCurrentUrl(historyUrl)
    analyze(historyUrl)
  }, [analyze])

  const handleRemoveHistory = useCallback((urlToRemove) => {
    setHistory((prev) => {
      const updated = prev.filter((item) => item.url !== urlToRemove)
      try { localStorage.setItem('download_history', JSON.stringify(updated)) } catch { /* Storage may be unavailable */ }
      return updated
    })
  }, [])

  const handleClearAllHistory = useCallback(() => {
    setHistory([])
    try { localStorage.removeItem('download_history') } catch { /* Storage may be unavailable */ }
  }, [])

  return (
    <div className={`app fetch-app ${isMounted ? 'is-mounted' : 'is-loading'}`}>
      {/* Skip Link สำหรับการนำทางด้วยคีย์บอร์ด (Accessibility WCAG AAA) */}
      <a href="#main-content" className="skip-link">
        ข้ามไปยังเนื้อหาหลัก
      </a>

      <Header />

      <main id="main-content" className="fetch-main" tabIndex="-1">
        {/* ซ่อนช่องค้นหาเมื่อแสดงผลลัพธ์การวิเคราะห์ เพื่อลดความรกรุงรังของหน้าจอ */}
        {!data && (
          <SmartInput 
            onSubmit={handleSubmit} 
            loading={loading} 
            onReset={reset} 
            externalValue={currentUrl} 
          />
        )}

        {error && <ErrorAlert error={error} onClose={reset} />}
        
        {loading && (
          <div className="analysis-loading-container animate-fade-in">
            <SkeletonState />
            <p className="analysis-loading-text">
              กำลังตรวจสอบลิงก์และค้นหารูปแบบที่ดาวน์โหลดได้…
            </p>
            <button onClick={reset} className="back-home-btn back-home-btn--sm">
              ✕ ยกเลิกการวิเคราะห์
            </button>
          </div>
        )}

        {/* เมื่อดาวน์โหลดเสร็จ แสดงเฉพาะปุ่มกลับหน้าหลักและตัวการ์ดผลลัพธ์ */}
        {data && !loading && (
          <div className="result-view-wrapper animate-fade-in">
            <div className="result-nav-row">
              <button onClick={reset} className="back-home-btn">
                ← กลับไปวิเคราะห์ลิงก์อื่น
              </button>
            </div>
            <ResultCard data={data} originalUrl={currentUrl} onNewSearch={reset} />
          </div>
        )}

        {/* ซ่อน Bento Grid & History เมื่อมีผลลัพธ์หรืออยู่ระหว่างโหลดข้อมูล */}
        {!loading && !data && (
          <>
            <Suspense fallback={null}>
              <HistoryList
                history={history}
                onSelect={handleSelectHistory}
                onRemove={handleRemoveHistory}
                onClearAll={handleClearAllHistory}
              />
            </Suspense>
            <BentoPlatforms />
          </>
        )}
      </main>

      <footer className="footer">
        <p>Zenload · Developed by Zentyr</p>
      </footer>
    </div>
  )
}


