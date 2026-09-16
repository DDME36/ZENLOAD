import React, { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, AlertTriangle, Share2, RotateCcw, Clock, X, Loader2, Download, ExternalLink, FileUp, Copy, Check } from 'lucide-react'
import { isIOSPWA } from '../utils/device'
import { resolveBackendUrl } from '../services/api'

export default function DownloadProgressPanel({
  downloadStatus = '', // '', 'running', 'done', 'error'
  downloadProgress = 0,
  elapsedTime = 0,
  downloadError = '',
  activeOption = null,
  lastDownloadedFilename = '',
  lastDownloadedUrl = '',
  hasMultipleOptions = false,
  isProfileOrImage = false,
  onCancel,
  onRetry,
  onShare,
  onReset,
  onNewSearch,
}) {
  const [visualProgress, setVisualProgress] = useState(0)
  const [iosPwa, setIosPwa] = useState(false)
  const [isSharing, setIsSharing] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopyLink = useCallback(async () => {
    if (!lastDownloadedUrl) return
    const fullUrl = resolveBackendUrl(lastDownloadedUrl)
    const shareableUrl = fullUrl.startsWith('http')
      ? fullUrl
      : `${typeof window !== 'undefined' ? window.location.origin : ''}${fullUrl}`

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareableUrl)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = shareableUrl
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      setCopied(false)
    }
  }, [lastDownloadedUrl])

  useEffect(() => {
    setIosPwa(isIOSPWA())
  }, [])

  // รีเซ็ตความคืบหน้าให้เริ่มจาก 0 เสมอเมื่อเริ่มงานใหม่
  useEffect(() => {
    if (downloadStatus === 'running' && (downloadProgress === 0 || !downloadProgress)) {
      setVisualProgress(0)
    }
  }, [activeOption?.id, downloadStatus])

  useEffect(() => {
    if (downloadStatus !== 'running') {
      setVisualProgress(downloadProgress || 0)
      return
    }

    // สะท้อนเปอร์เซ็นต์จริงจากเซิร์ฟเวอร์ และรับประกันว่าไม่มีการลดระดับถอยหลัง
    setVisualProgress((prev) => Math.max(prev, downloadProgress || 0))
  }, [downloadProgress, downloadStatus])

  const formatTime = (sec = 0) => {
    if (sec < 60) return `${sec} วิ`
    return `${Math.floor(sec / 60)} น. ${sec % 60} วิ`
  }

  // แชร์หรือบันทึกไฟล์โดยตรงผ่าน Web Share API สำหรับโหมด iOS PWA
  const handleDirectShare = async () => {
    const targetUrl = resolveBackendUrl(lastDownloadedUrl)
    if (!targetUrl) {
      if (onShare) onShare()
      return
    }
    setIsSharing(true)
    try {
      const resp = await fetch(targetUrl)
      const blob = await resp.blob()
      const ext = lastDownloadedFilename?.split('.').pop() || 'mp4'
      const mime = blob.type || (ext === 'mp4' ? 'video/mp4' : ext === 'mp3' ? 'audio/mpeg' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png')
      const file = new File([blob], lastDownloadedFilename || `media.${ext}`, { type: mime })

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: lastDownloadedFilename || 'Zenload Media',
        })
      } else if (navigator.share) {
        await navigator.share({
          title: lastDownloadedFilename || 'Zenload Media',
          url: targetUrl,
        })
      } else if (onShare) {
        onShare()
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Direct share failed:', err)
        if (onShare) onShare()
      }
    } finally {
      setIsSharing(false)
    }
  }

  // 1. Success Completed State
  if (downloadStatus === 'done') {
    return (
      <div className="download-result-panel download-result-panel--success animate-scale-in" role="region" aria-label="ดาวน์โหลดเสร็จสมบูรณ์">
        <div className="download-result-panel__header">
          <div className="download-result-panel__badge download-result-panel__badge--success">
            <CheckCircle2 size={16} className="text-success" />
            <span>ดาวน์โหลดสำเร็จแล้ว</span>
          </div>
          <span className="download-result-panel__timer">ใช้เวลา {formatTime(elapsedTime)}</span>
        </div>

        {lastDownloadedFilename && (
          <div className="download-result-panel__file-chip" title={lastDownloadedFilename}>
            <span className="download-result-panel__file-icon">
              {isProfileOrImage ? '🖼️' : '📄'}
            </span>
            <span className="download-result-panel__file-name">{lastDownloadedFilename}</span>
          </div>
        )}

        {/* Primary Instant Action Area - Positioned at the top for instant thumb tap on mobile */}
        <div className="download-result-panel__actions">
          {iosPwa ? (
            <>
              <button
                type="button"
                className="dl-btn dl-btn--primary dl-btn--save-instant"
                onClick={handleDirectShare}
                disabled={isSharing}
              >
                {isSharing ? <Loader2 size={16} className="lucide-spin" /> : <Share2 size={16} />}
                <span>{isSharing ? 'กำลังเตรียมไฟล์...' : 'บันทึกลงรูปภาพ (Photos) / แชร์'}</span>
              </button>

              <div className="download-result-panel__secondary-row">
                {onShare && (
                  <button
                    type="button"
                    className="dl-btn dl-btn--secondary dl-btn--sm"
                    onClick={onShare}
                  >
                    <FileUp size={14} /> ตัวเลือกเพิ่มเติม
                  </button>
                )}

                {lastDownloadedUrl && (
                  <button
                    type="button"
                    className="dl-btn dl-btn--ghost dl-btn--sm"
                    onClick={handleCopyLink}
                    title="คัดลอกลิงก์สำหรับส่งต่อหรือดาวน์โหลด"
                  >
                    {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                    <span>{copied ? 'คัดลอกแล้ว!' : 'คัดลอกลิงก์'}</span>
                  </button>
                )}

                {lastDownloadedUrl && (
                  <a
                    href={resolveBackendUrl(lastDownloadedUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="dl-btn dl-btn--ghost dl-btn--sm"
                  >
                    <ExternalLink size={13} /> เปิดใน Safari
                  </a>
                )}
              </div>
            </>
          ) : (
            <>
              {lastDownloadedUrl && (
                <a
                  href={lastDownloadedUrl}
                  download={lastDownloadedFilename || 'download'}
                  className="dl-btn dl-btn--primary dl-btn--save-instant"
                >
                  <Download size={16} /> กดบันทึก / ดาวน์โหลดไฟล์
                </a>
              )}
              {lastDownloadedUrl && (
                <button
                  type="button"
                  className="dl-btn dl-btn--secondary"
                  onClick={handleCopyLink}
                  title="คัดลอกลิงก์สำหรับส่งต่อหรือดาวน์โหลด"
                >
                  {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
                  <span>{copied ? 'คัดลอกลิงก์สำเร็จ!' : 'คัดลอกลิงก์ไฟล์'}</span>
                </button>
              )}
              {onShare && (
                <button
                  type="button"
                  className="dl-btn dl-btn--secondary"
                  onClick={onShare}
                >
                  <Share2 size={15} /> บันทึกลงเครื่อง / แชร์ (มือถือ)
                </button>
              )}
            </>
          )}

          {/* Format Switching OR New Search Button */}
          <div className="download-result-panel__reset-row">
            {hasMultipleOptions && onReset && (
              <button
                type="button"
                className="back-home-btn"
                onClick={onReset}
              >
                <RotateCcw size={14} /> เลือกดาวน์โหลดรูปแบบอื่น
              </button>
            )}

            {(onNewSearch || (!hasMultipleOptions && onReset)) && (
              <button
                type="button"
                className={`back-home-btn ${hasMultipleOptions ? 'back-home-btn--subtle' : ''}`}
                onClick={onNewSearch || onReset}
              >
                <RotateCcw size={14} /> วิเคราะห์ลิงก์ใหม่
              </button>
            )}
          </div>
        </div>

        {iosPwa && (
          <p className="download-result-panel__pwa-tip">
            💡 <strong>สำหรับ iPhone (PWA):</strong> แตะ <em>"บันทึกลงรูปภาพ / แชร์"</em> แล้วเลือก <em>"บันทึกภาพ" (Save Image)</em> หรือ <em>"บันทึกวิดีโอ"</em> ไฟล์จะเข้าแอปรูปภาพทันที
          </p>
        )}
      </div>
    )
  }

  // 2. Error State
  if (downloadStatus === 'error') {
    return (
      <div className="download-result-panel download-result-panel--error animate-scale-in" role="alert">
        <div className="download-result-panel__header">
          <div className="download-result-panel__badge download-result-panel__badge--error">
            <AlertTriangle size={16} className="text-error" />
            <span>เกิดข้อผิดพลาดในการดาวน์โหลด</span>
          </div>
        </div>

        <div className="download-result-panel__body">
          <p className="download-result-panel__error-msg">
            {downloadError || 'ไม่สามารถดาวน์โหลดไฟล์ได้จากเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง'}
          </p>
        </div>

        <div className="download-result-panel__actions">
          <button
            type="button"
            className="dl-btn dl-btn--primary"
            onClick={onRetry || onCancel}
          >
            <RotateCcw size={15} /> ลองใหม่อีกครั้ง
          </button>
          {onNewSearch && (
            <button
              type="button"
              className="back-home-btn"
              onClick={onNewSearch}
            >
              วิเคราะห์ลิงก์ใหม่
            </button>
          )}
        </div>
      </div>
    )
  }

  // 3. Active Downloading State: Sleek, Alive & Continuous Progress
  const displayProgress = Math.max(0, Math.min(100, Math.round(visualProgress || 0)))

  return (
    <div className="download-result-panel download-result-panel--active animate-scale-in" role="region" aria-label="สถานะการดาวน์โหลด">
      {/* Target & Timer / Cancel Row */}
      <div className="download-active-header">
        <div className="download-active-target">
          <span className="download-active-pulse-dot" />
          <span className="download-active-label">
            {displayProgress >= 100 ? 'จัดเตรียมเสร็จสิ้น: ' : 'กำลังดาวน์โหลด: '}
            <strong>{activeOption?.label || activeOption?.id || 'สื่อต้นฉบับ'}</strong>
          </span>
          {activeOption?.fileSize && (
            <span className="download-active-size-tag">({activeOption.fileSize})</span>
          )}
        </div>

        <div className="download-active-meta">
          <span className="download-active-timer">
            <Clock size={13} /> {formatTime(elapsedTime)}
          </span>
          {onCancel && (
            <button
              type="button"
              className="download-active-cancel-btn"
              onClick={onCancel}
              title="ยกเลิกการดาวน์โหลด"
            >
              <X size={13} />
              <span>ยกเลิก</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress Track & Percentage */}
      <div className="download-active-track-row">
        <div
          className="download-active-track"
          role="progressbar"
          aria-valuenow={displayProgress}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            className="download-active-fill"
            style={{ width: `${displayProgress}%` }}
          >
            <div className="download-active-shimmer" />
          </div>
        </div>

        <div className="download-active-percent">
          {displayProgress >= 100 ? (
            <span className="text-success font-bold">100%</span>
          ) : displayProgress > 0 ? (
            <span>{displayProgress}%</span>
          ) : (
            <span className="download-active-connecting">
              <Loader2 size={12} className="lucide-spin" /> เตรียมไฟล์...
            </span>
          )}
        </div>
      </div>

      {/* Reassuring Live Status Indicator */}
      <div className="download-active-footer">
        <span className="download-active-alive-badge">
          <span className="download-active-radar" />
          <span>กำลังส่งต่อข้อมูลลงเครื่อง...</span>
        </span>
      </div>
    </div>
  )
}
