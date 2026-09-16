import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { app } from '../src/index'
import { mediaCache } from '../src/utils/cache'
import { analyzeCapacity, downloadCapacity } from '../src/utils/limits'
import { getDataDir } from '../src/utils/helpers'

describe('Elysia HTTP API Endpoints & Security Integration Tests', () => {
  it('should verify /health endpoint returns safe system stats', async () => {
    const res = await app.handle(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(data.name).toBe('Zenload API')
    expect(data.concurrency).toEqual({
      analyzing: { active: 0, limit: 2 },
      downloading: { active: 0, limit: 2 },
    })
  })

  it('should verify /api/system/status does NOT leak cookies', async () => {
    const res = await app.handle(new Request('http://localhost/api/system/status'))
    expect(res.status).toBe(200)
    const text = await res.text()
    // ตรวจสอบว่าไม่มีข้อมูล cookie หรือ filePreview หลุดออกมาเลย
    expect(text.includes('cookiesText')).toBe(false)
    expect(text.includes('filePreview')).toBe(false)
    expect(text.includes('YT_DLP_COOKIES_TEXT')).toBe(false)

    const json = JSON.parse(text)
    expect(json.success).toBe(true)
    expect(json.name).toBe('Zenload API')
    expect(json.tools).toBeDefined()
  }, 15000)

  it('should confirm /api/debug-cookies endpoint is removed (404)', async () => {
    const res = await app.handle(new Request('http://localhost/api/debug-cookies'))
    expect(res.status).toBe(404)
  })

  it('should not expose backend logs over the public API', async () => {
    const res = await app.handle(new Request('http://localhost/api/logs'))
    expect(res.status).toBe(404)
  })

  it('should block SSRF attacks on /api/proxy-image', async () => {
    // Cloud metadata attack (Oracle/AWS/GCP IMDS)
    const res1 = await app.handle(
      new Request('http://localhost/api/proxy-image?url=http://169.254.169.254/opc/v1/instance/')
    )
    expect(res1.status).toBeGreaterThanOrEqual(400)

    // Localhost SSRF probe
    const res2 = await app.handle(
      new Request('http://localhost/api/proxy-image?url=http://127.0.0.1:3001/health')
    )
    expect(res2.status).toBeGreaterThanOrEqual(400)
  })

  it('should block SSRF attacks on /api/analyze', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://169.254.169.254/secret' }),
      })
    )

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.success).toBe(false)
    expect(data.error.code).toBe('INVALID_URL')
  })

  it('returns a cached analysis without consuming an analysis lease', async () => {
    const url = 'https://www.youtube.com/watch?v=cachedMedia'
    const firstLease = analyzeCapacity.tryAcquire()
    const secondLease = analyzeCapacity.tryAcquire()
    mediaCache.set(url, { platform: 'youtube', title: 'Cached media', options: [] } as any)

    try {
      const res = await app.handle(
        new Request('http://localhost/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
      )

      expect(res.status).toBe(200)
      expect((await res.json()).data.title).toBe('Cached media')
      expect(analyzeCapacity.getActiveCount()).toBe(2)
    } finally {
      firstLease?.()
      secondLease?.()
      mediaCache.clear()
    }
  })

  it('rejects a download at full capacity before creating a SQLite job', async () => {
    const database = new Database(join(getDataDir(), 'zentyr_fetch_jobs.db'))
    const beforeCount = (database.query('SELECT count(*) AS count FROM jobs').get() as { count: number }).count
    const firstLease = downloadCapacity.tryAcquire()
    const secondLease = downloadCapacity.tryAcquire()

    try {
      const res = await app.handle(
        new Request('http://localhost/api/download/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://www.youtube.com/watch?v=capacityFull',
            option: 'video_720p',
          }),
        })
      )

      expect(res.status).toBe(429)
      expect((await res.json()).error.code).toBe('DOWNLOAD_BUSY')
      const afterCount = (database.query('SELECT count(*) AS count FROM jobs').get() as { count: number }).count
      expect(afterCount).toBe(beforeCount)
      expect(downloadCapacity.getActiveCount()).toBe(2)
    } finally {
      firstLease?.()
      secondLease?.()
      database.close()
    }
  })

  it('should create a download job via POST /api/download/start and verify access token', async () => {
    const startRes = await app.handle(
      new Request('http://localhost/api/download/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          option: 'video_720p',
        }),
      })
    )

    expect(startRes.status).toBe(200)
    const startData = await startRes.json()
    expect(startData.success).toBe(true)
    expect(startData.jobId).toBeDefined()
    expect(startData.accessToken).toBeDefined()

    const { jobId, accessToken } = startData

    // 1. ตรวจสอบสถานะด้วย token ที่ถูกต้อง -> สำเร็จ
    const statusRes = await app.handle(
      new Request(`http://localhost/api/download/status?jobId=${jobId}&token=${accessToken}`)
    )
    expect(statusRes.status).toBe(200)
    const statusData = await statusRes.json()
    expect(statusData.success).toBe(true)
    expect(['queued', 'downloading']).toContain(statusData.status)

    // 2. ตรวจสอบสถานะด้วย token ที่ผิด -> 403 Forbidden
    const wrongTokenRes = await app.handle(
      new Request(`http://localhost/api/download/status?jobId=${jobId}&token=invalid-token`)
    )
    expect(wrongTokenRes.status).toBe(403)

    // 3. ขอยกเลิกงานด้วย token ที่ถูกต้อง -> สำเร็จ
    const cancelRes = await app.handle(
      new Request('http://localhost/api/download/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, token: accessToken }),
      })
    )
    expect(cancelRes.status).toBe(200)
    const cancelData = await cancelRes.json()
    expect(cancelData.success).toBe(true)
  })

  it('should serve frontend correctly with /zenload base path', async () => {
    const res = await app.handle(new Request('http://localhost/zenload/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const manifestRes = await app.handle(new Request('http://localhost/zenload/manifest.json'))
    expect(manifestRes.status).toBe(200)
    expect(manifestRes.headers.get('content-type')).toContain('application/manifest+json')
  })
})
