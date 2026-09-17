import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import { detectUrl, isValidUrl } from './services/urlDetector'
import { getYoutubeInfo, downloadYoutube } from './services/youtube'
import { getInstagramInfo, downloadInstagram } from './services/instagram'
import { getFacebookInfo, downloadFacebook } from './services/facebook'
import { getSoundcloudInfo, downloadSoundcloud } from './services/soundcloud'
import { getGenericInfo, downloadGeneric } from './services/generic'
import { AppError } from './utils/errors'
import { log, initCookies, getTempDir } from './utils/helpers'
import { mediaCache } from './utils/cache'
import { saveBoundedStream } from './utils/streamFile'
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ApiResponse, DownloadResult, DownloadStage } from './types'
import { DirectMediaAdapter } from './adapters/directMedia'
import { GalleryDlAdapter, checkGalleryDl } from './adapters/galleryDl'
import {
  parseAndValidateUrl,
  isAllowedImageProxyHost,
  assertSafePublicDestination,
  safeFetch,
  isSafeSubpath,
} from './utils/security'
import {
  analyzeCapacity,
  downloadCapacity,
  analyzeRateLimiter,
  downloadRateLimiter,
  assertSufficientDiskSpace,
  MAX_DOWNLOAD_DURATION_MS,
  MAX_ANALYZE_DURATION_MS,
  MAX_FILE_SIZE_MB,
} from './utils/limits'
import {
  initJobManager,
  createJob,
  verifyJobOwnership,
  setJobDownloading,
  updateJobProgress,
  completeJob,
  failJob,
  abortJob,
  ensureJobDir,
} from './services/jobManager'

const PORT = parseInt(process.env.PORT || '3001', 10)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const directMediaAdapter = new DirectMediaAdapter()
const galleryDlAdapter = new GalleryDlAdapter()

function getClientIp(request: Request, server?: any): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp) return cfIp.trim()
  try {
    const ip = server?.requestIP(request)?.address
    if (ip) return ip
  } catch {}
  return '127.0.0.1'
}

/**
 * Background Worker รันงานดาวน์โหลดในพื้นหลัง
 */
