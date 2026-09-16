/**
 * กำหนด Base URL ของ Zenload API ให้เป็นมาตรฐาน:
 * 1. ถ้ามี VITE_API_URL ใน Environment ให้ใช้ค่านั้น (เช่น 'https://zentyr.online/api/zenload')
 * 2. ถ้าเปิดใช้งานบนโดเมนหลัก zentyr.online (เช่น https://zentyr.online/zenload) ให้ใช้ relative path '/api/zenload' ทันที (No CORS, No Mixed Content)
 * 3. ถ้าเปิดใช้งานจากภายนอก (เช่น Vercel หรือโฮสต์อื่น) ให้ยิงเข้า 'https://zentyr.online/api/zenload'
 * 4. ถ้าอยู่ใน Local Development (localhost) ให้ใช้ '/api/zenload' เพื่อส่งผ่าน Vite Dev Proxy ไปยัง port 3001
 */
function resolveApiBase() {
  if (import.meta.env.VITE_API_URL) {
    let base = import.meta.env.VITE_API_URL.trim().replace(/\/+$/, '')
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && base.startsWith('http://')) {
      base = base.replace(/^http:\/\//, 'https://')
    }
    return base
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    // ถ้าอยู่บนโดเมน zentyr.online อยู่แล้ว ใช้ relative path ตรงๆ ได้เลย
    if (host === 'zentyr.online' || host.endsWith('.zentyr.online')) {
      return '/api/zenload'
    }
    // ถ้าเป็น localhost ให้ใช้ /api/zenload (ผ่าน Vite Proxy)
    if (host === 'localhost' || host === '127.0.0.1') {
      return '/api/zenload'
    }
    // ถ้าเป็น Vercel หรือโฮสต์ภายนอก ให้ยิงเข้า Production Domain HTTPS
    return 'https://zentyr.online/api/zenload'
  }

  return 'https://zentyr.online/api/zenload'
}

export const API_BASE = resolveApiBase()

/**
 * สร้าง API Endpoint URL ให้สมบูรณ์และถูกต้องเสมอ ป้องกันปัญหา path ซ้ำซ้อน
 */
export function apiUrl(endpoint) {
  const norm = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  // ตัด /api ออกหาก API_BASE ลงท้ายด้วย /api/zenload เพื่อให้ได้ /api/zenload/analyze
  const clean = norm.startsWith('/api/') ? norm.replace(/^\/api/, '') : norm
  return `${API_BASE}${clean}`
}

// Timeout สำหรับการประมวลผล (60 วินาที)
const ANALYZE_TIMEOUT = 60000
const HEALTH_CHECK_TIMEOUT = 5000

/**
 * วิเคราะห์ลิงก์ — บอกว่าเป็นแพลตฟอร์มไหน + ตัวเลือกดาวน์โหลด
 */
export async function analyzeUrl(url, signal) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const resp = await fetch(apiUrl('/analyze'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    })

    let data
    try {
      data = await resp.json()
    } catch {
      if (!resp.ok) {
        throw new Error('เซิร์ฟเวอร์มีปัญหา ลองใหม่อีกครั้งครับ')
      }
    }

    if (data && !data.success) {
      const err = new Error(data.error?.message || 'เกิดข้อผิดพลาด')
      err.code = data.error?.code
      err.suggestion = data.error?.suggestion
      throw err
    }

    return data.data
  } catch (err) {
    clearTimeout(timeoutId)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('การเชื่อมต่อหมดเวลา')
      timeoutErr.code = 'TIMEOUT'
      timeoutErr.suggestion = 'เซิร์ฟเวอร์อาจกำลัง cold start หรือวิดีโอใหญ่เกินไป ลองใหม่อีกครั้ง'
      throw timeoutErr
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * แปลง URL ให้ชี้ไปยัง Backend อย่างถูกต้อง (เช่น รูปภาพ Proxy หรือไฟล์ดาวน์โหลด)
 */
export function resolveBackendUrl(path) {
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) return path
  return apiUrl(path)
}

/**
 * สร้าง URL สำหรับดาวน์โหลดผ่าน Job ID และ Access Token
 */
export function getDirectDownloadUrl(jobId, token) {
  const params = new URLSearchParams({ jobId })
  if (token) params.set('token', token)
  return `${apiUrl('/download')}?${params.toString()}`
}

/**
 * เริ่มต้นการดาวน์โหลดแบบ Asynchronous (POST: จองคิวและรับ Access Token)
 */
export async function startDownload(url, optionId, signal) {
  const resp = await fetch(apiUrl('/download/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, option: optionId }),
    signal,
  })
  if (!resp.ok) {
    const errorData = await resp.json().catch(() => null)
    throw new Error(errorData?.error?.message || `เซิร์ฟเวอร์ตอบกลับ HTTP ${resp.status}`)
  }
  return resp.json()
}

/**
 * ดึงสถานะและความก้าวหน้าของการดาวน์โหลดบนเซิร์ฟเวอร์ (พร้อม Access Token)
 */
export async function getDownloadStatus(jobId, token, signal) {
  const params = new URLSearchParams({ jobId })
  if (token) params.set('token', token)
  const resp = await fetch(`${apiUrl('/download/status')}?${params.toString()}`, { signal })
  if (!resp.ok) {
    const errorData = await resp.json().catch(() => null)
    throw new Error(errorData?.error?.message || `เซิร์ฟเวอร์ตอบกลับ HTTP ${resp.status}`)
  }
  return resp.json()
}

/**
 * ส่งสัญญาณยกเลิกการดาวน์โหลดและล้างไฟล์บนเซิร์ฟเวอร์ (POST)
 */
export async function cancelDownload(jobId, token) {
  try {
    await fetch(apiUrl('/download/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, token }),
    })
  } catch (err) {
    console.warn('Failed to cancel download on server:', err)
  }
}

/**
 * ตรวจสอบว่า backend ทำงานอยู่หรือไม่
 */
export async function checkHealth() {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT)
    
    const resp = await fetch(apiUrl('/health'), { signal: controller.signal })
    clearTimeout(timeoutId)
    return resp.ok
  } catch {
    return false
  }
}
