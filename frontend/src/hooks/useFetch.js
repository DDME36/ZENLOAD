import { useState, useCallback, useRef } from 'react'
import { analyzeUrl } from '../services/api'

/**
 * Hook สำหรับวิเคราะห์ลิงก์ พร้อม loading/error state
 * รองรับ cold start และ timeout ของ free tier
 */
export function useFetch() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortControllerRef = useRef(null)

  const analyze = useCallback(async (url) => {
    // ยกเลิกคำขอก่อนหน้าหากยังทำงานค้างอยู่
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError({
        message: 'สัญญาณอินเทอร์เน็ตขาดหาย กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง',
        code: 'OFFLINE',
        suggestion: 'กรุณาตรวจสอบการเชื่อมต่อ Wi-Fi หรือข้อมูลมือถือของอุปกรณ์',
      })
      return
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    setLoading(true)
    setError(null)
    setData(null)

    try {
      const result = await analyzeUrl(url, controller.signal)
      if (abortControllerRef.current === controller && !controller.signal.aborted) setData(result)
    } catch (err) {
      if (err.name === 'AbortError' || abortControllerRef.current !== controller) {
        // ละเว้นการอัปเดตสเตตัสหากถูกยกเลิก
        return
      }

      // แยก error message สำหรับ cold start หรือ offline
      let message = err.message || 'เกิดข้อผิดพลาดที่ไม่คาดคิด'
      let suggestion = err.suggestion || null
      let code = err.code || 'UNKNOWN'

      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false

      if (isOffline) {
        code = 'OFFLINE'
        message = 'สัญญาณอินเทอร์เน็ตขาดหาย'
        suggestion = 'กรุณาตรวจสอบการเชื่อมต่อ Wi-Fi หรือข้อมูลมือถือของอุปกรณ์'
      } else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) {
        message = 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้'
        suggestion = 'เซิร์ฟเวอร์อาจกำลัง cold start (รอ 30 วินาที) หรือตรวจสอบการเชื่อมต่ออินเทอร์เน็ต'
      } else if (err.message?.includes('timeout') || err.message?.includes('timed out')) {
        message = 'การเชื่อมต่อหมดเวลา'
        suggestion = 'ลองใหม่อีกครั้ง หรือเลือกวิดีโอที่สั้นกว่า'
      }

      setError({
        message,
        code,
        suggestion,
      })
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false)
        abortControllerRef.current = null
      }
    }
  }, [])

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setLoading(false)
    setData(null)
    setError(null)
  }, [])

  const reset = useCallback(() => {
    cancel()
  }, [cancel])

  return { data, loading, error, analyze, reset, cancel }
}