async function runDownloadJob(
  jobId: string,
  url: string,
  option: string,
  platform: string,
  identifier: string | undefined,
  abortController: AbortController,
  releaseCapacity: () => void
) {
  const signal = abortController.signal
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  try {
    if (signal.aborted) return

    setJobDownloading(jobId)

    // Max duration timeout
    timeoutTimer = setTimeout(() => {
      log('warn', `Job ${jobId} exceeded max duration (${MAX_DOWNLOAD_DURATION_MS}ms), aborting...`)
      abortJob(jobId).catch(() => {})
    }, MAX_DOWNLOAD_DURATION_MS)

    let result: DownloadResult
    const progressCallback = (progress: number, stage?: DownloadStage) => {
      if (!signal.aborted) {
        updateJobProgress(jobId, progress, stage)
      }
    }

    const detected = detectUrl(url)
    const cachedMeta = mediaCache.get(url) || mediaCache.get(detected.originalUrl)

    if (option.startsWith('item_') || option === 'album_zip') {
      result = await galleryDlAdapter.download(url, option, signal, progressCallback, cachedMeta || undefined)
    } else {
      switch (platform) {
        case 'direct':
          result = await directMediaAdapter.download(url, option, signal, progressCallback, cachedMeta || undefined)
          break
        case 'youtube':
          result = await downloadYoutube(url, option, signal, progressCallback, cachedMeta || undefined)
          break
        case 'instagram':
          result = await downloadInstagram(url, identifier || '', detected.contentType, option, signal, progressCallback, cachedMeta || undefined)
          break
        case 'facebook':
          result = await downloadFacebook(url, identifier || '', detected.contentType, option, signal, progressCallback, cachedMeta || undefined)
          break
        case 'soundcloud':
          result = await downloadSoundcloud(url, option, signal, progressCallback, cachedMeta || undefined)
          break
        case 'tiktok':
        case 'twitter':
        case 'reddit':
        case 'vimeo':
        case 'dailymotion':
        case 'twitch':
          result = await downloadGeneric(url, option, platform, signal, progressCallback, cachedMeta || undefined)
          break
        default:
          result = await downloadYoutube(url, option, signal, progressCallback, cachedMeta || undefined)
      }
    }

    if (result.stream && !result.filePath) {
      const jobDir = await ensureJobDir(jobId)
      const sanitizedFilename = (result.filename || 'download.bin').replace(/[/\\?%*:|"<>]/g, '_')
      const targetPath = join(jobDir, sanitizedFilename)
      await saveBoundedStream(result.stream, targetPath, MAX_FILE_SIZE_MB * 1024 * 1024, signal)
      result.filePath = targetPath
    }

    if (signal.aborted) {
      if (result.filePath) {
        try { await unlink(result.filePath) } catch {}
      }
      return
    }

    if (!result.filePath || !(await Bun.file(result.filePath).exists())) {
      throw new AppError('DOWNLOAD_FAILED', 'ไฟล์ที่ดาวน์โหลดไม่สมบูรณ์หรือไม่พบไฟล์')
    }

    const fileSize = Bun.file(result.filePath).size
    if (fileSize > MAX_FILE_SIZE_MB * 1024 * 1024) {
      await unlink(result.filePath).catch(() => {})
      throw new AppError('FILE_TOO_LARGE', 'ไฟล์ผลลัพธ์มีขนาดเกินขีดจำกัด', 413)
    }
    if (fileSize <= 30) {
      try { await unlink(result.filePath) } catch {}
      throw new AppError('EMPTY_FILE', 'ไฟล์ที่ดาวน์โหลดว่างเปล่าหรือเสียหาย')
    }

    completeJob(jobId, result.filePath, result.filename, result.contentType, fileSize)
    log('info', `Job ${jobId} completed successfully (${(fileSize / 1024 / 1024).toFixed(1)} MB)`)
  } catch (error) {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (!signal.aborted) {
      let clientMsg = 'การประมวลผลไฟล์ดาวน์โหลดขัดข้อง กรุณาลองใหม่อีกครั้ง'
      if (error instanceof AppError) {
        clientMsg = error.message
      } else if (error instanceof Error) {
        const raw = error.message
        if (raw.includes('Private video') || raw.includes('This video is private')) {
          clientMsg = 'วิดีโอนี้ถูกตั้งค่าเป็นส่วนตัว ไม่สามารถดาวน์โหลดได้'
        } else if (raw.includes('Sign in') || raw.includes('confirm you’re not a bot')) {
          clientMsg = 'จำเป็นต้องใช้สิทธิ์การเข้าสู่ระบบ หรือติดการยืนยันตัวตนจากแพลตฟอร์มต้นทาง'
        } else if (raw.includes('Geo-restricted') || raw.includes('not available in your country')) {
          clientMsg = 'เนื้อหานี้ถูกจำกัดการเข้าถึงเฉพาะบางประเทศ'
        } else if (raw.includes('Copyright') || raw.includes('blocked')) {
          clientMsg = 'เนื้อหานี้ถูกระงับเนื่องจากลิขสิทธิ์'
        }
      }
      failJob(jobId, clientMsg)
      const errorStack = error instanceof Error ? (error.stack || error.message) : String(error)
      log('error', `Job ${jobId} failed: ${errorStack}`)
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    releaseCapacity()
    if (process.env.NODE_ENV === 'production') Bun.gc(true)
  }
}

export const app = new Elysia()
  .use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    exposeHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges'],
  }))

  // ===== Favicon =====
  .get('/favicon.ico', ({ set }) => { set.status = 204; return '' })

  // ===== Health Check & Stats =====
  .get('/health', () => ({ 
    status: 'ok', 
    name: 'Zenload API',
    time: new Date().toISOString(),
    concurrency: {
      analyzing: { active: analyzeCapacity.getActiveCount(), limit: analyzeCapacity.getLimit() },
      downloading: { active: downloadCapacity.getActiveCount(), limit: downloadCapacity.getLimit() },
    }
  }))
  .get('/api/health', () => ({ 
    status: 'ok', 
    name: 'Zenload API',
    time: new Date().toISOString(),
    concurrency: {
      analyzing: { active: analyzeCapacity.getActiveCount(), limit: analyzeCapacity.getLimit() },
      downloading: { active: downloadCapacity.getActiveCount(), limit: downloadCapacity.getLimit() },
    }
  }))

  // ===== ปิด Cookie Leak และแสดงเฉพาะ System Status ปลอดภัย =====
  .get('/api/system/status', async () => {
    const [ytdlpOk, denoOk, ffmpegOk, galleryDlOk] = await Promise.all([
      (async () => {
        try {
          const proc = Bun.spawn(['yt-dlp', '--version'], { stdout: 'ignore', stderr: 'ignore' })
          return (await proc.exited) === 0
        } catch {
          return false
        }
      })(),
      (async () => {
        try {
          const proc = Bun.spawn(['deno', '--version'], { stdout: 'ignore', stderr: 'ignore' })
          return (await proc.exited) === 0
        } catch {
          return false
        }
      })(),
      (async () => {
        try {
          const proc = Bun.spawn(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' })
          return (await proc.exited) === 0
        } catch {
          return false
        }
      })(),
      checkGalleryDl(),
    ])

    return {
      success: true,
      name: 'Zenload API',
      status: 'ok',
      tools: {
        ytDlp: ytdlpOk,
        deno: denoOk,
        ffmpeg: ffmpegOk,
        galleryDl: galleryDlOk,
      },
      concurrency: {
        analyzing: { active: analyzeCapacity.getActiveCount(), limit: analyzeCapacity.getLimit() },
        downloading: { active: downloadCapacity.getActiveCount(), limit: downloadCapacity.getLimit() },
      }
    }
  })

  // ===== Proxy รูปภาพ พร้อมการป้องกัน SSRF แบบเข้มงวด =====
  .get('/api/proxy-image', async ({ query, set }) => {
    const imageUrl = query.url as string
    if (!imageUrl) {
      set.status = 400
      return 'Missing url parameter'
    }

    let parsed: URL
    try {
      parsed = parseAndValidateUrl(imageUrl)
    } catch (e) {
      set.status = 400
      return (e as Error).message
    }

    // SSRF Check: Image Proxy Domain Allowlist or Public Destination Assert
    if (!isAllowedImageProxyHost(parsed.hostname)) {
      try {
        await assertSafePublicDestination(parsed.hostname)
      } catch (e) {
        set.status = 403
        return 'Destination not allowed for image proxy'
      }
    }

    const abortCtrl = new AbortController()
    const timer = setTimeout(() => abortCtrl.abort(), 10000)

    try {
      const resp = await safeFetch(parsed.href, {
        headers: { 'User-Agent': UA },
        signal: abortCtrl.signal,
      })
      clearTimeout(timer)

      if (!resp.ok) {
        set.status = resp.status
        return 'Failed to fetch image'
      }

      const contentType = resp.headers.get('content-type') || 'image/jpeg'
      if (!contentType.startsWith('image/')) {
        set.status = 400
        return 'Target resource is not an image'
      }

      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10)
      if (contentLength > 15 * 1024 * 1024) {
        set.status = 413
        return 'Image size exceeds maximum limit'
      }

      set.headers['content-type'] = contentType
      set.headers['cache-control'] = 'public, max-age=3600'
      set.headers['access-control-allow-origin'] = '*'

      return new Response(resp.body, {
        headers: { 'Content-Type': contentType },
      })
    } catch (error) {
      clearTimeout(timer)
      log('error', 'Image proxy failed', { url: imageUrl, error: (error as Error).message })
      set.status = 502
      return 'Image proxy failed'
    }
  })

  // ===== วิเคราะห์ลิงก์ (Safe Parse, Concurrency & Rate Limit Guard) =====
  .post('/api/analyze', async ({ body, set, request, server }): Promise<ApiResponse> => {
    const { url } = body
    const clientIp = getClientIp(request, server)

    // 1. IP Rate Limiting
    analyzeRateLimiter.check(clientIp)

    if (!url || !isValidUrl(url)) {
      set.status = 400
      return { success: false, error: { code: 'INVALID_URL', message: 'กรุณาใส่ลิงก์ที่ถูกต้องครับ' } }
    }

    // 2. ตรวจสอบจาก Cache ก่อนดึงข้อมูลหนัก
    const detected = detectUrl(url)
    const cachedData = mediaCache.get(detected.originalUrl)
    if (cachedData) {
      return { success: true, data: cachedData }
    }

    // 3. Reserve analysis capacity without a waiting queue.
    const releaseCapacity = analyzeCapacity.tryAcquire()
    if (!releaseCapacity) {
      return handleError(analyzeCapacity.getBusyError(), set)
    }

    const abortCtrl = new AbortController()
    const timer = setTimeout(() => abortCtrl.abort(), MAX_ANALYZE_DURATION_MS)

    try {
      log('info', `Analyzing (${clientIp}): ${detected.platform} → ${url}`)

      let data: any
      if ((detected.contentType === 'album' || (detected.platform === 'instagram' && detected.contentType === 'post')) &&
          await checkGalleryDl() && galleryDlAdapter.canHandle(detected.originalUrl, detected.platform)) {
        try {
          data = await galleryDlAdapter.getInfo(detected.originalUrl, abortCtrl.signal)
        } catch (error) {
          log('warn', 'Gallery extraction failed; trying video extractor', { code: error instanceof AppError ? error.code : 'EXTRACT_FAILED' })
        }
      }

      if (!data) {
        switch (detected.platform) {
          case 'youtube':
            data = await getYoutubeInfo(detected.originalUrl, abortCtrl.signal)
            break
          case 'instagram':
            data = await getInstagramInfo(detected.originalUrl, detected.identifier, detected.contentType, abortCtrl.signal)
            break
          case 'facebook':
            data = await getFacebookInfo(detected.originalUrl, detected.identifier, detected.contentType, abortCtrl.signal)
            break
          case 'soundcloud':
            data = await getSoundcloudInfo(detected.originalUrl, abortCtrl.signal)
            break
          case 'direct':
            data = await directMediaAdapter.getInfo(detected.originalUrl, abortCtrl.signal)
            break
          case 'tiktok':
            if (detected.contentType === 'album' || detected.originalUrl.includes('/photo/')) {
              data = await galleryDlAdapter.getInfo(detected.originalUrl, abortCtrl.signal)
            } else {
              try {
                data = await getGenericInfo(detected.originalUrl, detected.platform, abortCtrl.signal)
              } catch (genericErr) {
                // ถ้า yt-dlp ไม่รองรับ (เช่น เป็น short link vt.tiktok.com ที่ชี้ไปยัง photo post) ให้ลองดึงผ่าน gallery-dl
                try {
                  data = await galleryDlAdapter.getInfo(detected.originalUrl, abortCtrl.signal)
                } catch {
                  throw genericErr
                }
              }
            }
            break
          case 'twitter':
          case 'reddit':
          case 'vimeo':
          case 'dailymotion':
          case 'twitch':
            data = await getGenericInfo(detected.originalUrl, detected.platform, abortCtrl.signal)
            break
          default:
            try {
              data = await getYoutubeInfo(detected.originalUrl, abortCtrl.signal)
            } catch {
              set.status = 400
              return {
                success: false,
                error: {
                  code: 'UNSUPPORTED',
                  message: 'ยังไม่รองรับลิงก์นี้ครับ',
                  suggestion: 'ลองใช้ลิงก์จาก YouTube, Instagram, Facebook, TikTok, Twitter, Reddit, Vimeo, Dailymotion, Twitch หรือ SoundCloud',
                },
              }
            }
        }
      }

      clearTimeout(timer)

      // Proxy thumbnail และรายการรูปในอัลบั้มสำหรับ Facebook/Instagram/TikTok (รองรับ BACKEND_PUBLIC_URL สำหรับ Vercel+Oracle)
      if (data && (data.platform === 'facebook' || data.platform === 'instagram' || data.platform === 'tiktok')) {
        const backendBase = process.env.BACKEND_PUBLIC_URL?.replace(/\/$/, '') || ''
        const wrapProxy = (rawUrl?: string) => {
          if (!rawUrl) return rawUrl
          if (rawUrl.startsWith('/api/proxy-image') || rawUrl.includes('/api/proxy-image?url=')) return rawUrl
          return `${backendBase}/api/proxy-image?url=${encodeURIComponent(rawUrl)}`
        }

        if (data.thumbnail) {
          data.thumbnail = wrapProxy(data.thumbnail)
        }
        if (data.items && Array.isArray(data.items)) {
          for (const item of data.items) {
            if (item.thumbnail) item.thumbnail = wrapProxy(item.thumbnail)
            if (item.url && item.kind === 'image') {
              ;(item as any).rawUrl = item.url
              item.url = wrapProxy(item.url)
            }
          }
        }
      }

      // บันทึก Cache (10 นาที)
      if (data) {
        mediaCache.set(url, data)
        mediaCache.set(detected.originalUrl, data)
      }

      return { success: true, data }
    } catch (error) {
      clearTimeout(timer)
      return handleError(error, set)
    } finally {
      releaseCapacity()
    }
  }, {
    body: t.Object({
      url: t.String()
    })
  })

  // ===== เริ่มงานดาวน์โหลด (POST: รองรับ Access Token & SQLite Persistence) =====
  .post('/api/download/start', async ({ body, set, request, server }) => {
    const { url, option } = body
    const clientIp = getClientIp(request, server)

    // 1. ตรวจ Rate Limit
    downloadRateLimiter.check(clientIp)

    if (!url || !option || !isValidUrl(url)) {
      set.status = 400
      return { success: false, error: { code: 'INVALID_PARAMS', message: 'กรุณาระบุ URL และตัวเลือกที่ถูกต้อง' } }
    }

    // 2. Reserve download capacity before disk checks and SQLite job creation.
    const releaseCapacity = downloadCapacity.tryAcquire()
    if (!releaseCapacity) {
      const busyErr = downloadCapacity.getBusyError()
      set.status = busyErr.statusCode
      return {
        success: false,
        error: {
          code: busyErr.code,
          message: busyErr.message,
        },
      }
    }

    let capacityTransferred = false
    try {
      // 3. ตรวจสอบพื้นที่ว่างบนดิสก์
      await assertSufficientDiskSpace(getTempDir())

      const detected = detectUrl(url)

      // 4. สร้าง Job ลง SQLite พร้อม Access Token
      const { jobId, accessToken, abortController } = createJob({
        url: detected.originalUrl,
        optionId: option,
        platform: detected.platform,
        identifier: detected.identifier,
      })

      // 5. Start the worker with the capacity lease already reserved.
      runDownloadJob(jobId, detected.originalUrl, option, detected.platform, detected.identifier, abortController, releaseCapacity)
      capacityTransferred = true

      return { success: true, jobId, accessToken }
    } finally {
      if (!capacityTransferred) releaseCapacity()
    }
  }, {
    body: t.Object({
      url: t.String(),
      option: t.String(),
    })
  })

  // ===== ตรวจสอบสถานะการดาวน์โหลด (พร้อมตรวจ Access Token) =====
  .get('/api/download/status', ({ query, headers, set }) => {
    const jobId = query.jobId as string
    const token = (query.token as string) || (headers['x-job-token'] as string)

    if (!jobId) {
      set.status = 400
      return { success: false, error: { code: 'MISSING_JOB_ID', message: 'กรุณาระบุ jobId' } }
    }

    try {
      const job = verifyJobOwnership(jobId, token)
      return {
        success: true,
        status: job.status,
        stage: job.stage || 'downloading',
        progress: job.progress,
        error: job.error,
        filename: job.filename,
        fileSize: job.file_size,
      }
    } catch (err) {
      if (err instanceof AppError) {
        set.status = err.statusCode
        return { success: false, error: { code: err.code, message: err.message } }
      }
      set.status = 500
      return { success: false, error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดในการตรวจสอบสถานะ' } }
    }
  }, {
    query: t.Object({
      jobId: t.String(),
      token: t.Optional(t.String()),
    })
  })

  // ===== ยกเลิกงานดาวน์โหลดบนเซิร์ฟเวอร์ (POST) =====
  .post('/api/download/cancel', async ({ body, query, headers, set }) => {
    const jobId = ((body as any)?.jobId || query.jobId) as string
    const token = ((body as any)?.token || query.token || headers['x-job-token']) as string

    if (!jobId) {
      set.status = 400
      return { success: false, error: { code: 'MISSING_JOB_ID', message: 'กรุณาระบุ jobId' } }
    }

    try {
      verifyJobOwnership(jobId, token)
      await abortJob(jobId)
      log('info', `Client canceled download job: ${jobId}`)
      return { success: true }
    } catch (err) {
      if (err instanceof AppError) {
        set.status = err.statusCode
        return { success: false, error: { code: err.code, message: err.message } }
      }
      set.status = 500
      return { success: false, error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดในการยกเลิก' } }
    }
  }, {
    body: t.Optional(t.Object({
      jobId: t.Optional(t.String()),
      token: t.Optional(t.String()),
    })),
    query: t.Optional(t.Object({
      jobId: t.Optional(t.String()),
      token: t.Optional(t.String()),
    }))
  })

  // ===== ดาวน์โหลดไฟล์ (รองรับ Range / Resume และไม่สะสมใน JS RAM) =====
  .get('/api/download', async ({ query, headers, set }) => {
    const jobId = query.jobId as string
    const token = (query.token as string) || (headers['x-job-token'] as string)

    // 1. ดึงไฟล์จาก Background Job
    if (jobId) {
      try {
        const job = verifyJobOwnership(jobId, token)

        if (job.status === 'failed') {
          set.status = 500
          return { success: false, error: { code: 'DOWNLOAD_FAILED', message: job.error || 'การดาวน์โหลดล้มเหลว' } }
        }

        if (job.status === 'aborted') {
          set.status = 499
          return { success: false, error: { code: 'DOWNLOAD_ABORTED', message: 'การดาวน์โหลดถูกยกเลิกแล้ว' } }
        }

        if (job.status !== 'completed' || !job.file_path) {
          set.status = 400
          return { success: false, error: { code: 'JOB_NOT_READY', message: 'ไฟล์ดาวน์โหลดยังไม่พร้อมใช้งาน' } }
        }

        if (!isSafeSubpath(getTempDir(), job.file_path)) {
          set.status = 403
          return { success: false, error: { code: 'FORBIDDEN', message: 'ไม่อนุญาตให้เข้าถึงไฟล์นอกโฟลเดอร์ดาวน์โหลด' } }
        }

        const file = Bun.file(job.file_path)
        if (!(await file.exists())) {
          set.status = 500
          return { success: false, error: { code: 'FILE_NOT_FOUND', message: 'ไม่พบไฟล์บนเซิร์ฟเวอร์ ลองใหม่อีกครั้ง' } }
        }

        const fileSize = file.size
        if (fileSize === 0) {
          set.status = 500
          return { success: false, error: { code: 'EMPTY_FILE', message: 'ไฟล์ที่ดาวน์โหลดว่างเปล่า (0 byte)' } }
        }

        const encodedFilename = encodeURIComponent(job.filename || 'download')
        set.headers['content-type'] = job.content_type || 'application/octet-stream'
        set.headers['content-length'] = String(fileSize)
        set.headers['content-disposition'] = `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
        set.headers['accept-ranges'] = 'bytes'

        // Bun.file รองรับ Range Request 206 อัตโนมัติสำหรับการ Pause/Resume
        return file
      } catch (err) {
        if (err instanceof AppError) {
          set.status = err.statusCode
          return { success: false, error: { code: err.code, message: err.message } }
        }
        set.status = 500
        return { success: false, error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดในการดึงไฟล์' } }
      }
    }

    set.status = 400
    return { success: false, error: { code: 'MISSING_JOB_ID', message: 'กรุณาระบุ jobId เพื่อดาวน์โหลดไฟล์' } }
  }, {
    query: t.Object({
      jobId: t.String(),
      token: t.Optional(t.String()),
    })
  })

  // ===== Global Error Handler =====
  .onError(({ code, error, set }) => {
    if (code === 'NOT_FOUND') {
      set.status = 404
      return { success: false, error: { code: 'NOT_FOUND', message: 'ไม่พบเส้นทางหรือหน้าที่ร้องขอ' } }
    }
    if (error instanceof AppError) {
      set.status = error.statusCode
      return { success: false, error: { code: error.code, message: error.message, suggestion: error.suggestion } }
    }
    log('error', 'Unhandled error', { message: (error as Error).message })
    set.status = 500
    return { success: false, error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่ครับ' } }
  })

// ===== Serve Frontend (Production or when dist exists) =====
const frontendDistPath = resolve(import.meta.dir, '../../frontend/dist')
const distExists = await Bun.file(join(frontendDistPath, 'index.html')).exists()

if (process.env.NODE_ENV === 'production' || distExists) {
  app.get('*', async ({ path, set }) => {
    if (path.startsWith('/api/')) {
      log('warn', `Unmatched API path: ${path}`)
      set.status = 404
      return { error: 'API endpoint not found' }
    }

    let cleanPath = path
    if (cleanPath === '/zenload' || cleanPath === '/zenload/') {
      cleanPath = 'index.html'
    } else if (cleanPath.startsWith('/zenload/')) {
      cleanPath = cleanPath.slice('/zenload/'.length)
    } else if (cleanPath === '/') {
      cleanPath = 'index.html'
    } else {
      cleanPath = cleanPath.replace(/^\//, '')
    }

    const filePath = join(frontendDistPath, cleanPath)
    const file = Bun.file(filePath)

    if (await file.exists()) {
      if (cleanPath.endsWith('.js')) set.headers['content-type'] = 'application/javascript; charset=utf-8'
      else if (cleanPath.endsWith('.css')) set.headers['content-type'] = 'text/css; charset=utf-8'
      else if (cleanPath.endsWith('.png')) set.headers['content-type'] = 'image/png'
      else if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) set.headers['content-type'] = 'image/jpeg'
      else if (cleanPath.endsWith('.svg')) set.headers['content-type'] = 'image/svg+xml'
      else if (cleanPath.endsWith('.ico')) set.headers['content-type'] = 'image/x-icon'
      else if (cleanPath.endsWith('.json') || cleanPath.endsWith('.webmanifest')) set.headers['content-type'] = 'application/manifest+json'
      else if (cleanPath.endsWith('.woff2')) set.headers['content-type'] = 'font/woff2'
      else if (cleanPath.endsWith('.woff')) set.headers['content-type'] = 'font/woff'
      else if (cleanPath.endsWith('.html')) set.headers['content-type'] = 'text/html; charset=utf-8'

      if (cleanPath.startsWith('assets/') || cleanPath.startsWith('fonts/')) {
        set.headers['cache-control'] = 'public, max-age=31536000, immutable'
      } else {
        set.headers['cache-control'] = 'public, max-age=3600'
      }

      return file
    }

    const indexFile = Bun.file(join(frontendDistPath, 'index.html'))
    if (!(await indexFile.exists())) {
      set.status = 500
      return 'Frontend not built'
    }

    set.headers['content-type'] = 'text/html; charset=utf-8'
    set.headers['cache-control'] = 'no-cache'
    return indexFile
  })
}

// เริ่มต้นระบบ
await initCookies()
await initJobManager()
await checkGalleryDl()

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT)
  log('info', `🦊 Zenload API Backend running at http://localhost:${PORT}`)
  if (process.env.NODE_ENV === 'production' || distExists) {
    log('info', `📦 Serving frontend from ${frontendDistPath}`)
  }
}

// ===== Helper =====
function handleError(error: unknown, set: { status?: any }): ApiResponse {
  if (error instanceof AppError) {
    set.status = error.statusCode
    return { success: false, error: { code: error.code, message: error.message, suggestion: error.suggestion } }
  }
  log('error', 'Unexpected error', { message: (error as Error).message })
  set.status = 500
  return { success: false, error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่ครับ' } }
}
