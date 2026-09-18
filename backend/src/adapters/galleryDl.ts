import type { DownloaderAdapter } from './types'
import type { Platform, MediaInfo, DownloadResult, DownloadStage, MediaItem } from '../types'
import { AppError } from '../utils/errors'
import { ensureTempDir, getCookiesPath, sanitizeFilename } from '../utils/helpers'
import { killProcessTree, cleanupPartialFiles } from '../utils/process'
import { join } from 'node:path'
import { readdir, rm, mkdir } from 'node:fs/promises'
import { getProxyForUrl } from '../utils/networkProxy'

let galleryDlInstalled = false
let galleryDlCommand: string[] | null = null

export async function getGalleryDlCommand(): Promise<string[] | null> {
  if (galleryDlCommand) return galleryDlCommand

  // 1. ลองหา standalone binary 'gallery-dl'
  try {
    const proc = Bun.spawn(['gallery-dl', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    if ((await proc.exited) === 0) {
      galleryDlCommand = ['gallery-dl']
      galleryDlInstalled = true
      return galleryDlCommand
    }
  } catch {}

  // 2. ลองหาผ่าน python module 'python -m gallery_dl'
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    const proc = Bun.spawn([pythonCmd, '-m', 'gallery_dl', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    if ((await proc.exited) === 0) {
      galleryDlCommand = [pythonCmd, '-m', 'gallery_dl']
      galleryDlInstalled = true
      return galleryDlCommand
    }
  } catch {}

  galleryDlInstalled = false
  return null
}

export async function checkGalleryDl(): Promise<boolean> {
  const cmd = await getGalleryDlCommand()
  return !!cmd
}

async function collectFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isFile()) {
        const parent = entry.parentPath || (entry as any).path || dir
        files.push(join(parent, entry.name))
      }
    }
    return files
  } catch {
    return []
  }
}

async function createZipArchive(sourceDir: string, destZipPath: string): Promise<void> {
  const pythonScript = `
import zipfile, os, sys
src = sys.argv[1]
dst = sys.argv[2]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, src)
            zf.write(full_path, rel_path)
`
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  const proc = Bun.spawn([pythonCmd, '-c', pythonScript, sourceDir, destZipPath], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new AppError('ZIP_FAILED', `สร้างไฟล์ ZIP ไม่สำเร็จ: ${err}`, 500)
  }
}

function unwrapProxyUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  if (rawUrl.startsWith('/api/proxy-image') || rawUrl.includes('/api/proxy-image?url=')) {
    try {
      const parsed = new URL(rawUrl, 'http://localhost')
      const extracted = parsed.searchParams.get('url')
      if (extracted) return extracted
    } catch {}
  }
  return rawUrl
}

async function resolveShortlink(url: string, signal?: AbortSignal): Promise<string> {
  if (/https?:\/\/(?:vt|vm)\.tiktok\.com\//i.test(url)) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      })
      if (res.url && res.url !== url) {
        return res.url
      }
    } catch {}
  }
  return url
}

export class GalleryDlAdapter implements DownloaderAdapter {
  readonly name = 'gallery-dl'

  canHandle(_url: string, platform: Platform): boolean {
    if (!['instagram', 'twitter', 'reddit', 'tiktok'].includes(platform)) return false
    if (galleryDlCommand === null && !galleryDlInstalled) return true
    return galleryDlInstalled
  }

