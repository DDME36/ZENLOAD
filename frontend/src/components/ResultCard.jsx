import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import {
  startDownload,
  getDownloadStatus,
  cancelDownload,
  getDirectDownloadUrl,
} from '../services/api'
import { isIOSPWA } from '../utils/device'
import {
  Download,
  Loader2,
  Video,
  Music,
  Image as ImageIcon,
  Youtube,
  Instagram,
  Facebook,
  Cloud,
  MessageCircle,
  Twitter,
  Film,
  Tv,
  Twitch,
  CheckCircle2,
  AlertTriangle,
  Disc3,
  Sparkles,
} from 'lucide-react'
import DownloadProgressPanel from './DownloadProgressPanel'
import AlbumGallery from './AlbumGallery'
import SmartThumbnail from './SmartThumbnail'

const MobileShareModal = lazy(() => import('./MobileShareModal'))

const PLATFORM_CONFIG = {
  youtube: { label: 'YouTube', icon: Youtube, color: '#ef4444' },
  instagram: { label: 'Instagram', icon: Instagram, color: '#ec4899' },
  facebook: { label: 'Facebook', icon: Facebook, color: '#3b82f6' },
  soundcloud: { label: 'SoundCloud', icon: Cloud, color: '#f97316' },
  tiktok: { label: 'TikTok', icon: Music, color: '#06b6d4' },
  twitter: { label: 'Twitter / X', icon: Twitter, color: '#38bdf8' },
  reddit: { label: 'Reddit', icon: MessageCircle, color: '#f97316' },
  vimeo: { label: 'Vimeo', icon: Film, color: '#0ea5e9' },
  dailymotion: { label: 'Dailymotion', icon: Tv, color: '#6366f1' },
  twitch: { label: 'Twitch', icon: Twitch, color: '#a855f7' },
  direct: { label: 'Direct Media', icon: Film, color: '#10b981' },
}

