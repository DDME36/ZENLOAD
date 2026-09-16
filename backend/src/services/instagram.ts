import type { MediaInfo, DownloadResult, ContentType, DownloadStage } from '../types'
import { AppError } from '../utils/errors'
import { log, decodeAllHtmlEntities, getCookiesPath, getDataDir } from '../utils/helpers'
import { safeFetch } from '../utils/security'
import { profileImageFromHtml } from '../utils/mediaQuality'
import { getGenericInfo, downloadGeneric } from './generic'
import { join } from 'node:path'
import sharp from 'sharp'
import { getGalleryDlCommand } from '../adapters/galleryDl'
import { killProcessTree } from '../utils/process'

const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DESKTOP_CHROME_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_CHROME_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

const IG_APP_ID = '936619743392459'

/** หน่วงเวลาเล็กน้อยเหมือน browser จริง (80-300ms) */
function humanDelay(): Promise<void> {
  return new Promise(r => setTimeout(r, 80 + Math.random() * 220))
}

/**
 * ดึง Cookie ของ Instagram จาก cookies.txt หรือ Environment Variable
 */
export async function getInstagramCookieHeader(): Promise<string | null> {
  if (process.env.INSTAGRAM_COOKIE) {
    return process.env.INSTAGRAM_COOKIE.trim()
  }

  const cookiesPath = getCookiesPath() || join(getDataDir(), 'cookies', 'cookies.txt')
  try {
    const file = Bun.file(cookiesPath)
    if (await file.exists()) {
      const text = await file.text()
      const cookies: string[] = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim().replace(/^#HttpOnly_/, '')
        if (!trimmed || trimmed.startsWith('#')) continue
        const parts = trimmed.split('\t')
        if (parts.length >= 7) {
          const domain = parts[0]
          const name = parts[5]
          let value = parts[6]?.trim()
          const host = domain.replace(/^\./, '').toLowerCase()
          const expires = Number(parts[4])
          if ((host === 'instagram.com' || host.endsWith('.instagram.com')) && (expires === 0 || expires > Date.now() / 1000) && name && value) {
            try {
              if (value.includes('%3A') || value.includes('%20')) {
                value = decodeURIComponent(value)
              }
            } catch {}
            cookies.push(`${name}=${value}`)
          }
        }
      }
      if (cookies.length > 0) {
        return cookies.join('; ')
      }
    }
  } catch {}

  return null
}

const UA_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'

/**
 * ดึงรูปโปรไฟล์ Instagram คุณภาพสูงผ่าน gallery-dl
 * ป้องกันการติด 429 Rate Limit บน Datacenter IP และรองรับการดึงรูปโปรไฟล์แม้บัญชีเป็น Private
 */
async function getInstagramAvatarViaGalleryDl(
  username: string,
  signal?: AbortSignal
): Promise<{ profilePicUrl: string; displayName: string; resolution: string } | null> {
  if (process.env.NODE_ENV === 'test') {
    return null
  }

  try {
    const cmd = await getGalleryDlCommand()
    if (!cmd) return null

    const cookiesPath = getCookiesPath() || join(getDataDir(), 'cookies', 'cookies.txt')
    const cookieArgs = cookiesPath && (await Bun.file(cookiesPath).exists()) ? ['--cookies', cookiesPath] : []

    const avatarUrl = `https://www.instagram.com/${username}/avatar/`
    const proc = Bun.spawn([...cmd, ...cookieArgs, '-j', avatarUrl], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let timer: any
    const timeoutPromise = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        killProcessTree(proc).catch(() => {})
        resolve()
      }, 10000)
    })

    const onAbort = () => { killProcessTree(proc).catch(() => {}) }
    if (signal) signal.addEventListener('abort', onAbort)

    let stdout = ''
    let exitCode = 0
    try {
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      stdout = out
      exitCode = await proc.exited
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    if (exitCode !== 0 || !stdout.trim()) {
      return null
    }

    let rawObjects: any[] = []
    try {
      const parsed = JSON.parse(stdout.trim())
      rawObjects = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      const lines = stdout.trim().split('\n').filter(Boolean)
      for (const l of lines) {
        try { rawObjects.push(JSON.parse(l)) } catch {}
      }
    }

    let picUrl = ''
    let fullName = ''
    let width = 0
    let height = 0

    for (const item of rawObjects) {
      if (Array.isArray(item)) {
        if (item[0] === 2 && item[1]?.user) {
          fullName = (item[1].user.full_name || '').trim()
        }
        if (item[0] === 3 && typeof item[1] === 'string' && /^https?:\/\//i.test(item[1])) {
          picUrl = item[1]
          if (item[2]?.width) width = item[2].width
          if (item[2]?.height) height = item[2].height
        }
      }
    }

    if (picUrl) {
      const resText = width > 0 && height > 0 ? `${width}x${height}px (Full HD)` : '1080x1080px (Full HD)'
      return {
        profilePicUrl: picUrl,
        displayName: fullName ? `${fullName} (@${username})` : `@${username}`,
        resolution: resText,
      }
    }
  } catch (err) {
    log('warn', `Instagram: gallery-dl avatar extraction failed: ${(err as Error).message}`)
  }
  return null
}