  async getInfo(url: string, signal?: AbortSignal): Promise<MediaInfo> {
    const targetUrl = await resolveShortlink(url, signal)
    const cmd = await getGalleryDlCommand()
    if (!cmd) {
      throw new AppError('GALLERY_DL_NOT_INSTALLED', 'เครื่องมือ gallery-dl ไม่ได้ถูกติดตั้งบนระบบ', 501)
    }

    const cookiesPath = getCookiesPath()
    const cookieArgs = cookiesPath && (await Bun.file(cookiesPath).exists()) ? ['--cookies', cookiesPath] : []
    const proxy = getProxyForUrl(targetUrl)
    const proxyArgs = proxy !== undefined ? ['--proxy', proxy] : []

    const uaArgs = ['--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36']
    const proc = Bun.spawn([...cmd, ...uaArgs, ...cookieArgs, ...proxyArgs, '-j', '--no-download', targetUrl], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const onAbort = () => { killProcessTree(proc).catch(() => {}) }
    if (signal) signal.addEventListener('abort', onAbort)

    let output = ''
    let errorOutput = ''
    let exitCode = 0

    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      output = out
      errorOutput = err
      exitCode = await proc.exited
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    if (exitCode !== 0 || !output.trim()) {
      throw new AppError('GALLERY_EXTRACT_FAILED', `ไม่สามารถดึงข้อมูลอัลบั้มได้: ${errorOutput.substring(0, 200)}`, 500)
    }

    const items: MediaItem[] = []
    let rawObjects: any[] = []

    // 1. ตรวจสอบว่า gallery-dl ส่ง output มาเป็น JSON Array ก้อนเดียว หรือแยกทีละบรรทัด
    try {
      const parsedAll = JSON.parse(output.trim())
      if (Array.isArray(parsedAll)) {
        rawObjects = typeof parsedAll[0] === 'number' ? [parsedAll] : parsedAll
      } else if (typeof parsedAll === 'object' && parsedAll !== null) {
        rawObjects = [parsedAll]
      }
    } catch {
      const lines = output.trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          rawObjects.push(JSON.parse(line))
        } catch {}
      }
    }

    // 2. ดึง Directory Metadata (Message 2) ถ้ามี
    let albumMeta: any = null
    for (const itemData of rawObjects) {
      if (Array.isArray(itemData) && itemData[0] === 2 && typeof itemData[1] === 'object' && itemData[1] !== null) {
        albumMeta = itemData[1]
      }
    }

    // 3. ตรวจสอบ platform จาก URL
    const isTikTok = url.includes('tiktok.com')
    const isTwitter = url.includes('twitter.com') || url.includes('x.com')
    const isReddit = url.includes('reddit.com') || url.includes('redd.it')
    const detectedPlatform: Platform = isTikTok ? 'tiktok' : isTwitter ? 'twitter' : isReddit ? 'reddit' : 'instagram'

    let index = 1
    for (const itemData of rawObjects) {
      // โครงสร้างของ gallery-dl -j:
      // Message.Url = 3; Message.Directory = 2; Message.Queue = 6.
      let mediaUrl = ''
      let post: any = null
      if (Array.isArray(itemData)) {
        if (itemData[0] === 3 && typeof itemData[1] === 'string') {
          mediaUrl = itemData[1]
          post = itemData[2] || {}
        }
      } else if (typeof itemData === 'object' && itemData !== null) {
        mediaUrl = itemData.url || (Array.isArray(itemData.urls) ? itemData.urls[0] : '')
        post = itemData
      }

      if (!mediaUrl || typeof mediaUrl !== 'string' || !/^https?:\/\//i.test(mediaUrl)) {
        continue
      }

      const isAudio =
        post?.type === 'audio' ||
        mediaUrl.includes('mime_type=audio') ||
        mediaUrl.endsWith('.mp3') ||
        mediaUrl.endsWith('.m4a') ||
        mediaUrl.endsWith('.wav')

      const isVideo =
        !isAudio &&
        (post?.type === 'video' ||
          mediaUrl.includes('.mp4') ||
          mediaUrl.includes('.webm') ||
          mediaUrl.includes('.m4v'))

      if (isAudio) {
        const audioTitle = post?.music?.title || post?.title || 'เสียงต้นฉบับ / แผ่นเสียง'
        const audioThumb = post?.music?.coverLarge || post?.music?.coverMedium || items[0]?.thumbnail || ''
        items.push({
          id: `item_${index}`,
          kind: 'audio',
          title: `แผ่นเสียง: ${audioTitle}`,
          url: mediaUrl,
          thumbnail: audioThumb,
          duration: post?.music?.duration || post?.duration,
          options: [
            {
              id: `item_${index}_download`,
              label: `ดาวน์โหลด แผ่นเสียง (MP3)`,
              format: 'mp3',
              quality: 'Original',
            },
          ],
        })
      } else if (isVideo) {
        items.push({
          id: `item_${index}`,
          kind: 'video',
          title: post?.title ? `วิดีโอ #${index}: ${post.title.slice(0, 30)}` : `วิดีโอ #${index}`,
          url: mediaUrl,
          thumbnail: post?.thumbnail || mediaUrl,
          options: [
            {
              id: `item_${index}_download`,
              label: `ดาวน์โหลด วิดีโอ #${index} (HD)`,
              format: 'mp4',
              quality: 'HD',
            },
          ],
        })
      } else {
        const imgNum = post?.num || index
        items.push({
          id: `item_${index}`,
          kind: 'image',
          title: `รูปภาพ #${imgNum}`,
          url: mediaUrl,
          thumbnail: mediaUrl,
          options: [
            {
              id: `item_${index}_download`,
              label: `ดาวน์โหลด รูปภาพ #${imgNum} (HD)`,
              format: 'jpg',
              quality: 'HD',
            },
          ],
        })
      }
      index++
    }

