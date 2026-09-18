import { mkdir, appendFile, writeFile, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getProxyForUrl } from './networkProxy'

let logsDirReady = false
const backendRoot = resolve(import.meta.dir, '../../')
const logsDir = join(backendRoot, 'logs')
const logFilePath = join(logsDir, 'backend.log')

export async function ensureLogsDir(): Promise<string> {
  if (!logsDirReady) {
    try {
      await mkdir(logsDir, { recursive: true })
      logsDirReady = true
    } catch {}
  }
  return logsDir
}

export function sanitizeFilename(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200)
  return sanitized || 'download'
}

export function truncateDescription(desc?: string, maxLen = 200): string {
  if (!desc) return ''
  const trimmed = desc.trim()
  if (trimmed.length <= maxLen) return trimmed
  const sliced = trimmed.substring(0, maxLen).replace(/\s+\S*$/, '').trim()
  return `${sliced || trimmed.substring(0, maxLen).trim()}...`
}

export function getTempDir(): string {
  const isWin = process.platform === 'win32'
  return isWin
    ? `${process.env.TEMP || 'C:\\Temp'}\\download-everything`
    : '/tmp/download-everything'
}

export async function ensureTempDir(): Promise<string> {
  const dir = getTempDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch { /* dir may already exist */ }

  return dir
}

export function getDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR
  return join(process.cwd(), 'data')
}

export async function ensureDataDir(): Promise<string> {
  const dir = getDataDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch { /* dir may already exist */ }

  return dir
}

export function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = { info: '✅', warn: '⚠️', error: '❌' }[level]
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
  const logLine = `${prefix} [${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`

  console.log(`${prefix} [${timestamp}] ${message}`, meta ? JSON.stringify(meta) : '')

  // บันทึก Log ถาวรลงไฟล์ backend/logs/backend.log
  ensureLogsDir().then(() => {
    appendFile(logFilePath, logLine, 'utf-8').catch(() => {})
  }).catch(() => {})
}

/**
 * ถอดรหัส HTML entities ทั้งหมด รวมถึง &#xNNNN; (ภาษาไทย) และ &#NNN;
 */
