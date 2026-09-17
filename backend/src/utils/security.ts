import { lookup } from 'node:dns/promises'
import { resolve, sep } from 'node:path'
import { AppError } from './errors'
import { getProxyForUrl } from './networkProxy'

/**
 * ตรวจสอบว่า IP address เป็น Private IP, Loopback, Link-Local หรือ Cloud Metadata IP หรือไม่
 * ป้องกัน SSRF (Server-Side Request Forgery) โดยเฉพาะบน Oracle Cloud (169.254.169.254)
 */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HAS_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * ตรวจสอบว่า IP address เป็น Private IP, Loopback, Link-Local หรือ Cloud Metadata IP หรือไม่
 * ป้องกัน SSRF (Server-Side Request Forgery) โดยเฉพาะบน Oracle Cloud (169.254.169.254)
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  let cleanIp = ip.trim().toLowerCase()
  // ลบ brackets ถ้ามี เช่น [::1] หรือ [127.0.0.1]
  cleanIp = cleanIp.replace(/^\[|\]$/g, '')
  // ลบ zone index ถ้ามี เช่น fe80::1%eth0
  const zoneIndex = cleanIp.indexOf('%')
  if (zoneIndex !== -1) {
    cleanIp = cleanIp.substring(0, zoneIndex)
  }

  // 1. ตรวจสอบ IPv4
  const ipv4Match = cleanIp.match(IPV4_PATTERN)
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1], 10)
    const b = parseInt(ipv4Match[2], 10)
    const c = parseInt(ipv4Match[3], 10)
    const d = parseInt(ipv4Match[4], 10)

    if (a > 255 || b > 255 || c > 255 || d > 255) {
      return true // IP ไม่ถูกต้อง
    }

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true
    // 10.0.0.0/8 (Private network RFC 1918)
    if (a === 10) return true
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true
    // 169.254.0.0/16 (Link-Local & Cloud Metadata Service เช่น Oracle IMDS 169.254.169.254!)
    if (a === 169 && b === 254) return true
    // 172.16.0.0/12 (Private network RFC 1918)
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true
    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && c === 2) return true
    // 192.88.99.0/24 (6to4 Relay Anycast)
    if (a === 192 && b === 88 && c === 99) return true
    // 192.168.0.0/16 (Private network RFC 1918)
    if (a === 192 && b === 168) return true
    // 100.64.0.0/10 (Shared address space / Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true
    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return true
    // 240.0.0.0/4 (Reserved)
    if (a >= 240) return true

    return false
  }

  // 2. ตรวจสอบ IPv6
  // ตรวจสอบ IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 หรือ ::ffff:7f00:1)
  if (cleanIp.startsWith('::ffff:')) {
    const embedded = cleanIp.substring(7)
    if (IPV4_PATTERN.test(embedded)) {
      return isPrivateOrReservedIp(embedded)
    }
    return true // ป้องกันกรณี hex-encoded ipv4-mapped
  }

  // IPv4-compatible IPv6 (deprecated, e.g. ::127.0.0.1)
  if (cleanIp.startsWith('::') && cleanIp.lastIndexOf(':') === 1) {
    const embedded = cleanIp.substring(2)
    if (IPV4_PATTERN.test(embedded)) {
      return isPrivateOrReservedIp(embedded)
    }
  }

  if (
    cleanIp === '::1' || // Loopback
    cleanIp === '::' || // Unspecified
    cleanIp.startsWith('fe8') || // Link-local (fe80::/10)
    cleanIp.startsWith('fe9') ||
    cleanIp.startsWith('fea') ||
    cleanIp.startsWith('feb') ||
    cleanIp.startsWith('fc') || // Unique local address ULA (fc00::/7)
    cleanIp.startsWith('fd') ||
    cleanIp.startsWith('ff') || // Multicast (ff00::/8)
    cleanIp.startsWith('100:') || // Discard (100::/64)
    cleanIp.startsWith('2001:db8:') || // Documentation
    cleanIp.startsWith('2001:0db8:') ||
    cleanIp.startsWith('2001:10:') || // ORCHIDv1
    cleanIp.startsWith('2001:20:') || // ORCHIDv2
    cleanIp.startsWith('64:ff9b:') || // NAT64
    cleanIp.startsWith('2002:') // 6to4 (encapsulates IPv4)
  ) {
    return true
  }

  return false
}