    if (items.length === 0) {
      // ตรวจสอบ Message.Queue (6) ซึ่ง gallery-dl ส่งมาเมื่อเป็นลิงก์ย่อ เช่น vt.tiktok.com หรือ vm.tiktok.com
      const queuedItem = rawObjects.find(
        (obj) => Array.isArray(obj) && obj[0] === 6 && typeof obj[1] === 'string' && /^https?:\/\//i.test(obj[1])
      )
      if (queuedItem && queuedItem[1] !== url) {
        return this.getInfo(queuedItem[1], signal)
      }

      throw new AppError('GALLERY_EXTRACT_FAILED', 'ไม่พบไฟล์รูปภาพหรือวิดีโอที่สามารถดาวน์โหลดได้ในโพสต์หรืออัลบั้มนี้ (อาจเป็นบัญชีส่วนตัว หรือต้องการ Cookies ใน cookies.txt)', 404)
    }

    const imageCount = items.filter((i) => i.kind === 'image').length
    const hasAudio = items.some((i) => i.kind === 'audio')
    const albumZipOption = {
      id: 'album_zip',
      label: `ดาวน์โหลดทั้งอัลบั้ม (${imageCount > 0 ? `${imageCount} รูปภาพ` : `${items.length} รายการ`}${hasAudio ? ' + แผ่นเสียง' : ''} เป็น ZIP)`,
      format: 'zip',
      quality: 'Original',
    }

    const authorName = albumMeta?.author?.nickname || albumMeta?.user || ''
    const postCaption = albumMeta?.desc || albumMeta?.title || ''
    const displayTitle = postCaption
      ? (authorName ? `${authorName}: ${postCaption.slice(0, 80)}` : postCaption.slice(0, 80))
      : `${detectedPlatform === 'tiktok' ? 'TikTok' : 'Gallery'} (${items.length} รายการ)`

