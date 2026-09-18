import type { MediaInfo, DownloadResult, ContentType, DownloadStage, DownloadOption, MediaItem } from '../types'
import { AppError } from '../utils/errors'
import { log, decodeAllHtmlEntities, getCookiesPath, getDataDir } from '../utils/helpers'
import { safeFetch } from '../utils/security'
import { getGenericInfo, downloadGeneric } from './generic'
import { join } from 'path'
import sharp from 'sharp'

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

const MOBILE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const UA_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'

function humanDelay(): Promise<void> {
  return new Promise(r => setTimeout(r, 80 + Math.random() * 220))
}

function isFacebookLoginWall(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] || ''
  if (/log in to facebook|เข้าสู่ระบบ facebook|you must log in|checkpoint/i.test(title)) return true
  if (/<form\b[^>]*\bid\s*=\s*["']login_form["']/i.test(html)) return true
  if (/id="login_form"|name="login_form"|action="\/login\.php"/i.test(html)) return true
  return false
}

function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

/**
 * ปลดล็อกขนาดภาพเต็มของ Facebook CDN
 * Facebook มักใส่ ctp=s200x200 เพื่อจำกัดขนาดรูปโปรไฟล์บนหน้าเว็บ
 * การตัด ctp ออกทำให้ Facebook CDN ปล่อยภาพต้นฉบับคมชัดสูงสุด (เช่น 960x958 หรือ 1080p) ทันที
 */
export function maximizeFacebookPhotoUrl(url: string): string {
  if (!url) return url
  if (url.includes('cstp=mx') && url.includes('ctp=s')) {
    try {
      const parsed = new URL(url)
      parsed.searchParams.delete('ctp')
      return parsed.toString()
    } catch {
      return url.replace(/([&?])ctp=s\d+x\d+(&|$)/, (m, p1, p2) => (p2 === '&' ? p1 : ''))
    }
  }
  return url
}

/**
 * ดึง Cookie ของ Facebook จาก cookies.txt หรือ Environment Variable
 */
async function getFacebookCookie(): Promise<string> {
  const envCookie = process.env.FACEBOOK_COOKIE
  if (envCookie?.trim()) {
    let cleanEnv = envCookie.trim()
    try {
      if (cleanEnv.includes('%3A') || cleanEnv.includes('%20')) {
        cleanEnv = decodeURIComponent(cleanEnv)
      }
    } catch {}
    return cleanEnv
  }

  const cookiesPath = getCookiesPath() || join(getDataDir(), 'cookies', 'cookies.txt')
  try {
    const file = Bun.file(cookiesPath)
    if (await file.exists()) {
      const text = await file.text()
      const lines = text.split('\n')
      const cookies: string[] = []
      for (const line of lines) {
        const trimmed = line.trim().replace(/^#HttpOnly_/, '')
        if (trimmed.startsWith('#') || !trimmed) continue
        const parts = trimmed.split('\t')
        if (parts.length >= 7) {
          const domain = parts[0]
          const name = parts[5]
          let value = parts[6]?.trim()
          const host = domain.replace(/^\./, '').toLowerCase()
          const expires = Number(parts[4])
          if ((host === 'facebook.com' || host.endsWith('.facebook.com')) &&
              (expires === 0 || expires > Date.now() / 1000) && name && value) {
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
  } catch (err) {
    log('warn', `Failed to parse cookies.txt for Facebook: ${(err as Error).message}`)
  }

  return ''
}

/**
 * คลี่ลิงก์แชร์ Facebook (/share/r/, /share/v/, fb.watch) ให้กลายเป็น URL มาตรฐาน (/watch/?v=ID)
 * ป้องกันปัญหา Facebook redirect ไปยัง story.php แล้วติดหน้า Login Wall สำหรับบอท
 */
export async function unshortenFacebookShareUrl(url: string, signal?: AbortSignal): Promise<string> {
  const isShareUrl = /facebook\.com\/share\/[rv]\/|fb\.watch\//i.test(url)
  if (!isShareUrl) return url

  try {
    const fbCookie = await getFacebookCookie()
    const resp = await safeFetch(url, {
      headers: {
        ...DESKTOP_CHROME_HEADERS,
        ...(fbCookie ? { 'Cookie': fbCookie } : {}),
      },
      signal,
    })

    const finalUrl = resp.url || ''

    // 1. ลองดึง ID วิดีโอ (ตัวเลข 10-25 หลัก) จาก URL ปลายทาง
    const idMatch = finalUrl.match(/\/(\d{10,25})(?:\/|\?|$)/) || finalUrl.match(/[?&]v=(\d{10,25})/)
    if (idMatch && idMatch[1]) {
      log('info', `Facebook unshortener resolved ${url} -> video ID ${idMatch[1]}`)
      return `https://www.facebook.com/watch/?v=${idMatch[1]}`
    }

    // 2. หากเป็น URL วิดีโอ/Reels ปลายทางโดยตรง
    if (finalUrl && !finalUrl.includes('/login') && !finalUrl.includes('story.php') &&
        (finalUrl.includes('/videos/') || finalUrl.includes('/reel/') || finalUrl.includes('/watch'))) {
      log('info', `Facebook unshortener resolved ${url} -> ${finalUrl}`)
      return finalUrl
    }

    // 3. อ่าน HTML เพื่อดึง Canonical URL หรือ og:url
    if (resp.ok) {
      const html = await resp.text()
      const ogUrlMatch = html.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)
      if (ogUrlMatch && ogUrlMatch[1]) {
        const ogUrl = ogUrlMatch[1]
        const ogIdMatch = ogUrl.match(/\/(\d{10,25})(?:\/|\?|$)/) || ogUrl.match(/[?&]v=(\d{10,25})/)
        if (ogIdMatch && ogIdMatch[1]) {
          log('info', `Facebook unshortener extracted canonical video ID ${ogIdMatch[1]} from HTML`)
          return `https://www.facebook.com/watch/?v=${ogIdMatch[1]}`
        }
      }

      // 4. ตรวจสอบ video_id ใน JSON payload ภายในหน้า
      const videoIdMatch = html.match(/"video_id":"(\d{10,25})"/i) ||
                           html.match(/"owning_profile":\{"__typename":"Video","id":"(\d{10,25})"/i)
      if (videoIdMatch && videoIdMatch[1]) {
        log('info', `Facebook unshortener found video_id ${videoIdMatch[1]} in JSON payload`)
        return `https://www.facebook.com/watch/?v=${videoIdMatch[1]}`
      }
    }
  } catch (err) {
    log('warn', `Failed to unshorten Facebook share URL: ${(err as Error).message}`)
  }

  return url
}

export async function getFacebookInfo(
  url: string,
  identifier: string,
  contentType: ContentType = 'profile',
  signal?: AbortSignal
): Promise<MediaInfo> {
  const resolvedUrl = await unshortenFacebookShareUrl(url, signal)
  const isVideo = contentType === 'watch' || contentType === 'reel' || (contentType === 'video' && !resolvedUrl.includes('/share/')) ||
    resolvedUrl.includes('/video') || resolvedUrl.includes('/watch') || resolvedUrl.includes('fb.watch') || resolvedUrl.includes('/reel') ||
    resolvedUrl.includes('/share/v/') || resolvedUrl.includes('/share/r/')

  // 1. Videos & Reels -> Delegate to yt-dlp extractor
  if (isVideo) {
    try {
      const genericInfo = await getGenericInfo(resolvedUrl, 'facebook', signal)
      genericInfo.contentType = contentType === 'profile' ? 'video' : contentType
      return genericInfo
    } catch (err) {
      log('warn', `Facebook generic video extractor failed: ${(err as Error).message}`)
      // If it's explicitly a video or watch URL, don't fallback to scraping profile picture
      if (contentType === 'watch' || contentType === 'reel' || resolvedUrl.includes('fb.watch') || resolvedUrl.includes('/watch') || resolvedUrl.includes('/reel')) {
        throw err
      }
    }
  }

  // 2. Profile or Photo
  const cleanId = identifier.replace(/[/?#].*$/, '')
  let displayName = cleanId
  let mediaUrl = ''
  let ogImageUrl = ''
  const finalUrlType = (contentType === 'image' || url.includes('/photo') || url.includes('/posts/')) ? 'photo' : 'profile'

  log('info', `Facebook: processing "${cleanId}" as ${finalUrlType}`)

  try {
    const targetUrl = (finalUrlType === 'photo' || url.includes('/share/') || url.includes('profile.php') || !cleanId) ? url : `https://www.facebook.com/${cleanId}`
    const fbCookie = await getFacebookCookie()
    
    const headers: Record<string, string> = {
      ...DESKTOP_CHROME_HEADERS,
      ...(fbCookie ? { 'Cookie': fbCookie } : {}),
    }

    // 1. ดึงด้วย Desktop Chrome User-Agent ก่อนเสมอ (ได้ SSR HTML ตัวเต็มพร้อมรูปโปรไฟล์และหน้าปก)
    let resp = await safeFetch(targetUrl, {
      headers,
      signal,
    })

    let html = ''
    let isLoginWall = false
    log('info', 'Facebook: desktop response', { status: resp.status, cookiePresent: !!fbCookie })

    if (resp.ok) {
      html = await resp.text()
      // Public profiles can contain login links. A login link alone is not a wall.
      if (isFacebookLoginWall(html)) {
        isLoginWall = true
        log('warn', `Facebook: Desktop request encountered login wall for "${cleanId}"`)
      }
    }

    // 2. หากไม่สำเร็จ หรือเจอ Login wall ให้ลอง mbasic.facebook.com (HTML ล้วนแบบเบา ไม่มี JS/GraphQL)
    if (!resp.ok || isLoginWall) {
      log('info', `Facebook: trying mbasic fallback for "${cleanId}"`)
      await humanDelay()
      const mbasicUrl = finalUrlType === 'photo'
        ? url.replace('www.facebook.com', 'mbasic.facebook.com').replace('web.facebook.com', 'mbasic.facebook.com')
        : `https://mbasic.facebook.com/${cleanId}`
      const mbasicResp = await safeFetch(mbasicUrl, {
        headers: {
          'User-Agent': MOBILE_SAFARI_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(fbCookie ? { 'Cookie': fbCookie } : {})
        },
        signal,
      })
      log('info', 'Facebook: mbasic response', { status: mbasicResp.status, cookiePresent: !!fbCookie })
      if (mbasicResp.ok) {
        const mbasicHtml = await mbasicResp.text()
        if (!isFacebookLoginWall(mbasicHtml)) {
          html = mbasicHtml
          resp = mbasicResp
          isLoginWall = false
        }
      }
    }

    // 3. หากยังไม่สำเร็จ ค่อย fallback ไปใช้ Facebook Crawler UA
    if (!resp.ok || isLoginWall) {
      log('info', `Facebook: fallback to Crawler UA for "${cleanId}"`)
      await humanDelay()
      const crawlerHeaders: Record<string, string> = {
        'User-Agent': UA_CRAWLER,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
      if (fbCookie) {
        crawlerHeaders['Cookie'] = fbCookie
      }
      const crawlerResp = await safeFetch(targetUrl, {
        headers: crawlerHeaders,
        signal,
      })
      log('info', 'Facebook: crawler response', { status: crawlerResp.status, cookiePresent: !!fbCookie })
      if (crawlerResp.ok) {
        const crawlerHtml = await crawlerResp.text()
        if (!isFacebookLoginWall(crawlerHtml)) {
          html = crawlerHtml
          resp = crawlerResp
          isLoginWall = false
        }
      }
    }

    if (resp.ok && !isLoginWall) {
      const normalizedHtml = html.replace(/\\\//g, '/')

      // Extract Display Name from Relay store or Comet header
      const ownerMatch = normalizedHtml.match(/"profile_owner":\{[^}]*"name":"([^"]+)"/) ||
                         normalizedHtml.match(/"owning_profile":\{[^}]*"name":"([^"]+)"/) ||
                         normalizedHtml.match(/"user":\{"__isProfile":"User","name":"([^"]+)"/)

      if (ownerMatch) {
        const decoded = decodeUnicodeEscapes(decodeAllHtmlEntities(ownerMatch[1])).trim()
        if (decoded && !/^(facebook|log in to facebook|เข้าสู่ระบบ facebook|โปรไฟล์ของคุณ|your profile)$/i.test(decoded)) {
          displayName = decoded
        }
      }

      // Fallback to <title>
      if (!displayName || displayName === cleanId) {
        const titleMatch = normalizedHtml.match(/<title[^>]*>([^<]+)<\/title>/i)
        if (titleMatch) {
          const rawTitle = decodeAllHtmlEntities(titleMatch[1])
          if (!rawTitle.includes('เข้าสู่ระบบ Facebook') && !rawTitle.toLowerCase().includes('log in to facebook') && rawTitle.trim() !== 'Facebook') {
            displayName = rawTitle
              .replace(/(\s*[|\-–—]\s*Facebook.*$|\s*•\s*Facebook.*$)/i, '')
              .trim()
          }
        }
      }

      // 1. ดึงรูปโปรไฟล์โดยตรงจาก CDN URL หมวด /t39.30808-1/ (รหัสเฉพาะของรูปโปรไฟล์ Facebook)
      if (finalUrlType === 'profile') {
        // Strategy 1: Search for main profile avatar SVG <image> (standard Facebook profile header uses 168px, 160px, or 132px)
        const svgImageMatch = normalizedHtml.match(/<image\b[^>]+style="[^"]*(?:168|160|132)px[^"]*"[^>]+(?:xlink:href|href)="([^"]+)"/i) ||
                              normalizedHtml.match(/<image\b[^>]+(?:xlink:href|href)="([^"]+)"[^>]+style="[^"]*(?:168|160|132)px[^"]*"/i)
        if (svgImageMatch) {
          mediaUrl = decodeAllHtmlEntities(svgImageMatch[1].replace(/&amp;/g, '&'))
        }

        // Strategy 2: If displayName is known, check for SVG with aria-label matching profile name
        if (!mediaUrl && displayName && displayName !== cleanId) {
          const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const ariaSvgMatch = normalizedHtml.match(new RegExp(`<svg\\b[^>]*aria-label="${escapedName}"[^>]*>[\\s\\S]*?<image\\b[^>]+(?:xlink:href|href)="([^"]+)"`, 'i'))
          if (ariaSvgMatch) {
            mediaUrl = decodeAllHtmlEntities(ariaSvgMatch[1].replace(/&amp;/g, '&'))
          }
        }

        // Strategy 3: Check Relay store profile picture fields
        if (!mediaUrl) {
          const relayMatch = normalizedHtml.match(/"profilePic(?:160|Large)"[^{}]*\{[^{}]*"uri":"(https:[^"]+)"/) ||
                             normalizedHtml.match(/"profile_picture_uri":"(https:[^"]+)"/) ||
                             normalizedHtml.match(/"profile_picture_for_sticky_bar"[^{}]*\{[^{}]*"uri":"(https:[^"]+)"/)
          if (relayMatch) {
            mediaUrl = decodeAllHtmlEntities(relayMatch[1].replace(/&amp;/g, '&'))
          }
        }

        // Strategy 4: Find all /t39.30808-1/ matches, filter out viewer avatars, and score by resolution
        if (!mediaUrl) {
          const profileMatches = Array.from(normalizedHtml.matchAll(/https:\/\/scontent[^"'<>]+\.fbcdn\.net[^"'<>]*\/t39\.30808-1\/[^"'<>\s]+/g))
            .map(m => decodeAllHtmlEntities(m[0].replace(/\\/g, '').replace(/&amp;/g, '&')))

          if (profileMatches.length > 0) {
            const viewerIdMatch = normalizedHtml.match(/"viewerID":"(\d+)"/)
            const viewerId = viewerIdMatch ? viewerIdMatch[1] : ''

            const scoredMatches = profileMatches.map(u => {
              let score = 1
              const mx = u.match(/cstp=mx(\d+)x(\d+)/)
              const w = mx ? parseInt(mx[1], 10) : 0
              const h = mx ? parseInt(mx[2], 10) : 0
              if (w >= 720 || h >= 720) score += 100
              else if (w >= 300 || h >= 300) score += 50
              else if (w > 188) score += 10

              if (w > 0 && w <= 188 && h <= 188) score -= 60
              if (u.includes('s40x40') || u.includes('s32x32') || u.includes('s24x24') || u.includes('s60x60')) score -= 40
              if (viewerId && u.includes(viewerId)) score -= 100
              return { u, score }
            }).sort((a, b) => b.score - a.score)

            // คัดเลือกเฉพาะรูปโปรไฟล์ที่มีคุณภาพ และต้องไม่ใช่ไอคอนย่อขนาดเล็กของ Viewer
            const validCandidates = scoredMatches.filter(m => m.score > 0)
            if (validCandidates.length > 0) {
              mediaUrl = validCandidates[0].u
            }
          }
        }
      }

      // 2. สำหรับ Photo Posts หรือกรณีทั่วไป: ค้นหา CDN รูปภาพขนาดใหญ่ใน HTML
      if (finalUrlType === 'photo' || !mediaUrl) {
        const cdnMatches = Array.from(normalizedHtml.matchAll(/https:\/\/scontent[^"'<>]+\.fbcdn\.net[^"'<>]*\/t39\.30808-6\/[^"'<>]+/g))
          .map(m => decodeAllHtmlEntities(m[0].replace(/\\/g, '').replace(/&amp;/g, '&')))
        
        if (cdnMatches.length > 0) {
          const validHdImages = cdnMatches.filter(u => 
            !u.includes('p100x100') && 
            !u.includes('p50x50') &&
            !u.includes('176159830277856')
          )
          if (validHdImages.length > 0) {
            const chosen = validHdImages[0]
            mediaUrl = chosen
          }
        }
      }

      // Extract general OpenGraph image
      const ogMatch = normalizedHtml.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
      if (ogMatch) {
        ogImageUrl = decodeAllHtmlEntities(ogMatch[1])
      }
    }
  } catch (e) {
    log('warn', `Facebook task failed: ${(e as Error).message}`)
  }

  // Fallback to og:image if mediaUrl is still missing
  if (!mediaUrl && ogImageUrl && (ogImageUrl.includes('fbcdn.net') || ogImageUrl.includes('fbsbx.com'))) {
    mediaUrl = ogImageUrl
  }

  if (mediaUrl) {
    mediaUrl = maximizeFacebookPhotoUrl(mediaUrl)
  }

  if (!mediaUrl) {
    throw new AppError('AUTH_REQUIRED', `ไม่สามารถดึงรูปภาพหรือโปรไฟล์ Facebook นี้ได้`, 403, 'Facebook ปิดกั้นการดูเนื้อหานี้สำหรับคำขอสาธารณะ หรือเนื้อหานี้ตั้งค่าเป็นส่วนตัว แนะนำเพิ่ม Cookies Facebook ใน cookies.txt')
  }

  const options: DownloadOption[] = [
    { id: 'profile_hd', label: 'ดาวน์โหลดรูปโปรไฟล์ (HD)', format: 'jpg', quality: 'HD' }
  ]

  const items: MediaItem[] = [
    {
      id: 'item_1',
      kind: 'image',
      title: `${displayName || cleanId} (Profile)`,
      thumbnail: mediaUrl,
      url: mediaUrl,
      options: [
        { id: 'profile_hd', label: 'ดาวน์โหลดรูปโปรไฟล์ (HD)', format: 'jpg', quality: 'HD' }
      ],
    }
  ]

  return {
    platform: 'facebook',
    contentType: finalUrlType === 'photo' ? 'image' : 'profile',
    title: displayName || cleanId,
    thumbnail: mediaUrl,
    description: `รูปภาพจาก Facebook: ${displayName || cleanId}`,
    items,
    options,
  }
}

export async function downloadFacebook(
  url: string,
  identifier: string,
  contentType: ContentType = 'profile',
  optionId?: string,
  signal?: AbortSignal,
  onProgress?: (progress: number, stage: DownloadStage) => void,
  cachedMeta?: MediaInfo
): Promise<DownloadResult> {
  const resolvedUrl = await unshortenFacebookShareUrl(url, signal)
  const isVideo = contentType === 'watch' || contentType === 'reel' || contentType === 'video' ||
    resolvedUrl.includes('/video') || resolvedUrl.includes('/watch') || resolvedUrl.includes('fb.watch') || resolvedUrl.includes('/reel') ||
    resolvedUrl.includes('/share/v/') || resolvedUrl.includes('/share/r/')

  if (isVideo && optionId !== 'media_hd' && optionId !== 'profile_hd' && optionId !== 'cover_hd') {
    return downloadGeneric(resolvedUrl, optionId || 'video_best', 'facebook', signal, onProgress, cachedMeta)
  }

  let cleanId = (identifier || '').replace(/[/?#].*$/, '')
  if (!cleanId || cleanId === 'media_hd' || cleanId === 'profile_hd' || cleanId === 'cover_hd') {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean)
      cleanId = parts[parts.length - 1] || 'facebook_media'
    } catch {
      cleanId = 'facebook_media'
    }
  }

  onProgress?.(10, 'downloading')

  // 1. ดึง URL รูปภาพจาก cachedMeta ก่อนเสมอ เพื่อป้องกันการขูดหน้าเว็บซ้ำรอบสอง ซึ่งทำให้ Facebook rate-limit/login wall
  let imageUrl = ''
  if (cachedMeta) {
    if (optionId === 'cover_hd') {
      const coverItem = cachedMeta.items?.find(i => i.options.some(o => o.id === 'cover_hd'))
      imageUrl = coverItem?.url || coverItem?.thumbnail || ''
    }
    if (!imageUrl && optionId !== 'cover_hd') {
      imageUrl = cachedMeta.thumbnail || cachedMeta.items?.[0]?.url || cachedMeta.items?.[0]?.thumbnail || ''
    }
  }

  // 2. หากไม่มีใน cache จึงค่อยเรียก getFacebookInfo
  if (!imageUrl) {
    const info = await getFacebookInfo(url, cleanId, contentType, signal)
    if (optionId === 'cover_hd') {
      const coverItem = info.items?.find(i => i.options.some(o => o.id === 'cover_hd'))
      imageUrl = coverItem?.url || coverItem?.thumbnail || ''
    } else {
      imageUrl = info.thumbnail || info.items?.[0]?.thumbnail || ''
    }
  }

  if (!imageUrl) throw new AppError('DOWNLOAD_FAILED', 'ไม่พบ URL รูปภาพ')

  // แกะ Proxy URL ออกเพื่อดาวน์โหลดตรงจาก CDN
  if (imageUrl.startsWith('/api/proxy-image') || imageUrl.includes('/api/proxy-image?url=')) {
    try {
      const parsed = new URL(imageUrl, 'http://localhost')
      imageUrl = parsed.searchParams.get('url') || imageUrl
    } catch {}
  }

  // ปลดล็อกขนาดภาพเต็ม ลบ thumbnail restriction (ctp)
  imageUrl = maximizeFacebookPhotoUrl(imageUrl)

  log('info', 'Facebook: downloading image', { host: new URL(imageUrl).hostname, cached: !!cachedMeta, option: optionId })

  const imgResp = await safeFetch(imageUrl, { 
    headers: { 
      'User-Agent': DESKTOP_CHROME_UA,
      'Referer': 'https://www.facebook.com/',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    }, 
    signal 
  })
  if (!imgResp.ok) throw new AppError('DOWNLOAD_FAILED', `ดาวน์โหลดรูปภาพไม่สำเร็จ (HTTP ${imgResp.status})`)
  if (!imgResp.headers.get('content-type')?.startsWith('image/')) {
    await imgResp.body?.cancel()
    throw new AppError('DOWNLOAD_FAILED', 'Facebook CDN ไม่ได้ส่งไฟล์รูปภาพกลับมา', 502)
  }
  const arrayBuf = await imgResp.arrayBuffer()
  let imageBuffer = Buffer.from(arrayBuf)

  const isCover = optionId === 'cover_hd'
  const isProfile = contentType === 'profile' || url.includes('profile.php') || (!url.includes('/photo') && !url.includes('/posts/'))

  if (isProfile) {
    try {
      const meta = await sharp(imageBuffer).metadata()
      const width = meta.width || 0
      const height = meta.height || 0

      // หากภาพมีขนาดเล็กกว่า 720px ให้ทำการ Upscale ด้วย Sharp สู่ 1080x1080 Full HD ด้วย Lanczos3
      // หากภาพมีความละเอียดสูงอยู่แล้ว (>= 720px เช่น 960x958 หรือ 1080p) ให้รักษาคุณภาพไฟล์ภาพต้นฉบับคมชัด 100% ไว้โดยไม่ต้องบีบอัดซ้ำ
      if (width < 720 || height < 720) {
        log('info', `Facebook: upscaling profile picture from ${width}x${height} to 1080x1080 Full HD using Lanczos3`)
        imageBuffer = await sharp(imageBuffer)
          .resize(1080, 1080, {
            kernel: sharp.kernel.lanczos3,
            fit: 'cover',
            position: 'center',
          })
          .sharpen({ sigma: 1.0, m1: 1.0, m2: 2.0 })
          .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
          .toBuffer()
      } else {
        log('info', `Facebook: profile picture is already high resolution (${width}x${height}), keeping original uncompressed quality`)
      }
    } catch (err) {
      log('warn', `Facebook: Sharp image processing skipped: ${(err as Error).message}`)
    }
  }

  onProgress?.(100, 'ready')
  const filenameType = isCover ? 'cover' : (isProfile ? 'profile' : 'photo')
  return {
    stream: new Response(imageBuffer).body as ReadableStream,
    filename: `${cleanId}_${filenameType}_1080p_HD.jpg`,
    contentType: 'image/jpeg',
    fileSize: imageBuffer.length
  }
}
