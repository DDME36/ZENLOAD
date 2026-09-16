import React, { memo } from 'react'
import { AlertCircle, Lock, Clock, SearchX, Link2Off, X, Lightbulb, WifiOff } from 'lucide-react'

function ErrorAlert({ error, onClose }) {
  if (!error) return null

  const getErrorIcon = (code) => {
    switch (code) {
      case 'OFFLINE':
        return <WifiOff size={18} className="text-warning" aria-hidden="true" />
      case 'AUTH_REQUIRED':
      case 'PRIVATE_CONTENT':
        return <Lock size={18} className="text-warning" aria-hidden="true" />
      case 'RATE_LIMITED':
        return <Clock size={18} className="text-warning" aria-hidden="true" />
      case 'NOT_FOUND':
        return <SearchX size={18} className="text-error" aria-hidden="true" />
      case 'INVALID_URL':
      case 'UNSUPPORTED':
        return <Link2Off size={18} className="text-warning" aria-hidden="true" />
      default:
        return <AlertCircle size={18} className="text-error" aria-hidden="true" />
    }
  }

  const title =
    error.code === 'OFFLINE'
      ? 'สัญญาณอินเทอร์เน็ตขาดหาย'
      : error.code === 'AUTH_REQUIRED'
      ? 'เนื้อหานี้ต้องเข้าสู่ระบบหรือเป็นส่วนตัว'
      : error.code === 'RATE_LIMITED'
      ? 'คำขอถี่เกินไปชั่วคราว'
      : error.code === 'NOT_FOUND'
      ? 'ไม่พบเนื้อหาที่ระบุ'
      : error.code === 'INVALID_URL'
      ? 'รูปแบบลิงก์ไม่ถูกต้อง'
      : 'เกิดข้อผิดพลาดในการประมวลผล'

  return (
    <div className="error-alert animate-fade-in" role="alert" aria-live="assertive" aria-atomic="true">
      <button
        type="button"
        className="error-alert__close"
        onClick={onClose}
        aria-label="ปิดการแจ้งเตือน"
      >
        <X size={18} aria-hidden="true" />
      </button>

      <div className="error-alert__content">
        <div className="error-alert__title-row">
          <span className="error-alert__icon">{getErrorIcon(error.code)}</span>
          <h4 className="error-alert__title">{title}</h4>
        </div>
        <p className="error-alert__message">{error.message}</p>
      </div>

      {error.suggestion && (
        <div className="error-alert__suggestion-box">
          <Lightbulb size={15} className="text-purple flex-shrink-0" aria-hidden="true" />
          <span><strong>คำแนะนำ:</strong> {error.suggestion}</span>
        </div>
      )}
    </div>
  )
}

export default memo(ErrorAlert)