    return {
      platform: detectedPlatform,
      contentType: 'album',
      title: displayTitle,
      thumbnail: items[0]?.thumbnail || items[0]?.url || '',
      author: authorName,
      uploader: albumMeta?.user || authorName,
      items,
      options: [albumZipOption, ...items.flatMap((i) => i.options)],
    }
  }

  async download(
    url: string,
    optionId: string,
    signal?: AbortSignal,
    onProgress?: (progress: number, stage: DownloadStage) => void,
    cachedMeta?: { title?: string; filename?: string; items?: MediaItem[] }
  ): Promise<DownloadResult> {
    // 1. Direct Fast Fetch สำหรับชิ้นเดียวถ้ามี URL ใน cachedMeta
    const itemMatch = optionId.match(/^item_(\d+)_download$/)
    if (itemMatch && cachedMeta && Array.isArray((cachedMeta as any).items)) {
      const matchedItem = (cachedMeta as any).items.find((it: any) => it.id === `item_${itemMatch[1]}`)
      const rawTargetUrl = unwrapProxyUrl((matchedItem as any)?.rawUrl || matchedItem?.url)
      if (rawTargetUrl && /^https?:\/\//i.test(rawTargetUrl)) {
        try {
          onProgress?.(20, 'downloading')
          const res = await fetch(rawTargetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            signal,
          })
          if (res.ok) {
            const ext = matchedItem.options?.[0]?.format || (matchedItem.kind === 'audio' ? 'mp3' : matchedItem.kind === 'video' ? 'mp4' : 'jpg')
            let contentType = res.headers.get('content-type') || (matchedItem.kind === 'audio' ? 'audio/mpeg' : matchedItem.kind === 'video' ? 'video/mp4' : 'image/jpeg')
            const tempDir = await ensureTempDir()
            const uniqueId = Math.random().toString(36).substring(7)
            const baseName = sanitizeFilename(matchedItem.title || `item_${itemMatch[1]}`)
            const filename = `${baseName}.${ext}`
            const filePath = join(tempDir, `item_${uniqueId}_${filename}`)
            const buffer = await res.arrayBuffer()
            await Bun.write(filePath, buffer)
            onProgress?.(100, 'ready')
            return {
              filePath,
              filename,
              contentType,
            }
          }
        } catch {}
      }
    }

    // 2. Direct Fast Fetch สำหรับทั้งอัลบั้มถ้ามี items ใน cachedMeta
    if (optionId === 'album_zip' && cachedMeta && Array.isArray((cachedMeta as any).items) && (cachedMeta as any).items.length > 0) {
      try {
        const items = (cachedMeta as any).items as MediaItem[]
        const tempDir = await ensureTempDir()
        const uniqueId = Math.random().toString(36).substring(7)
        const outDir = join(tempDir, `album_${uniqueId}`)
        await mkdir(outDir, { recursive: true })

        onProgress?.(15, 'downloading')
        let count = 0
        await Promise.all(
          items.map(async (item, idx) => {
            const rawTargetUrl = unwrapProxyUrl((item as any)?.rawUrl || item?.url)
            if (!rawTargetUrl || !/^https?:\/\//i.test(rawTargetUrl)) return
            try {
              const res = await fetch(rawTargetUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                signal,
              })
              if (!res.ok) return
              const ext = item.options?.[0]?.format || (item.kind === 'audio' ? 'mp3' : item.kind === 'video' ? 'mp4' : 'jpg')
              const baseName = sanitizeFilename(item.title || `item_${idx + 1}`)
              const fname = `${String(idx + 1).padStart(2, '0')}_${baseName}.${ext}`
              const buf = await res.arrayBuffer()
              await Bun.write(join(outDir, fname), buf)
              count++
              onProgress?.(15 + Math.round((count / items.length) * 55), 'downloading')
            } catch {}
          })
        )

        const files = await collectFiles(outDir)
        if (files.length > 0) {
          onProgress?.(80, 'merging')
          const zipPath = join(tempDir, `album_${uniqueId}.zip`)
          await createZipArchive(outDir, zipPath)
          await rm(outDir, { recursive: true, force: true }).catch(() => {})

          const zipFilename = cachedMeta.title
            ? `${sanitizeFilename(cachedMeta.title).slice(0, 60)}_album.zip`
            : 'album.zip'

          onProgress?.(100, 'ready')
          return {
            filePath: zipPath,
            filename: zipFilename,
            contentType: 'application/zip',
          }
        }
      } catch {}
    }

    const targetUrl = await resolveShortlink(url, signal)
    const cmd = await getGalleryDlCommand()
    if (!cmd) {
      throw new AppError('GALLERY_DL_NOT_INSTALLED', 'เครื่องมือ gallery-dl ไม่ได้ถูกติดตั้งบนระบบ', 501)
    }

    const tempDir = await ensureTempDir()
    const uniqueId = Math.random().toString(36).substring(7)
    const outDir = join(tempDir, `gdl_${uniqueId}`)

    // รองรับการเลือกดาวน์โหลดชิ้นเดียว (item_N_download)
    const extraArgs = itemMatch ? ['--range', itemMatch[1]] : []

    const cookiesPath = getCookiesPath()
    const cookieArgs = cookiesPath && (await Bun.file(cookiesPath).exists()) ? ['--cookies', cookiesPath] : []
    const proxy = getProxyForUrl(targetUrl)
    const proxyArgs = proxy !== undefined ? ['--proxy', proxy] : []

    onProgress?.(10, 'downloading')

    const proc = Bun.spawn([
      ...cmd,
      ...cookieArgs,
      ...proxyArgs,
      '--destination', outDir,
      ...extraArgs,
      targetUrl
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const onAbort = () => {
      killProcessTree(proc).catch(() => {})
      cleanupPartialFiles(outDir).catch(() => {})
    }
    if (signal) signal.addEventListener('abort', onAbort)

    try {
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new AppError('DOWNLOAD_FAILED', 'การดาวน์โหลดผ่าน gallery-dl ล้มเหลว', 500)
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const files = await collectFiles(outDir)
    if (files.length === 0) {
      throw new AppError('DOWNLOAD_FAILED', 'ไม่พบไฟล์ผลลัพธ์จากการดาวน์โหลดของ gallery-dl', 500)
    }

    // กรณีเลือกชิ้นเดียว ให้ส่งไฟล์นั้นตรงๆ
    if (itemMatch && files.length > 0) {
      const singleFile = files[0]
      const ext = singleFile.split('.').pop()?.toLowerCase() || 'jpg'

      let contentType = 'image/jpeg'
      if (ext === 'mp3') contentType = 'audio/mpeg'
      else if (ext === 'm4a') contentType = 'audio/mp4'
      else if (ext === 'wav') contentType = 'audio/wav'
      else if (ext === 'mp4' || ext === 'webm' || ext === 'm4v') contentType = 'video/mp4'
      else if (ext === 'png') contentType = 'image/png'
      else if (ext === 'webp') contentType = 'image/webp'

      // หาชื่อไฟล์จาก cachedMeta ถ้ามี
      let outFilename = `item_${itemMatch[1]}.${ext}`
      const matchedItem = cachedMeta && Array.isArray((cachedMeta as any).items)
        ? (cachedMeta as any).items.find((it: any) => it.id === `item_${itemMatch[1]}`)
        : null
      if (matchedItem?.title) {
        outFilename = `${sanitizeFilename(matchedItem.title)}.${ext}`
      } else if (cachedMeta?.title) {
        outFilename = `${sanitizeFilename(cachedMeta.title)}_${itemMatch[1]}.${ext}`
      }

      onProgress?.(100, 'ready')
      return {
        filePath: singleFile,
        filename: outFilename,
        contentType,
      }
    }

    // กรณีดาวน์โหลดทั้งอัลบั้ม บีบอัดเป็นไฟล์ ZIP จริง
    onProgress?.(80, 'merging')
    const zipPath = join(tempDir, `album_${uniqueId}.zip`)
    await createZipArchive(outDir, zipPath)
    await rm(outDir, { recursive: true, force: true }).catch(() => {})

    const zipFilename = cachedMeta?.title
      ? `${sanitizeFilename(cachedMeta.title).slice(0, 60)}_album.zip`
      : 'album.zip'

    onProgress?.(100, 'ready')
    return {
      filePath: zipPath,
      filename: zipFilename,
      contentType: 'application/zip',
    }
  }
}