/**
 * ตรวจสอบว่า Hostname เป็นชื่อโดเมนภายในเครื่องหรือระบบปิดหรือไม่
 */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '')

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host.endsWith('.corp') ||
    host === 'metadata.google.internal' ||
    host === 'instance-data'
  ) {
    return true
  }

  return false
}

/**
 * ตรวจสอบ URL อย่างเข้มงวดด้วย URL parser
 * บล็อกโปรโตคอลที่ไม่ปลอดภัย (อนุญาตเฉพาะ http:, https:)
 * และบล็อก Private IP / Localhost
 */
export function parseAndValidateUrl(rawUrl: string): URL {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new AppError('INVALID_URL', 'กรุณาระบุ URL ที่ถูกต้อง', 400)
  }

  let trimmed = rawUrl.trim()
  if (!HAS_SCHEME_PATTERN.test(trimmed)) {
    trimmed = 'https://' + trimmed
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new AppError('INVALID_URL', 'รูปแบบ URL ไม่ถูกต้อง', 400)
  }

  // อนุญาตเฉพาะ http: และ https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('FORBIDDEN_PROTOCOL', 'อนุญาตเฉพาะโปรโตคอล http และ https เท่านั้น', 400)
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // Hostname ต้องมี domain หรือเป็น IP (ป้องกัน single label host เช่น not-a-url)
  if (!hostname.includes('.') && !hostname.includes(':') && !isPrivateOrReservedIp(hostname)) {
    throw new AppError('INVALID_URL', 'URL ต้องมีชื่อโดเมนที่ถูกต้อง (เช่น example.com)', 400)
  }

  // ตรวจสอบ internal hostname
  if (isInternalHostname(hostname)) {
    throw new AppError('SSRF_DETECTED', 'ไม่อนุญาตให้เข้าถึงที่อยู่ภายในระบบเครือข่าย', 403)
  }

  // ตรวจสอบ IP address ถ้าผู้ใช้ใส่เป็น IP มาตรงๆ
  if (isPrivateOrReservedIp(hostname)) {
    throw new AppError('SSRF_DETECTED', 'ไม่อนุญาตให้เข้าถึง Private IP หรือ Cloud Metadata', 403)
  }

  return parsed
}

/**
 * ตรวจสอบ DNS Resolution เพื่อป้องกัน DNS Rebinding Attacks
 */
