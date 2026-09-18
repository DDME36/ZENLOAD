import type { ContentType, DetectedUrl } from '../types'
import { parseAndValidateUrl } from '../utils/security'

function isHost(hostname: string, target: string): boolean {
  return hostname === target || hostname.endsWith('.' + target)
}

const DIRECT_MEDIA_EXTS: Record<string, 'video' | 'audio' | 'image'> = {
  mp4: 'video',
  webm: 'video',
  mkv: 'video',
  mov: 'video',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  opus: 'audio',
  flac: 'audio',
  aac: 'audio',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
}

/**
 * วิเคราะห์ URL อย่างปลอดภัย โดยใช้ URL parser และตรวจสอบ Hostname จริง
 * ป้องกันการ bypass regex ด้วย subdomain หรือ query string ปลอม
 */
export function detectUrl(url: string): DetectedUrl {
  const parsed = parseAndValidateUrl(url)
  const hostname = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname
  const searchParams = parsed.searchParams

  // 1. YouTube
  if (isHost(hostname, 'youtube.com') || hostname === 'youtu.be') {
    let identifier = ''
    let contentType: 'video' | 'playlist' = 'video'

    if (hostname === 'youtu.be') {
      identifier = pathname.replace(/^\//, '').split('/')[0] || ''
    } else if (pathname.startsWith('/shorts/')) {
      identifier = pathname.replace(/^\/shorts\//, '').split('/')[0] || ''
    } else if (pathname.startsWith('/embed/')) {
      identifier = pathname.replace(/^\/embed\//, '').split('/')[0] || ''
    } else if (pathname.startsWith('/v/')) {
      identifier = pathname.replace(/^\/v\//, '').split('/')[0] || ''
    } else if (pathname.startsWith('/playlist')) {
      identifier = searchParams.get('list') || ''
      contentType = 'playlist'
    } else if (searchParams.has('v')) {
      identifier = searchParams.get('v') || ''
      if (searchParams.has('list')) {
        // มีทั้ง v และ list -> ถือเป็น video ใน playlist
        contentType = 'video'
      }
    } else if (searchParams.has('list')) {
      identifier = searchParams.get('list') || ''
      contentType = 'playlist'
    }

    return {
      platform: 'youtube',
      contentType,
      originalUrl: parsed.href,
      identifier: identifier.trim(),
    }
  }

  // 2. Instagram
  if (isHost(hostname, 'instagram.com')) {
    let identifier = ''
    let contentType: 'post' | 'reel' | 'story' | 'profile' = 'profile'
    const parts = pathname.split('/').filter(Boolean)

    if (parts[0] === 'p') {
      identifier = parts[1] || ''
      contentType = 'post'
    } else if (parts[0] === 'reel' || parts[0] === 'reels' || parts[0] === 'tv') {
      identifier = parts[1] || ''
      contentType = 'reel'
    } else if (parts[0] === 'stories') {
      identifier = parts[1] || ''
      contentType = 'story'
    } else if (parts[0] === 'share') {
      if (parts[1] === 'p') {
        contentType = 'post'
        identifier = parts[2] || ''
      } else if (parts[1] === 'r' || parts[1] === 'reel' || parts[1] === 'reels') {
        contentType = 'reel'
        identifier = parts[2] || ''
      } else {
        contentType = 'post'
        identifier = parts[1] || ''
      }
    } else if (parts[0] && !['explore', 'accounts', 'direct'].includes(parts[0])) {
      // Profile username
      identifier = parts[0]
      contentType = 'profile'
    }

    const canonicalUrl = parts[0] === 'share' && identifier
      ? `https://www.instagram.com/${contentType === 'reel' ? 'reel' : 'p'}/${identifier.trim()}/`
      : parsed.href

    return {
      platform: 'instagram',
      contentType,
      originalUrl: canonicalUrl,
      identifier: identifier.trim(),
    }
  }

  // 3. Facebook
  if (isHost(hostname, 'facebook.com') || isHost(hostname, 'fb.com') || hostname === 'fb.watch') {
    let identifier = ''
    let contentType: 'video' | 'watch' | 'reel' | 'post' | 'image' | 'profile' = 'profile'
    const parts = pathname.split('/').filter(Boolean)

    if (hostname === 'fb.watch') {
      identifier = parts[0] || ''
      contentType = 'watch'
    } else if (pathname.includes('/watch')) {
      identifier = searchParams.get('v') || (parts.length > 1 ? parts[parts.length - 1] : '')
      contentType = 'watch'
    } else if (pathname.includes('/reel') || pathname.includes('/reels')) {
      const reelIdx = parts.findIndex(p => p === 'reel' || p === 'reels')
      identifier = (reelIdx !== -1 && parts[reelIdx + 1]) ? parts[reelIdx + 1] : (parts[parts.length - 1] || '')
      contentType = 'reel'
    } else if (pathname.includes('/videos/')) {
      const vIdx = parts.findIndex(p => p === 'videos')
      identifier = (vIdx !== -1 && parts[vIdx + 1]) ? parts[vIdx + 1] : (parts[parts.length - 1] || '')
      contentType = 'video'
    } else if (parts[0] === 'share') {
      // รูปแบบลิงก์แชร์จากแอป Facebook บนมือถือ: /share/v/..., /share/r/..., /share/p/..., /share/...
      if (parts[1] === 'v') {
        contentType = 'video'
        identifier = parts[2] || parts[1]
      } else if (parts[1] === 'r') {
        contentType = 'reel'
        identifier = parts[2] || parts[1]
      } else if (parts[1] === 'p') {
        contentType = 'post'
        identifier = parts[2] || parts[1]
      } else {
        contentType = 'profile'
        identifier = parts[1] || ''
      }
    } else if (pathname.includes('/photo') || pathname.includes('/photos')) {
      if (searchParams.has('fbid')) {
        identifier = searchParams.get('fbid') || ''
      } else {
        identifier = parts[parts.length - 1] || ''
      }
      contentType = 'image'
    } else if (pathname.includes('/posts/') || pathname.includes('/permalink.php')) {
      if (searchParams.has('story_fbid')) {
        identifier = searchParams.get('story_fbid') || ''
      } else {
        const pIdx = parts.findIndex(p => p === 'posts')
        identifier = (pIdx !== -1 && parts[pIdx + 1]) ? parts[pIdx + 1] : (parts[parts.length - 1] || '')
      }
      contentType = 'post'
    } else if (searchParams.has('id')) {
      identifier = searchParams.get('id') || ''
      contentType = 'profile'
    } else if (parts.length > 0) {
      identifier = parts[0] || ''
      contentType = 'profile'
    }

    return {
      platform: 'facebook',
      contentType,
      originalUrl: parsed.href,
      identifier: identifier.trim(),
    }
  }

  // 4. SoundCloud
  if (isHost(hostname, 'soundcloud.com')) {
    const parts = pathname.split('/').filter(Boolean)
    const identifier = parts.slice(0, 2).join('/')
    return {
      platform: 'soundcloud',
      contentType: 'audio',
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 5. TikTok
  if (isHost(hostname, 'tiktok.com')) {
    let identifier = ''
    let contentType: ContentType = 'video'
    const postMatch = pathname.match(/\/(?:video|photo)\/(\d+)/)
    if (postMatch) {
      identifier = postMatch[1]
      if (pathname.includes('/photo/')) {
        contentType = 'album'
      }
    } else {
      const parts = pathname.split('/').filter(Boolean)
      identifier = parts[parts.length - 1] || ''
    }

    return {
      platform: 'tiktok',
      contentType,
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 6. Twitter / X
  if (isHost(hostname, 'twitter.com') || isHost(hostname, 'x.com')) {
    let identifier = ''
    const statusMatch = pathname.match(/\/status\/(\d+)/)
    if (statusMatch) {
      identifier = statusMatch[1]
    }

    return {
      platform: 'twitter',
      contentType: 'video',
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 7. Reddit
  if (isHost(hostname, 'reddit.com') || hostname === 'redd.it') {
    let identifier = ''
    if (hostname === 'redd.it') {
      identifier = pathname.replace(/^\//, '').split('/')[0] || ''
    } else {
      const match = pathname.match(/\/comments\/([a-zA-Z0-9]+)/)
      if (match) identifier = match[1]
    }

    return {
      platform: 'reddit',
      contentType: 'video',
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 8. Vimeo
  if (isHost(hostname, 'vimeo.com')) {
    const match = pathname.match(/(\d+)/)
    const identifier = match ? match[1] : ''
    return {
      platform: 'vimeo',
      contentType: 'video',
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 9. Dailymotion
  if (isHost(hostname, 'dailymotion.com') || hostname === 'dai.ly') {
    let identifier = ''
    if (hostname === 'dai.ly') {
      identifier = pathname.replace(/^\//, '').split('/')[0] || ''
    } else {
      const match = pathname.match(/\/video\/([a-zA-Z0-9]+)/)
      if (match) identifier = match[1]
    }

    return {
      platform: 'dailymotion',
      contentType: 'video',
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 10. Twitch
  if (isHost(hostname, 'twitch.tv')) {
    let identifier = ''
    const match = pathname.match(/\/(?:videos|clip)\/([a-zA-Z0-9_-]+)/)
    if (match) identifier = match[1]

    return {
      platform: 'twitch',
      contentType: 'video',
      originalUrl: parsed.href,
      identifier,
    }
  }

  // 11. Direct Media Link (.mp4, .mp3, .jpg, etc.)
  const pathExt = pathname.split('.').pop()?.toLowerCase() || ''
  if (DIRECT_MEDIA_EXTS[pathExt]) {
    const rawFilename = pathname.split('/').filter(Boolean).pop() || `media.${pathExt}`
    return {
      platform: 'direct',
      contentType: DIRECT_MEDIA_EXTS[pathExt],
      originalUrl: parsed.href,
      identifier: decodeURIComponent(rawFilename),
    }
  }

  // URL ถูกต้องแต่ไม่ตรงกับแพลตฟอร์มที่ระบุ
  return {
    platform: 'unknown',
    contentType: 'unknown',
    originalUrl: parsed.href,
    identifier: '',
  }
}

/**
 * ตรวจสอบว่าเป็น URL ที่ถูกต้อง ปลอดภัย และไม่เป็น SSRF หรือไม่
 */
export function isValidUrl(url: string): boolean {
  try {
    parseAndValidateUrl(url)
    return true
  } catch {
    return false
  }
}
