/**
 * Device & Platform Detection Utilities
 * ตรวจสอบอุปกรณ์และโหมดการทำงานของเว็บแอพ เพื่อรองรับ iOS PWA และ Web Share API
 */

export function isIOS() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isIPhoneIPad = /iPad|iPhone|iPod/.test(ua)
  // iPadOS 13+ identifies as MacIntel with multi-touch
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return (isIPhoneIPad || isIPadOS) && !window.MSStream
}

export function isStandalone() {
  if (typeof window === 'undefined') return false
  return (
    window.navigator?.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches
  )
}

/**
 * ตรวจสอบว่าเป็น iOS ในโหมด Standalone PWA หรือไม่
 * สำคัญ: WebKit ในโหมดนี้ไม่มีปุ่มนำทาง (Back / URL bar)
 * และไม่รองรับ <a download> ซึ่งจะทำให้ WebView นำทางไปยังไฟล์และติดกับดัก QuickLook
 */
export function isIOSPWA() {
  return isIOS() && isStandalone()
}