export function decodeAllHtmlEntities(str: string): string {
  return str
    // Named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, '/')
    // Hex entities: &#xE42; &#xe42; etc. (ภาษาไทย อยู่ในช่วง U+0E00-U+0E7F)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    // Decimal entities: &#3585; etc.
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

let cachedCookiesPath: string | null = null

/**
 * โหลดคุกกี้ของ YouTube จาก Environment Variable หรือไฟล์เครื่อง
 */
export async function initCookies(): Promise<void> {
  cachedCookiesPath = null
  const cookiesText = process.env.YT_DLP_COOKIES_TEXT
  const dataDir = await ensureDataDir()
  const cookiesDir = join(dataDir, 'cookies')
  try {
    await mkdir(cookiesDir, { recursive: true })
  } catch {}

  const persistentCookiesPath = join(cookiesDir, 'cookies.txt')

  if (cookiesText) {
    try {
      await Bun.write(persistentCookiesPath, cookiesText.trim())
      cachedCookiesPath = persistentCookiesPath
      log('info', 'Cookies initialized from YT_DLP_COOKIES_TEXT')
    } catch (err) {
      log('error', `Failed to initialize cookies: ${(err as Error).message}`)
    }
  } else {
    // เช็คกรณีใส่ไฟล์คุกกี้ไว้ตรงๆ
    const localBackendPath = './cookies.txt'
    const localRootPath = '../cookies.txt'
    
    if (await Bun.file(persistentCookiesPath).exists()) {
      cachedCookiesPath = persistentCookiesPath
      log('info', `✅ Persistent cookies.txt found at: ${persistentCookiesPath}`)
    } else if (await Bun.file(localBackendPath).exists()) {
      cachedCookiesPath = localBackendPath
      log('info', `✅ Local cookies.txt found in backend directory`)
    } else if (await Bun.file(localRootPath).exists()) {
      cachedCookiesPath = localRootPath
      log('info', `✅ Local cookies.txt found in root directory`)
    }
  }

  if (cachedCookiesPath && await Bun.file(cachedCookiesPath).exists()) {
    try {
      const content = await Bun.file(cachedCookiesPath).text()
      if (content.charCodeAt(0) === 0xFEFF) {
        await Bun.write(cachedCookiesPath, content.slice(1))
        log('info', 'Cleaned UTF-8 BOM from cookies file')
      }
    } catch {}
  }

  // Materialize environment cookies for gallery-dl and yt-dlp too, without
  // exposing session values in process arguments or changing the source file.
  const sessions = [
    ['instagram.com', process.env.INSTAGRAM_COOKIE],
    ['facebook.com', process.env.FACEBOOK_COOKIE],
  ].filter((entry): entry is [string, string] => !!entry[1]?.trim())
  if (sessions.length) {
    let lines = cachedCookiesPath ? (await Bun.file(cachedCookiesPath).text()).split(/\r?\n/) : ['# Netscape HTTP Cookie File']
    for (const [domain, header] of sessions) {
      if (/[\r\n\t]/.test(header)) throw new Error(`Cookie header for ${domain} must be a single line`)
      lines = lines.filter(line => {
        const host = line.replace(/^#HttpOnly_/, '').split('\t')[0].replace(/^\./, '').toLowerCase()
        return host !== domain && !host.endsWith('.' + domain)
      })
      for (const pair of header.split(';')) {
        const equals = pair.indexOf('=')
        if (equals < 1) continue
        const name = pair.slice(0, equals).trim()
        const value = pair.slice(equals + 1).trim()
        if (name && value) lines.push(`.${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}`)
      }
    }
    const runtimePath = join(cookiesDir, 'runtime-cookies.txt')
    await writeFile(runtimePath, lines.join('\n') + '\n', { mode: 0o600 })
    await chmod(runtimePath, 0o600)
    cachedCookiesPath = runtimePath
    log('info', 'Session cookies available to HTTP and external downloaders', { platforms: sessions.map(([domain]) => domain) })
  }
}

export function getCookiesPath(): string | null {
  return cachedCookiesPath
}

/**
 * เติมแฟล็ก Proxy และ Cookies ในคำสั่ง yt-dlp โดยอัตโนมัติ
 */
export function getYtDlpArgs(baseArgs: string[]): string[] {
  // ดึงคำสั่งแรกสุดออก (ปกติคือ 'yt-dlp') และเก็บอาร์กิวเมนต์ที่เหลือ
  const binary = baseArgs[0]
  const args = baseArgs.slice(1)
  
  // แทรก Proxy
  const targetUrl = args.find(arg => /^https?:\/\//i.test(arg))
  const proxy = targetUrl ? getProxyForUrl(targetUrl) : process.env.YT_DLP_PROXY
  if (proxy !== undefined) {
    args.push('--proxy', proxy)
  }
  
  // แทรก Cookies
  const cookiesPath = getCookiesPath()
  if (cookiesPath) {
    args.push('--cookies', cookiesPath)
  }

  // ปรับแต่ง Headers ให้เนียนสมจริงเหมือน Chrome Desktop สำหรับ Meta (Facebook, Instagram) (ป้องกัน Bot Detection / ตรวจจับพฤติกรรมอัตโนมัติ)
  const isFacebook = targetUrl && (/facebook\.com|fb\.watch/i.test(targetUrl))
  const isInstagram = targetUrl && (/instagram\.com/i.test(targetUrl))
  if ((isFacebook || isInstagram) && !args.includes('--user-agent')) {
    args.push(
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '--referer',
      isInstagram ? 'https://www.instagram.com/' : 'https://www.facebook.com/',
      '--add-header',
      'Accept-Language:th,en-US;q=0.9,en;q=0.8',
      '--add-header',
      'Sec-CH-UA:"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      '--add-header',
      'Sec-CH-UA-Mobile:?0',
      '--add-header',
      'Sec-CH-UA-Platform:"Windows"',
      '--add-header',
      'Sec-Fetch-Dest:document',
      '--add-header',
      'Sec-Fetch-Mode:navigate',
      '--add-header',
      'Sec-Fetch-Site:none',
      '--add-header',
      'Sec-Fetch-User:?1',
      '--add-header',
      'Upgrade-Insecure-Requests:1'
    )
  }
  
  return [binary, ...args]
}