function ResultCard({ data, originalUrl, onNewSearch }) {
  const [downloading, setDownloading] = useState(null)
  const [activeOption, setActiveOption] = useState(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadStage, setDownloadStage] = useState('downloading') // 'queued', 'downloading', 'merging', 'converting', 'ready'
  const [downloadStatus, setDownloadStatus] = useState('') // '', 'running', 'done', 'error'
  const [downloadError, setDownloadError] = useState('')
  const [elapsedTime, setElapsedTime] = useState(0)
  const [isIOS, setIsIOS] = useState(false)
  const [lastDownloadedUrl, setLastDownloadedUrl] = useState('')
  const [lastDownloadedFilename, setLastDownloadedFilename] = useState('')
  const [showShareModal, setShowShareModal] = useState(false)

  const cardRef = useRef(null)
  const progressPanelRef = useRef(null)
  const timerRef = useRef(null)
  const abortControllerRef = useRef(null)
  const jobIdRef = useRef(null)
  const tokenRef = useRef(null)

  // เลื่อนหน้าจอมายัง Result Card อย่างนุ่มนวลอัตโนมัติบนมือถือเมื่อการวิเคราะห์เสร็จสมบูรณ์
  useEffect(() => {
    if (cardRef.current && typeof window !== 'undefined' && window.innerWidth <= 768) {
      const timer = setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 80)
      return () => clearTimeout(timer)
    }
  }, [])

  // เมื่อดาวน์โหลดเสร็จสิ้น เลื่อนปุ่มบันทึก/ส่งแชร์มาอยู่ในระยะสายตาและนิ้วโป้งของผู้ใช้ทันที
  useEffect(() => {
    if (downloadStatus === 'done' && progressPanelRef.current && typeof window !== 'undefined' && window.innerWidth <= 768) {
      const timer = setTimeout(() => {
        progressPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 80)
      return () => clearTimeout(timer)
    }
  }, [downloadStatus])

  useEffect(() => {
    const ua = navigator.userAgent || ''
    setIsIOS(/iPad|iPhone|iPod/.test(ua) && !window.MSStream)
  }, [])

  useEffect(() => {
    if (downloadStatus === 'running') {
      setElapsedTime(0)
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => prev + 1)
      }, 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [downloadStatus])

  const handleReset = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setElapsedTime(0)
    setDownloading(null)
    setActiveOption(null)
    setDownloadProgress(0)
    setDownloadStatus('')
    setDownloadStage('downloading')
    setDownloadError('')
    jobIdRef.current = null
    tokenRef.current = null
  }, [])

  const handleCancel = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (jobIdRef.current) {
      await cancelDownload(jobIdRef.current, tokenRef.current)
    }
    handleReset()
  }, [handleReset])

  const handleDownload = async (option) => {
    setActiveOption(option)
    setDownloading(option.id)
    setDownloadProgress(0)
    setDownloadStage('queued')
    setDownloadStatus('running')
    setDownloadError('')

    const controller = new AbortController()
    abortControllerRef.current = controller

    let jobId = null
    let accessToken = null
    let serverFilename = `${data.title || 'download'}.${option.format || 'mp4'}`
    let directUrl = ''

    try {
      // 1. Asynchronous POST Job (รองรับทุกประเภท มีการควบคุมขนาดและเวลาจริง)
      const startResult = await startDownload(originalUrl, option.id, controller.signal)
      if (!startResult.success || !startResult.jobId) {
        throw new Error(startResult.error?.message || 'ไม่สามารถสร้างงานดาวน์โหลดบนเซิร์ฟเวอร์ได้')
      }
      jobId = startResult.jobId
      accessToken = startResult.accessToken
      jobIdRef.current = jobId
      tokenRef.current = accessToken

      // 2. Real-Time Poll (500ms) with Smooth Progress Progression
      let completed = false

      while (!completed) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve() }, 500)
          const onAbort = () => {
            clearTimeout(timeout)
            reject(new DOMException('Aborted', 'AbortError'))
          }
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })

        if (controller.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }

        const statusResult = await getDownloadStatus(jobId, accessToken, controller.signal)
        if (!statusResult.success) {
          throw new Error(statusResult.error?.message || 'เกิดข้อผิดพลาดระหว่างตรวจสอบสถานะ')
        }

        const { status, stage, progress, error, filename } = statusResult

        if (stage) setDownloadStage(stage)

        if (status === 'downloading') {
          const raw = Math.min(Math.round(progress || 0), 99)
          setDownloadProgress((prev) => Math.max(prev, raw))
        } else if (status === 'completed') {
          completed = true
          if (filename) serverFilename = filename
          setDownloadStage('ready')
          setDownloadProgress(100)
          // ให้เวลาแถบ Progress ได้ลื่นไหลไปจนถึง 100% ให้ผู้ใช้เห็นว่าเต็มหลอดจริง (450ms) ก่อนเปลี่ยนเป็นหน้าจอพร้อมส่งมอบ
          await new Promise((r) => setTimeout(r, 450))
        } else if (status === 'failed') {
          throw new Error(error || 'การดาวน์โหลดบนเซิร์ฟเวอร์ล้มเหลว')
        } else if (status === 'aborted') {
          throw new DOMException('Aborted', 'AbortError')
        }
      }

      directUrl = getDirectDownloadUrl(jobId, accessToken)

      setLastDownloadedUrl(directUrl)
      setLastDownloadedFilename(serverFilename)

      // 3. Native Browser Stream Trigger
      if (isIOSPWA()) {
        // บน iOS Standalone PWA: ห้ามสั่ง a.click() เด็ดขาด เพราะ WebKit PWA จะมองเป็นการ Navigate หน้าต่าง
        // และเปิดหน้า QuickLook เต็มจอโดยไม่มีปุ่มย้อนกลับ ทำให้ผู้ใช้ติดกับดัก
        // ให้เปลี่ยนสถานะเป็น 'done' เพื่อให้ DownloadProgressPanel แสดงปุ่ม Native Share Sheet ทันที
        setDownloadStatus('done')
      } else {
        // ดาวน์โหลดตรงผ่านเบราว์เซอร์อย่างราบรื่น ไม่เปิดแท็บขาว สำหรับ Desktop, Android และเบราว์เซอร์ปกติ
        const a = document.createElement('a')
        a.href = directUrl
        a.download = serverFilename || 'download'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          try {
            document.body.removeChild(a)
          } catch {}
        }, 2000)

        setDownloadStatus('done')
      }
      jobIdRef.current = null
      tokenRef.current = null
    } catch (err) {
      if (err.name === 'AbortError' || err instanceof DOMException) {
        await handleCancel()
        return
      }
      console.error('Download failed:', err)
      setDownloadStatus('error')
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false
      const errorMsg = isOffline
        ? 'สัญญาณอินเทอร์เน็ตขาดหาย กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง'
        : (err.message || 'เกิดปัญหาในการดาวน์โหลดไฟล์')
      setDownloadError(errorMsg)
    }
  }

  // แยกกลุ่ม options ด้วย useMemo เพื่อลดการคำนวณซ้ำซ้อนในทุก Render
  const options = useMemo(() => data?.options || [], [data?.options])
  const videoOptions = useMemo(() => options.filter(
    (opt) => opt.id.includes('video') || opt.format === 'mp4' || opt.format === 'mkv' || opt.format === 'webm'
  ), [options])
  const audioOptions = useMemo(() => options.filter(
    (opt) => opt.id.includes('audio') || opt.format === 'mp3' || opt.format === 'm4a' || opt.format === 'wav'
  ), [options])
  const imageOptions = useMemo(() => options.filter(
    (opt) => opt.id.includes('profile') || opt.format === 'jpg' || opt.format === 'png' || opt.format === 'webp'
  ), [options])

  const isAlbum = useMemo(() => data.contentType === 'album' || (data.items && data.items.length > 1), [data.contentType, data.items])
  const totalOptions = useMemo(() => [...videoOptions, ...audioOptions, ...imageOptions], [videoOptions, audioOptions, imageOptions])
  const isSingleOption = totalOptions.length === 1 && !isAlbum
  const singleOption = totalOptions[0]
  const isAudioOnly = data.contentType === 'audio' || (audioOptions.length > 0 && videoOptions.length === 0)
  const isImageOnly =
    data.contentType === 'profile' ||
    data.contentType === 'image' ||
    (imageOptions.length > 0 && videoOptions.length === 0 && !isAlbum)
  const isProfile = data.contentType === 'profile' || (isImageOnly && !isAlbum)
  const hasMultipleOptions = totalOptions.length > 1 || isAlbum

  const platformInfo = PLATFORM_CONFIG[data.platform] || { label: data.platform, icon: Film, color: '#8b5cf6' }
  const PlatformIcon = platformInfo.icon

  return (
    <div
      ref={cardRef}
      className={`result-card result-card--${data.platform} ${isProfile ? 'result-card--profile' : ''} ${isImageOnly ? 'result-card--image-only' : ''} animate-scale-in`}
      role="region"
      aria-label="ผลลัพธ์การวิเคราะห์"
    >
      {/* Mobile Save / iOS Safari Modal (Lazy loaded with Suspense) */}
      <Suspense fallback={null}>
        <MobileShareModal
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          downloadUrl={lastDownloadedUrl}
          title={data.title}
          filename={lastDownloadedFilename}
        />
      </Suspense>

      {/* Multi-Item Album Gallery View */}
      {isAlbum ? (
        <div className="result-card__album-container">
          <div className="result-card__header-row">
            <span className="platform-badge" style={{ borderColor: platformInfo.color }}>
              <PlatformIcon size={14} />
              <span>{platformInfo.label} อัลบั้ม</span>
            </span>
            <h2 className="result-card__title">{data.title}</h2>
          </div>

          <AlbumGallery
            items={data.items}
            title={data.title}
            onDownloadItem={(opt) => handleDownload(opt)}
            onDownloadAllZip={
              options.find((o) => o.id === 'album_zip')
                ? () => handleDownload(options.find((o) => o.id === 'album_zip'))
                : null
            }
            downloadingId={downloading}
            downloadStatus={downloadStatus}
            downloadStage={downloadStage}
            downloadProgress={downloadProgress}
            elapsedTime={elapsedTime}
            downloadError={downloadError}
            activeOption={activeOption}
            lastDownloadedFilename={lastDownloadedFilename}
            lastDownloadedUrl={lastDownloadedUrl}
            platform={platformInfo.label}
            onCancel={handleCancel}
            onShare={() => setShowShareModal(true)}
            onReset={handleReset}
            onNewSearch={onNewSearch}
          />
        </div>
      ) : (
        /* Single Item Views (Video / Audio / Image) */
        <div className="result-card__single-container">
          {/* Media Visual Preview */}
          {data.thumbnail && (
            <div className={`result-card__preview ${isImageOnly ? 'result-card__preview--square' : ''} ${downloading ? 'result-card__preview--active' : ''}`}>
              <span className="platform-badge platform-badge--floating">
                <PlatformIcon size={14} />
                <span>{platformInfo.label}</span>
              </span>

              {/* Live Download Status Pill */}
              {downloading && (
                <div className="result-card__status-pill animate-fade-in">
                  {downloadStatus === 'done' ? (
                    <>
                      <CheckCircle2 size={13} className="text-success" />
                      <span>ดาวน์โหลดสำเร็จ</span>
                    </>
                  ) : downloadStatus === 'error' ? (
                    <>
                      <AlertTriangle size={13} className="text-error" />
                      <span>เกิดข้อผิดพลาด</span>
                    </>
                  ) : (
                    <>
                      <span className="result-card__pulse-dot" />
                      <span>กำลังประมวลผล</span>
                    </>
                  )}
                </div>
              )}

              {isAudioOnly ? (
                <div className="result-card__audio-cover">
                  <SmartThumbnail
                    src={data.thumbnail}
                    alt={data.title}
                    title={data.title}
                    platform={data.platform}
                    circle={false}
                    className="result-card__img result-card__img--audio"
                    size={null}
                  />
                  <div className="result-card__audio-disc-overlay">
                    <Disc3 size={48} className="lucide-spin text-purple" />
                  </div>
                </div>
              ) : (
                <SmartThumbnail
                  src={data.thumbnail}
                  alt={data.title}
                  title={data.title}
                  platform={data.platform}
                  circle={isImageOnly}
                  className={`result-card__img ${isImageOnly ? 'result-card__img--profile' : ''}`}
                  size={null}
                />
              )}
            </div>
          )}

          {/* Media Details & Download Action Area */}
          <div className="result-card__body">
            <div className="result-card__meta">
              <span className="result-card__kind-tag">
                {isAudioOnly ? (
                  <><Music size={13} /> เพลง / เสียง</>
                ) : isImageOnly ? (
                  <><ImageIcon size={13} /> รูปภาพ</>
                ) : (
                  <><Video size={13} /> วิดีโอ</>
                )}
              </span>
              <h2 className="result-card__title">{data.title}</h2>
              {(() => {
                const desc = data.description?.trim() || ''
                if (!desc) return null
                const formatted = (desc.length >= 170 && !desc.endsWith('...') && !desc.endsWith('…'))
                  ? `${desc.replace(/(\s+[^\s]+|[^\s]{1,15})$/, '').trim()}...`
                  : desc
                return <p className="result-card__desc">{formatted}</p>
              })()}
            </div>

            {/* In-Place Download Progress or Action Button Groups */}
            {downloading ? (
              <div ref={progressPanelRef} className="result-card__progress-container">
                <DownloadProgressPanel
                  downloadStatus={downloadStatus}
                  downloadStage={downloadStage}
                  downloadProgress={downloadProgress}
                  elapsedTime={elapsedTime}
                  downloadError={downloadError}
                  activeOption={activeOption}
                  lastDownloadedFilename={lastDownloadedFilename}
                  lastDownloadedUrl={lastDownloadedUrl}
                  platform={platformInfo.label}
                  hasMultipleOptions={hasMultipleOptions}
                  isProfileOrImage={isProfile || isImageOnly}
                  onCancel={handleCancel}
                  onRetry={handleCancel}
                  onShare={() => setShowShareModal(true)}
                  onReset={handleReset}
                  onNewSearch={onNewSearch}
                />
              </div>
            ) : isSingleOption && singleOption ? (
              /* Single Option Hero Call-to-Action */
              <div className="result-card__hero-box animate-scale-in">
                <div className="result-card__specs-row">
                  <span className="spec-chip">
                    <Sparkles size={13} className="text-purple" />
                    <span>ความละเอียดสูงสุด</span>
                  </span>
                  {singleOption.format && (
                    <span className="spec-chip spec-chip--format">
                      {singleOption.format.toUpperCase()}
                    </span>
                  )}
                  {singleOption.fileSize && (
                    <span className="spec-chip spec-chip--size">
                      {singleOption.fileSize}
                    </span>
                  )}
                  <span className="spec-chip spec-chip--lossless">
                    ไฟล์ต้นฉบับ • ไม่ลดทอนคุณภาพ
                  </span>
                </div>

                <button
                  type="button"
                  className={`dl-btn dl-btn--hero ${
                    downloading === singleOption.id ? 'dl-btn--loading' : ''
                  }`}
                  onClick={() => handleDownload(singleOption)}
                  disabled={!!downloading}
                >
                  <div className="dl-btn__hero-left">
                    {downloading === singleOption.id ? (
                      <Loader2 size={20} className="lucide-spin" />
                    ) : (
                      <Download size={20} className="dl-btn__hero-icon" />
                    )}
                    <span>{singleOption.label}</span>
                  </div>
                  <div className="dl-btn__hero-right">
                    <span className="dl-btn__hero-tag">ดาวน์โหลดทันที</span>
                  </div>
                </button>
              </div>
            ) : (
              <div className="result-card__groups">
              {/* Video Group */}
              {videoOptions.length > 0 && (
                <div className="result-card__group">
                  <h3 className="result-card__group-title">
                    <Video size={15} /> ความละเอียดวิดีโอ (MP4)
                  </h3>
                  <div className="result-card__actions">
                    {videoOptions.map((option, i) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`dl-btn ${i === 0 ? 'dl-btn--primary' : ''} ${
                          downloading === option.id ? 'dl-btn--loading' : ''
                        }`}
                        onClick={() => handleDownload(option)}
                        disabled={!!downloading}
                      >
                        {downloading === option.id ? (
                          <Loader2 size={15} className="lucide-spin" />
                        ) : (
                          <Download size={15} />
                        )}
                        <span>{option.label}</span>
                        {option.fileSize && <span className="dl-btn__size">({option.fileSize})</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Audio Group */}
              {audioOptions.length > 0 && (
                <div className="result-card__group">
                  <h3 className="result-card__group-title">
                    <Music size={15} /> เสียง (MP3 / M4A)
                  </h3>
                  <div className="result-card__actions">
                    {audioOptions.map((option) => {
                      const isMp3 = option.format === 'mp3' || option.id === 'audio_mp3'
                      const isM4a = option.format === 'm4a' || option.id === 'audio_m4a'
                      const isWav = option.format === 'wav' || option.id === 'audio_wav'
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={`dl-btn dl-btn--audio ${downloading === option.id ? 'dl-btn--loading' : ''}`}
                          onClick={() => handleDownload(option)}
                          disabled={!!downloading}
                        >
                          {downloading === option.id ? (
                            <Loader2 size={15} className="lucide-spin" />
                          ) : (
                            <Download size={15} />
                          )}
                          <span>{option.label}</span>
                          {isMp3 && <span className="dl-btn__badge dl-btn__badge--recommended">แนะนำ · ทั่วไป</span>}
                          {isM4a && <span className="dl-btn__badge dl-btn__badge--aac">ไฟล์เล็ก · iOS</span>}
                          {isWav && <span className="dl-btn__badge dl-btn__badge--lossless">Lossless</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Image Group */}
              {imageOptions.length > 0 && (
                <div className="result-card__group">
                  <h3 className="result-card__group-title">
                    <ImageIcon size={15} /> รูปภาพ · คุณภาพจากต้นทาง
                  </h3>
                  <div className="result-card__actions">
                    {imageOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`dl-btn dl-btn--primary ${downloading === option.id ? 'dl-btn--loading' : ''}`}
                        onClick={() => handleDownload(option)}
                        disabled={!!downloading}
                      >
                        {downloading === option.id ? (
                          <Loader2 size={15} className="lucide-spin" />
                        ) : (
                          <Download size={15} />
                        )}
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )}
    </div>
  )
}

export default React.memo(ResultCard)


