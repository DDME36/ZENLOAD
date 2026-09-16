import React, { useState, useEffect, useCallback, memo } from 'react'
import { Archive, Download, Image as ImageIcon, Video, ChevronLeft, ChevronRight, Loader2, Music, Maximize2, X } from 'lucide-react'
import { resolveBackendUrl } from '../services/api'
import DownloadProgressPanel from './DownloadProgressPanel'

function AlbumGallery({
  items = [],
  title = '',
  onDownloadItem,
  onDownloadAllZip,
  downloadingId = null,
  downloadStatus = '',
  downloadStage = 'downloading',
  downloadProgress = 0,
  elapsedTime = 0,
  downloadError = '',
  activeOption = null,
  lastDownloadedFilename = '',
  lastDownloadedUrl = '',
  platform = '',
  onCancel,
  onShare,
  onReset,
  onNewSearch,
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const handlePrev = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1))
  }, [items.length])

  const handleNext = useCallback(() => {
    setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0))
  }, [items.length])

  // การนำทางด้วยแป้นพิมพ์สำหรับแกลเลอรี (WCAG 2.2 Keyboard Accessibility)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return

      if (e.key === 'Escape') {
        setLightboxOpen(false)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNext()
      } else if (e.key === 'Home') {
        e.preventDefault()
        setSelectedIndex(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setSelectedIndex(items.length - 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlePrev, handleNext, items.length])

  if (!items || items.length === 0) return null

  const selectedItem = items[selectedIndex] || items[0]
  const isSelectedVideo = selectedItem.kind === 'video'
  const isSelectedAudio = selectedItem.kind === 'audio'

  return (
    <div className="album-gallery" role="region" aria-roledescription="carousel" aria-label="แกลเลอรีสื่ออัลบั้ม">
      {/* Header with Total Items and ZIP All Button */}
      <div className="album-gallery__header">
        <div className="album-gallery__title-group">
          <span className="album-gallery__count-badge">
            {items.length} รายการ
          </span>
          <span className="album-gallery__current-indicator">
            รายการที่ {selectedIndex + 1} จาก {items.length}
          </span>
        </div>

        {onDownloadAllZip && (
          <button
            type="button"
            className={`dl-btn dl-btn--zip ${downloadingId === 'album_zip' ? 'dl-btn--loading' : ''}`}
            onClick={onDownloadAllZip}
            disabled={!!downloadingId}
          >
            {downloadingId === 'album_zip' ? (
              <Loader2 size={16} className="lucide-spin" />
            ) : (
              <Archive size={16} />
            )}
            <span>{downloadingId === 'album_zip' ? 'กำลังเตรียมไฟล์ ZIP...' : 'ดาวน์โหลดทั้งอัลบั้ม (ZIP)'}</span>
          </button>
        )}
      </div>

      {/* Main Preview Carousel */}
      <div className="album-gallery__viewer">
        <button
          type="button"
          className="album-gallery__nav-btn album-gallery__nav-btn--prev"
          onClick={handlePrev}
          aria-label="รายการก่อนหน้า"
        >
          <ChevronLeft size={22} />
        </button>

        <div className="album-gallery__preview-box">
          {isSelectedAudio ? (
            <div className="album-gallery__audio-preview animate-scale-in">
              {selectedItem.thumbnail ? (
                <img
                  src={resolveBackendUrl(selectedItem.thumbnail)}
                  alt={selectedItem.title}
                  className="album-gallery__audio-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="album-gallery__audio-icon-wrap">
                  <Music size={52} className="album-gallery__audio-icon" />
                </div>
              )}
              <div className="album-gallery__audio-info">
                <span className="album-gallery__audio-title">{selectedItem.title || 'แผ่นเสียง / เสียงประกอบ'}</span>
                {selectedItem.duration ? (
                  <span className="album-gallery__audio-duration">ความยาว {Math.round(selectedItem.duration)} วินาที</span>
                ) : null}
              </div>
            </div>
          ) : selectedItem.thumbnail || selectedItem.url ? (
            <div className="album-gallery__img-container">
              <img
                src={resolveBackendUrl(selectedItem.thumbnail || selectedItem.url)}
                alt={selectedItem.title || `Item #${selectedIndex + 1}`}
                className="album-gallery__main-img"
                loading="lazy"
                referrerPolicy="no-referrer"
                onClick={() => setLightboxOpen(true)}
                title="คลิกเพื่อขยายดูรูปภาพขนาดเต็ม"
              />
              <button
                type="button"
                className="album-gallery__zoom-trigger"
                onClick={() => setLightboxOpen(true)}
                title="ขยายดูรูปภาพขนาดเต็ม"
                aria-label="ขยายดูรูปภาพขนาดเต็ม"
              >
                <Maximize2 size={13} />
                <span>ขยายรูป</span>
              </button>
            </div>
          ) : (
            <div className="album-gallery__placeholder">
              {isSelectedVideo ? <Video size={48} /> : <ImageIcon size={48} />}
            </div>
          )}

          <span className="album-gallery__type-tag">
            {isSelectedVideo ? (
              <><Video size={13} /> วิดีโอ</>
            ) : isSelectedAudio ? (
              <><Music size={13} /> แผ่นเสียง</>
            ) : (
              <><ImageIcon size={13} /> รูปภาพ</>
            )}
          </span>
        </div>

        <button
          type="button"
          className="album-gallery__nav-btn album-gallery__nav-btn--next"
          onClick={handleNext}
          aria-label="รายการถัดไป"
        >
          <ChevronRight size={22} />
        </button>
      </div>

      {/* Item Action / In-Place Progress Panel */}
      <div className="album-gallery__actions">
        {downloadingId ? (
          <DownloadProgressPanel
            downloadStatus={downloadStatus}
            downloadStage={downloadStage}
            downloadProgress={downloadProgress}
            elapsedTime={elapsedTime}
            downloadError={downloadError}
            activeOption={activeOption}
            lastDownloadedFilename={lastDownloadedFilename}
            lastDownloadedUrl={lastDownloadedUrl}
            platform={platform}
            hasMultipleOptions={true}
            isProfileOrImage={!isSelectedAudio}
            onCancel={onCancel}
            onRetry={onCancel}
            onShare={onShare}
            onReset={onReset}
            onNewSearch={onNewSearch}
          />
        ) : (
          selectedItem.options && selectedItem.options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`dl-btn ${isSelectedAudio ? 'dl-btn--audio' : 'dl-btn--primary'}`}
              onClick={() => onDownloadItem(opt, selectedItem)}
            >
              {isSelectedAudio ? <Music size={16} /> : <Download size={16} />}
              <span>{opt.label || `ดาวน์โหลดรายการที่ #${selectedIndex + 1}`}</span>
            </button>
          ))
        )}
      </div>

      {/* Thumbnails Navigation Row */}
      <div className="album-gallery__thumbnails" role="tablist">
        {items.map((item, idx) => (
          <button
            key={item.id || idx}
            type="button"
            role="tab"
            aria-selected={idx === selectedIndex}
            className={`album-thumbnail-btn ${idx === selectedIndex ? 'album-thumbnail-btn--active' : ''} ${item.kind === 'audio' ? 'album-thumbnail-btn--audio' : ''}`}
            onClick={() => setSelectedIndex(idx)}
          >
            {item.kind === 'audio' ? (
              <div className="album-thumbnail-fallback album-thumbnail-fallback--audio">
                {item.thumbnail ? (
                  <img src={resolveBackendUrl(item.thumbnail)} alt="" className="album-thumbnail-img" referrerPolicy="no-referrer" loading="lazy" />
                ) : (
                  <Music size={18} />
                )}
              </div>
            ) : item.thumbnail || item.url ? (
              <img src={resolveBackendUrl(item.thumbnail || item.url)} alt="" className="album-thumbnail-img" referrerPolicy="no-referrer" loading="lazy" />
            ) : (
              <div className="album-thumbnail-fallback">{idx + 1}</div>
            )}
            <span className="album-thumbnail-index">{item.kind === 'audio' ? '🎵' : idx + 1}</span>
          </button>
        ))}
      </div>

      {/* Lightbox Fullscreen Image Preview */}
      {lightboxOpen && (
        <div
          className="album-lightbox animate-fade-in"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="ขยายดูรูปภาพ"
        >
          <div className="album-lightbox__dialog" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="album-lightbox__close"
              onClick={() => setLightboxOpen(false)}
              aria-label="ปิดโหมดขยายรูป"
            >
              <X size={22} />
            </button>

            <div className="album-lightbox__bar">
              <span className="album-lightbox__indicator">
                {selectedIndex + 1} / {items.length}
              </span>
              <span className="album-lightbox__title">{selectedItem.title || title || 'รูปภาพ'}</span>
            </div>

            <div className="album-lightbox__viewport">
              <img
                src={resolveBackendUrl(selectedItem.thumbnail || selectedItem.url)}
                alt={selectedItem.title || `Item #${selectedIndex + 1}`}
                className="album-lightbox__img"
              />
            </div>

            <div className="album-lightbox__bottom">
              <button
                type="button"
                className="album-lightbox__arrow"
                onClick={handlePrev}
                aria-label="รูปก่อนหน้า"
              >
                <ChevronLeft size={22} />
              </button>

              <button
                type="button"
                className="dl-btn dl-btn--primary dl-btn--sm"
                onClick={() => {
                  onDownloadItem(selectedItem, selectedIndex)
                  setLightboxOpen(false)
                }}
              >
                <Download size={14} /> ดาวน์โหลดรูปนี้
              </button>

              <button
                type="button"
                className="album-lightbox__arrow"
                onClick={handleNext}
                aria-label="รูปถัดไป"
              >
                <ChevronRight size={22} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(AlbumGallery)