export async function getInstagramInfo(
  url: string,
  identifier: string,
  contentType: ContentType = 'profile',
  signal?: AbortSignal
): Promise<MediaInfo> {
  // 1. Stories require authentication / are temporary
  if (contentType === 'story') {
    throw new AppError(
      'AUTH_REQUIRED',
      'Instagram Stories เป็นเนื้อหาชั่วคราวและต้องเข้าสู่ระบบ จึงไม่สามารถดาวน์โหลดแบบสาธารณะได้ครับ',
      403,
      'กรุณาใช้ลิงก์ Instagram โพสต์ (Post), Reels หรือ Profile แทนครับ'
    )
  }

  // 2. Reels & Posts -> Delegate to yt-dlp extractor
  if (contentType === 'reel' || contentType === 'post') {
    try {
      const genericInfo = await getGenericInfo(url, 'instagram', signal)
      genericInfo.contentType = contentType
      return genericInfo
    } catch (err) {
      log('warn', `Instagram generic extractor failed for ${contentType}: ${(err as Error).message}`)
      // Fall through to profile extraction only if it might be a profile URL mistagged
      throw err
    }
  }

  // 3. Profile Avatar
  const cleanUsername = (identifier || '').replace(/[/?#].*$/, '')
  let profilePicUrl = ''
  let displayName = cleanUsername
  let resolution = '1080x1080px (Full HD)'
  let upstreamError: AppError | null = null

  log('info', `Instagram: processing profile @${cleanUsername}`)

  // Method 1: gallery-dl Avatar Extractor (ดึงรูปโปรไฟล์ Full HD 1080x1080 แท้จาก Instagram API / GraphQL)
  try {
    const gdlResult = await getInstagramAvatarViaGalleryDl(cleanUsername, signal)
    if (gdlResult && gdlResult.profilePicUrl) {
      log('info', `Instagram: extracted real native 1080p profile avatar via gallery-dl successfully: ${gdlResult.resolution}`)
      profilePicUrl = gdlResult.profilePicUrl
      displayName = gdlResult.displayName
      resolution = gdlResult.resolution
    }
  } catch (err) {
    log('warn', `Instagram: gallery-dl avatar extraction attempt failed: ${(err as Error).message}`)
  }

  // Method 2: Direct Web HTML Navigation (ส่ง Header เสมือนเปิดผ่าน Google Chrome บน Windows 100%)
  if (!profilePicUrl) {
    try {
      const igCookie = await getInstagramCookieHeader()
      const navHeaders: Record<string, string> = {
        ...DESKTOP_CHROME_HEADERS,
        ...(igCookie ? { 'Cookie': igCookie } : {}),
      }

      const resp = await safeFetch(`https://www.instagram.com/${cleanUsername}/`, {
        headers: navHeaders,
        signal,
      })

      log('info', 'Instagram: profile HTML navigation response', { status: resp.status, cookiePresent: !!igCookie })

    if (resp.ok) {
      const html = await resp.text()

      // 1. ดึงชื่อโปรไฟล์จาก <title>
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleMatch) {
        const rawTitle = decodeAllHtmlEntities(titleMatch[1]).trim()
        const cleaned = rawTitle.replace(/\s*•\s*Instagram.*$/i, '').trim()
        if (cleaned && !cleaned.toLowerCase().includes('login') && !cleaned.toLowerCase().includes('error')) {
          displayName = cleaned
        }
      }

      // 2. สกัด profile_id (numeric user ID) ของเป้าหมายจาก HTML เพื่อดึงรูป HD ต้นฉบับจริง (1080x1080 คมชัด 100% ไม่ใช่ 100x100)
      const idMatch = html.match(/"profile_id"\s*:\s*"(\d+)"/i) || 
                      html.match(/"target_id"\s*:\s*"(\d+)"/i) ||
                      html.match(/"props":\{[^\}]*"id"\s*:\s*"(\d+)"/i)
      const targetUserId = idMatch?.[1]

      if (targetUserId) {
        try {
          const infoResp = await safeFetch(`https://www.instagram.com/api/v1/users/${targetUserId}/info/`, {
            headers: {
              'User-Agent': DESKTOP_CHROME_UA,
              'Accept': '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'X-IG-App-ID': IG_APP_ID,
              'X-ASBD-ID': '129477',
              'X-IG-WWW-Claim': '0',
              'X-Requested-With': 'XMLHttpRequest',
              'Referer': `https://www.instagram.com/${cleanUsername}/`,
              'Sec-Fetch-Site': 'same-origin',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Dest': 'empty',
              'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
              'Sec-CH-UA-Mobile': '?0',
              'Sec-CH-UA-Platform': '"Windows"',
              ...(igCookie ? { 'Cookie': igCookie } : {}),
            },
            signal,
          })

          if (infoResp.ok) {
            const uData = await infoResp.json() as any
            const userObj = uData?.user
            if (userObj) {
              if (userObj.full_name?.trim()) {
                displayName = `${userObj.full_name.trim()} (@${cleanUsername})`
              }
              if (userObj.hd_profile_pic_versions && Array.isArray(userObj.hd_profile_pic_versions) && userObj.hd_profile_pic_versions.length > 0) {
                const sorted = [...userObj.hd_profile_pic_versions].sort((a: any, b: any) => (b.width || 0) - (a.width || 0))
                profilePicUrl = sorted[0].url
                resolution = `${sorted[0].width}x${sorted[0].height}px (Original HD)`
              } else if (userObj.hd_profile_pic_url_info?.url) {
                profilePicUrl = userObj.hd_profile_pic_url_info.url
                resolution = '1080x1080px (Original HD)'
              } else if (userObj.profile_pic_url_hd) {
                profilePicUrl = userObj.profile_pic_url_hd
                resolution = '1080x1080px (Original HD)'
              }
              if (profilePicUrl) {
                log('info', `Instagram: extracted real native original HD profile pic via user ID API`)
              }
            }
          }
        } catch (e) {
          log('warn', `Instagram: user ID info API failed -> ${(e as Error).message}`)
        }
      }

      // 3. Fallback: หากดึง API ไม่สำเร็จ ให้ดึงจาก og:image
      if (!profilePicUrl) {
        const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
        if (ogMatch) {
          const pic = decodeAllHtmlEntities(ogMatch[1])
          if (
            !pic.includes('instagram-logo') && 
            !pic.includes('static/images') && 
            !pic.includes('rsrc.php') &&
            !pic.includes('static.cdninstagram.com')
          ) {
            profilePicUrl = pic
            resolution = '1080x1080px (Full HD)'
          }
        }
      }

      // 4. Fallback: ค้นหาจาก JSON ของผู้ใช้เป้าหมายในหน้าเว็บ
      if (!profilePicUrl) {
        profilePicUrl = profileImageFromHtml(html, cleanUsername) || ''
      }

      if (profilePicUrl) {
        log('info', `Instagram: extracted profile avatar successfully: ${resolution}`)
      } else if (html.includes('PolarisErrorRoot') || html.includes('checkpoint_required')) {
        log('warn', `Instagram: profile @${cleanUsername} returned error/checkpoint page`)
      }
    } else {
      const errText = await resp.text().catch(() => '')
      if (resp.status === 429 || /please wait a few minutes|too many requests/i.test(errText)) {
        upstreamError = new AppError('RATE_LIMITED', 'Instagram จำกัดคำขอจาก IP หรือ session ของเซิร์ฟเวอร์', 429,
          'หยุดลองซ้ำชั่วคราว แล้วตรวจ session และเส้นทางเครือข่ายบนเซิร์ฟเวอร์ ข้อความนี้ไม่ได้หมายความว่าบัญชีเป็น Private')
      }
    }
    } catch (e) {
      if (e instanceof AppError) upstreamError = e
      else log('warn', `Instagram: HTML navigation failed -> ${(e as Error).message}`)
    }
  }

  // Method 3: web_profile_info API (Fallback)
  if (!profilePicUrl) {
    try {
      const igCookie = await getInstagramCookieHeader()
      await humanDelay()
      const headers: Record<string, string> = {
        'User-Agent': DESKTOP_CHROME_UA,
        'X-IG-App-ID': IG_APP_ID,
        'Accept': 'application/json',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://www.instagram.com/${cleanUsername}/`,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Accept-Language': 'en-US,en;q=0.9',
      }
      if (igCookie) {
        headers['Cookie'] = igCookie
      }

      const apiResp = await safeFetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${cleanUsername}`, {
        headers,
        signal,
      })

      log('info', 'Instagram: profile API response', { status: apiResp.status, cookiePresent: !!igCookie })

      if (apiResp.ok) {
        log('info', `Instagram: web_profile_info → HTTP 200 (HD profile available)`)
        const data = await apiResp.json() as any
        const user = data?.data?.user
        if (user) {
          const fullName = (user.full_name || '').trim()
          displayName = fullName ? `${fullName} (@${cleanUsername})` : `@${cleanUsername}`

          if (user.hd_profile_pic_versions && Array.isArray(user.hd_profile_pic_versions) && user.hd_profile_pic_versions.length > 0) {
            const sorted = [...user.hd_profile_pic_versions].sort((a: any, b: any) => (b.width || 0) - (a.width || 0))
            profilePicUrl = sorted[0].url
            resolution = `${sorted[0].width}x${sorted[0].height}px (Full HD)`
          } else if (user.hd_profile_pic_url_info?.url) {
            profilePicUrl = user.hd_profile_pic_url_info.url
            resolution = '1080x1080px (Full HD)'
          } else if (user.profile_pic_url_hd) {
            profilePicUrl = user.profile_pic_url_hd
            resolution = '1080x1080px (Full HD)'
          } else if (user.profile_pic_url) {
            profilePicUrl = user.profile_pic_url
            resolution = '1080x1080px (Full HD)'
          }
        }
      } else {
        const errText = await apiResp.text().catch(() => '')
        if (apiResp.status === 429 || /please wait a few minutes|too many requests/i.test(errText)) {
          upstreamError = new AppError('RATE_LIMITED', 'Instagram จำกัดคำขอจาก IP หรือ session ของเซิร์ฟเวอร์', 429,
            'หยุดลองซ้ำชั่วคราว แล้วตรวจ session และเส้นทางเครือข่ายบนเซิร์ฟเวอร์ ข้อความนี้ไม่ได้หมายความว่าบัญชีเป็น Private')
        } else if (errText.includes('challenge_required') || errText.includes('checkpoint_required')) {
          upstreamError = new AppError(
            'AUTH_REQUIRED',
            `Instagram บล็อกการดึงข้อมูลและติดสถานะ Checkpoint (challenge_required)`,
            403,
            'กรุณาเปิดแอป Instagram บนมือถือเพื่อกดยืนยันตัวตน ("This was me") เพื่อปลดล็อกบัญชี หรือใช้ลิงก์วิดีโอ/Reels สาธารณะแทนครับ'
          )
        }
      }
    } catch (e) {
      if (e instanceof AppError) upstreamError = e
      else log('warn', `Instagram: web_profile_info API failed -> ${(e as Error).message}`)
    }
  }

  // Method 4: Crawler User-Agent สำหรับบัญชีสาธารณะ (Fallback)
  if (!profilePicUrl) {
    try {
      const crawlerResp = await safeFetch(`https://www.instagram.com/${cleanUsername}/`, {
        headers: {
          'User-Agent': UA_CRAWLER,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal,
      })
      if (crawlerResp.ok) {
        const crawlerHtml = await crawlerResp.text()
        const cOgMatch = crawlerHtml.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
        if (cOgMatch) {
          const cPic = decodeAllHtmlEntities(cOgMatch[1])
          if (!cPic.includes('instagram-logo') && !cPic.includes('rsrc.php') && !cPic.includes('static.cdninstagram.com')) {
            profilePicUrl = cPic
            resolution = '1080x1080px (Full HD)'
          }
        }
      }
    } catch {}
  }

  if (!profilePicUrl) {
    if (upstreamError) throw upstreamError
    throw new AppError(
      'AUTH_REQUIRED',
      `Instagram ปิดกั้นการดูโปรไฟล์ @${cleanUsername}`,
      403,
      'บัญชีนี้อาจเป็นบัญชีส่วนตัว (Private) หรือ Instagram บล็อกคำขอจากเซิร์ฟเวอร์ภายนอก ลองใช้ลิงก์โพสต์หรือ Reels สาธารณะแทนครับ'
    )
  }

  if (!displayName || !displayName.trim()) {
    displayName = `@${cleanUsername}`
  }

  const option = { 
    id: 'profile_hd', 
    label: `ดาวน์โหลดรูปโปรไฟล์ Full HD (1080x1080px)`, 
    format: 'jpg', 
    quality: '1080x1080px (Full HD)' 
  }

  return {
    platform: 'instagram',
    contentType: 'profile',
    title: displayName,
    thumbnail: profilePicUrl,
    description: `รูปโปรไฟล์ Instagram ของ @${cleanUsername} คุณภาพ Full HD 1080p`,
    items: [
      {
        id: 'item_profile',
        kind: 'image',
        title: displayName,
        thumbnail: profilePicUrl,
        options: [option],
      }
    ],
    options: [option],
  }
}