export async function assertSafePublicDestination(hostname: string): Promise<void> {
  const cleanHost = hostname.replace(/^\[|\]$/g, '').trim()
  if (isInternalHostname(cleanHost) || isPrivateOrReservedIp(cleanHost)) {
    throw new AppError('SSRF_DETECTED', 'ไม่อนุญาตให้เข้าถึงที่อยู่นี้', 403)
  }

  // หากเป็น IP address อยู่แล้ว (IPv4 หรือ IPv6) ไม่ต้องทำ DNS lookup
  if (IPV4_PATTERN.test(cleanHost) || cleanHost.includes(':')) {
    return
  }

  try {
    const results = await lookup(cleanHost, { all: true })
    if (!results || results.length === 0) {
      throw new AppError('DNS_LOOKUP_FAILED', `ไม่พบข้อมูล DNS สำหรับ: ${cleanHost}`, 400)
    }
    for (const res of results) {
      if (isPrivateOrReservedIp(res.address)) {
        throw new AppError('SSRF_DETECTED', 'โดเมนชี้ไปยังที่อยู่เครือข่ายภายใน ไม่อนุญาตให้เข้าถึง', 403)
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('DNS_LOOKUP_FAILED', `ไม่สามารถตรวจสอบโดเมนได้: ${cleanHost}`, 400)
  }
}

/**
 * ฟังก์ชัน HTTP Fetch ที่ปลอดภัย ป้องกัน SSRF จาก Redirects และ DNS Rebinding
 * บังคับ redirect: 'manual' และตรวจ IP ของเป้าหมายใหม่ในทุกๆ Hop
 */
export async function safeFetch(
  input: string | URL,
  init?: RequestInit & { proxy?: string },
  maxRedirects: number = 5
): Promise<Response> {
  let currentUrl = typeof input === 'string' ? input : input.href
  let hops = 0
  const headers = new Headers(init?.headers)
  const visitedUrls = new Set<string>()

  while (hops <= maxRedirects) {
    const parsed = parseAndValidateUrl(currentUrl)
    await assertSafePublicDestination(parsed.hostname)

    const proxyUrl = init?.proxy ?? getProxyForUrl(parsed)
    const reqInit: RequestInit & { proxy?: string } = {
      ...init,
      headers,
      redirect: 'manual', // ไม่อนุญาตให้ติดตาม redirect อัตโนมัติ
      ...(proxyUrl !== undefined ? { proxy: proxyUrl } : {}),
    }

    const response = await fetch(parsed.href, reqInit as RequestInit)

    // ตรวจสอบสถานะการ Redirect: 301, 302, 303, 307, 308
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        return response
      }

      hops++
      if (hops > maxRedirects) {
        throw new AppError('TOO_MANY_REDIRECTS', 'คำขอถูกเปลี่ยนเส้นทางมากเกินไป', 400)
      }

      // ตีความ Relative URL ให้กลายเป็น Absolute URL ตาม URL ปัจจุบัน
      try {
        const nextUrl = new URL(location, currentUrl)
        if (visitedUrls.has(nextUrl.href) || nextUrl.href === currentUrl) {
          await response.body?.cancel()
          if (nextUrl.hostname.includes('instagram.com')) {
            throw new AppError('AUTH_REQUIRED', 'เซสชัน Instagram ใน Cookies หมดอายุหรือติดการตรวจสอบความปลอดภัย (เกิด Redirect Loop) กรุณาอัปเดต Cookie Instagram ใหม่', 401)
          }
          if (nextUrl.hostname.includes('facebook.com')) {
            throw new AppError('AUTH_REQUIRED', 'เซสชัน Facebook ใน Cookies หมดอายุหรือติดการตรวจสอบความปลอดภัย (เกิด Redirect Loop) กรุณาอัปเดต Cookie Facebook ใหม่', 401)
          }
          throw new AppError('REDIRECT_LOOP', 'ตรวจพบการเปลี่ยนเส้นทางวนซ้ำ (Redirect Loop)', 400)
        }
        visitedUrls.add(currentUrl)

        if (nextUrl.origin !== parsed.origin) {
          headers.delete('cookie')
          headers.delete('authorization')
          headers.delete('proxy-authorization')
        }
        currentUrl = nextUrl.href
      } catch (e) {
        if (e instanceof AppError) throw e
        throw new AppError('INVALID_REDIRECT', 'URL การเปลี่ยนเส้นทางไม่ถูกต้อง', 400)
      }

      await response.body?.cancel()
      continue
    }

    return response
  }

  throw new AppError('TOO_MANY_REDIRECTS', 'คำขอถูกเปลี่ยนเส้นทางมากเกินไป', 400)
}

/**
 * Whitelist โดเมน CDN สำหรับ Image Proxy เพื่อความปลอดภัยสูงสุด
 */
const ALLOWED_IMAGE_PROXY_DOMAINS = [
  'fbcdn.net',
  'facebook.com',
  'cdninstagram.com',
  'instagram.com',
  'ytimg.com',
  'youtube.com',
  'twimg.com',
  'twitter.com',
  'x.com',
  'sndcdn.com',
  'soundcloud.com',
  'tiktokcdn.com',
  'tiktok.com',
  'redditmedia.com',
  'redd.it',
]

export function isAllowedImageProxyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '')
  return ALLOWED_IMAGE_PROXY_DOMAINS.some(allowed => host === allowed || host.endsWith('.' + allowed))
}

/**
 * ตรวจสอบว่า targetPath อยู่ภายใต้ baseDir หรือไม่ เพื่อป้องกัน Path Traversal
 */
export function isSafeSubpath(baseDir: string, targetPath: string): boolean {
  const resolvedBase = resolve(baseDir)
  const resolvedTarget = resolve(targetPath)
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep)
}