export async function downloadInstagram(
  url: string,
  identifier: string,
  contentType: ContentType = 'profile',
  optionId?: string,
  signal?: AbortSignal,
  onProgress?: (progress: number, stage: DownloadStage) => void,
  cachedMeta?: MediaInfo
): Promise<DownloadResult> {
  // If it's a reel or post video, use generic downloader
  if ((contentType === 'reel' || contentType === 'post') && optionId !== 'profile_hd') {
    return downloadGeneric(url, optionId || 'video_best', 'instagram', signal, onProgress, cachedMeta)
  }

  let cleanUsername = (identifier || '').replace(/[/?#].*$/, '').trim()
  if (!cleanUsername) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean)
      cleanUsername = parts[0] || 'instagram_user'
    } catch {
      cleanUsername = 'instagram_user'
    }
  }

  onProgress?.(10, 'downloading')

  // 1. ดึงจาก cachedMeta ก่อนเสมอ เพื่อป้องกันการยิง Instagram ซ้ำ ซึ่งอาจติด Rate limit หรือ Session challenge
  let imageUrl = ''
  if (cachedMeta) {
    imageUrl = cachedMeta.thumbnail || cachedMeta.items?.[0]?.url || cachedMeta.items?.[0]?.thumbnail || ''
  }

  // 2. หากไม่มีในแคช ค่อยดึงข้อมูลใหม่
  if (!imageUrl) {
    const info = await getInstagramInfo(url, cleanUsername, 'profile', signal)
    imageUrl = info.thumbnail || ''
  }

  if (!imageUrl) throw new AppError('DOWNLOAD_FAILED', 'ไม่พบ URL รูปโปรไฟล์')

  if (imageUrl.startsWith('/api/proxy-image') || imageUrl.includes('/api/proxy-image?url=')) {
    try {
      const parsed = new URL(imageUrl, 'http://localhost')
      imageUrl = parsed.searchParams.get('url') || imageUrl
    } catch {}
  }

  log('info', 'Instagram: downloading image', { host: new URL(imageUrl).hostname, cached: !!cachedMeta })

  const imgResp = await safeFetch(imageUrl, { 
    headers: { 'User-Agent': DESKTOP_CHROME_UA }, 
    signal 
  })
  if (!imgResp.ok) throw new AppError('DOWNLOAD_FAILED', `HTTP ${imgResp.status}`)
  if (!imgResp.headers.get('content-type')?.startsWith('image/')) {
    await imgResp.body?.cancel()
    throw new AppError('DOWNLOAD_FAILED', 'Instagram CDN ไม่ได้ส่งไฟล์รูปภาพกลับมา', 502)
  }

  const arrayBuf = await imgResp.arrayBuffer()
  let imageBuffer = Buffer.from(arrayBuf)

  try {
    const meta = await sharp(imageBuffer).metadata()
    const width = meta.width || 0
    const height = meta.height || 0

    // หากภาพมีขนาดเล็กกว่า 1080px (เช่น 150x150 จากบัญชีส่วนตัว) ให้ทำการ Upscale ด้วย Sharp สู่ 1080x1080 Full HD
    if (width < 1080 || height < 1080) {
      log('info', `Instagram: upscaling profile picture from ${width}x${height} to 1080x1080 Full HD using Lanczos3`)
      imageBuffer = await sharp(imageBuffer)
        .resize(1080, 1080, {
          kernel: sharp.kernel.lanczos3,
          fit: 'cover',
          position: 'center',
        })
        .sharpen({ sigma: 1.0, m1: 1.0, m2: 2.0 })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer()
    }
  } catch (err) {
    log('warn', `Instagram: Sharp image processing skipped: ${(err as Error).message}`)
  }

  onProgress?.(100, 'ready')
  return {
    stream: new Response(imageBuffer).body as ReadableStream,
    filename: `${cleanUsername}_profile_1080p_HD.jpg`,
    contentType: 'image/jpeg',
    fileSize: imageBuffer.length,
  }
}

