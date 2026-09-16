import { Database } from 'bun:sqlite'
import { unlink, readdir, stat, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadStage } from '../types'
import { AppError } from '../utils/errors'
import { log, getTempDir, ensureDataDir } from '../utils/helpers'
import { cleanupPartialFiles } from '../utils/process'

export interface JobRecord {
  id: string
  access_token: string
  url: string
  option_id: string
  platform: string
  identifier: string | null
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'aborted'
  stage: DownloadStage
  progress: number
  filename: string | null
  file_path: string | null
  content_type: string | null
  file_size: number
  error: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

let db: Database

// เก็บ Controller สำหรับการ Cancel แบบ Real-time
const activeControllers = new Map<string, AbortController>()

/**
 * โฟลเดอร์แยกสำหรับแต่ละงาน (Per-job directory)
 */
export function getJobDir(jobId: string): string {
  const tempDir = getTempDir()
  return join(tempDir, 'jobs', jobId)
}

export async function ensureJobDir(jobId: string): Promise<string> {
  const dir = getJobDir(jobId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function removeJobDir(jobId: string): Promise<void> {
  try {
    const dir = getJobDir(jobId)
    await rm(dir, { recursive: true, force: true })
  } catch {}
}

/**
 * กำหนดค่าและสร้างฐานข้อมูล SQLite บน Persistent Volume (DATA_DIR)
 * พร้อมตรวจสอบ Interrupted Jobs เมื่อเริ่มระบบ
 */
export async function initJobManager(): Promise<void> {
  const dataDir = await ensureDataDir()
  const dbPath = join(dataDir, 'zentyr_fetch_jobs.db')

  db = new Database(dbPath, { create: true })

  // เพิ่มความเร็วและเสถียรภาพ SQLite บน NVMe/SSD
  db.run('PRAGMA journal_mode = WAL;')
  db.run('PRAGMA synchronous = NORMAL;')

  // สร้างตารางเก็บสถานะ Job
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      url TEXT NOT NULL,
      option_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      identifier TEXT,
      status TEXT NOT NULL,
      stage TEXT DEFAULT 'queued',
      progress REAL DEFAULT 0,
      filename TEXT,
      file_path TEXT,
      content_type TEXT,
      file_size INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)

  // Migration: เพิ่มคอลัมน์ stage หากมีตารางเดิมอยู่แล้ว
  try {
    db.run('ALTER TABLE jobs ADD COLUMN stage TEXT DEFAULT "queued";')
  } catch {}

  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);')
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);')

  log('info', `SQLite Job Database initialized at: ${dbPath}`)

  // ===== จัดการ Interrupted Jobs หลังเซิร์ฟเวอร์ Restart =====
  const interrupted = db.query<JobRecord, []>(
    "SELECT * FROM jobs WHERE status IN ('queued', 'downloading')"
  ).all()

  if (interrupted.length > 0) {
    log('warn', `Found ${interrupted.length} interrupted jobs from previous run. Recovering...`)

    const updateStmt = db.prepare(`
      UPDATE jobs 
      SET status = 'failed', 
          error = 'เซิร์ฟเวอร์เริ่มทำงานใหม่ งานถูกยกเลิก (Server restarted, job interrupted)',
          updated_at = ?
      WHERE id = ?
    `)

    const now = Date.now()
    for (const job of interrupted) {
      updateStmt.run(now, job.id)
      if (job.file_path) {
        cleanupPartialFiles(job.file_path).catch(() => {})
        try { unlink(job.file_path).catch(() => {}) } catch {}
      }
    }

    log('info', `Cleaned up ${interrupted.length} interrupted jobs successfully.`)
  }

  // Periodic Cleanup ทุก 10 นาที
  setInterval(() => {
    cleanupExpiredJobs().catch(err => log('error', 'Cleanup expired jobs failed', { error: err.message }))
    cleanupOrphanFiles().catch(err => log('error', 'Cleanup orphan files failed', { error: err.message }))
  }, 600000)
}

/**
 * สร้าง Job ใหม่ลง SQLite พร้อม Access Token
 */
export function createJob(params: {
  url: string
  optionId: string
  platform: string
  identifier?: string
}): { jobId: string; accessToken: string; abortController: AbortController } {
  const jobId = Math.random().toString(36).substring(2) + Date.now().toString(36)
  const accessToken = crypto.randomUUID()
  const now = Date.now()
  const expiresAt = now + 3600000 // 1 ชั่วโมง TTL ระหว่างประมวลผล

  const abortController = new AbortController()
  activeControllers.set(jobId, abortController)

  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, access_token, url, option_id, platform, identifier,
      status, stage, progress, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?)
  `)

  stmt.run(
    jobId,
    accessToken,
    params.url,
    params.optionId,
    params.platform,
    params.identifier || null,
    now,
    now,
    expiresAt
  )

  return { jobId, accessToken, abortController }
}

/**
 * ดึงข้อมูล Job
 */
export function getJob(jobId: string): JobRecord | null {
  const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?')
  return (stmt.get(jobId) as JobRecord) || null
}

/**
 * ตรวจสอบความถูกต้องและสิทธิ์การเข้าถึง Job ด้วย Access Token
 */
export function verifyJobOwnership(jobId: string, token?: string): JobRecord {
  const job = getJob(jobId)
  if (!job) {
    throw new AppError('JOB_NOT_FOUND', 'ไม่พบงานดาวน์โหลดนี้', 404)
  }

  if (!token || job.access_token !== token) {
    throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์เข้าถึงงานดาวน์โหลดนี้ (Invalid access token)', 403)
  }

  return job
}

/**
 * อัปเดตสถานะเป็น downloading
 */
export function setJobDownloading(jobId: string): void {
  const stmt = db.prepare(`
    UPDATE jobs 
    SET status = 'downloading', stage = 'downloading', updated_at = ? 
    WHERE id = ? AND status = 'queued'
  `)
  stmt.run(Date.now(), jobId)
}

/**
 * อัปเดตความคืบหน้า (0-100) และ Stage
 */
export function updateJobProgress(jobId: string, progress: number, stage?: DownloadStage): void {
  if (stage) {
    const stmt = db.prepare(`
      UPDATE jobs 
      SET progress = MAX(progress, ?), stage = ?, updated_at = ? 
      WHERE id = ? AND status = 'downloading'
    `)
    stmt.run(Math.min(Math.max(progress, 0), 100), stage, Date.now(), jobId)
  } else {
    const stmt = db.prepare(`
      UPDATE jobs 
      SET progress = MAX(progress, ?), updated_at = ? 
      WHERE id = ? AND status = 'downloading'
    `)
    stmt.run(Math.min(Math.max(progress, 0), 100), Date.now(), jobId)
  }
}

/**
 * อัปเดตเมื่องานสำเร็จ (Completed) และตั้ง TTL สำหรับเก็บไฟล์ให้โหลด (30 นาที)
 */
export function completeJob(
  jobId: string,
  filePath: string,
  filename: string,
  contentType: string,
  fileSize: number
): void {
  activeControllers.delete(jobId)

  const now = Date.now()
  const expiresAt = now + 1800000 // 30 นาที สำหรับดาวน์โหลด / โหลดซ้ำ / resume

  const stmt = db.prepare(`
    UPDATE jobs 
    SET status = 'completed', 
        stage = 'ready',
        progress = 100, 
        file_path = ?, 
        filename = ?, 
        content_type = ?, 
        file_size = ?, 
        updated_at = ?, 
        expires_at = ?
    WHERE id = ?
  `)

  stmt.run(filePath, filename, contentType, fileSize, now, expiresAt, jobId)
}

/**
 * อัปเดตเมื่องานล้มเหลว
 */
export function failJob(jobId: string, error: string): void {
  activeControllers.delete(jobId)

  const stmt = db.prepare(`
    UPDATE jobs 
    SET status = 'failed', error = ?, updated_at = ? 
    WHERE id = ?
  `)
  stmt.run(error, Date.now(), jobId)
}

/**
 * ยกเลิกงาน (Abort) พร้อมส่งสัญญาณยกเลิกไปยัง AbortController และลบโฟลเดอร์งานทันที
 */
export async function abortJob(jobId: string): Promise<void> {
  const job = getJob(jobId)
  if (!job) return

  // 1. สั่ง abort controller (ซึ่งจะส่งสัญญาณยุติการทำงานไปยัง Process Tree)
  const controller = activeControllers.get(jobId)
  if (controller) {
    controller.abort()
    activeControllers.delete(jobId)
  }

  // 2. ลบโฟลเดอร์ของ Job นี้ทิ้งอย่างสมบูรณ์
  await removeJobDir(jobId)

  // 3. ลบไฟล์ที่เกี่ยวข้อง (ถ้ามีระบุไว้)
  if (job.file_path) {
    await cleanupPartialFiles(job.file_path)
    try { await unlink(job.file_path) } catch {}
  }

  // 4. บันทึกสถานะว่า aborted
  const stmt = db.prepare(`
    UPDATE jobs 
    SET status = 'aborted', updated_at = ? 
    WHERE id = ?
  `)
  stmt.run(Date.now(), jobId)
  log('info', `Job ${jobId} successfully aborted and cleaned.`)
}

/**
 * ล้างงานที่หมดอายุตาม TTL (ลบทั้งโฟลเดอร์งานและบันทึกใน SQLite)
 */
export async function cleanupExpiredJobs(): Promise<void> {
  const now = Date.now()
  const expiredJobs = db.query<JobRecord, [number]>(
    'SELECT * FROM jobs WHERE expires_at < ?'
  ).all(now)

  if (expiredJobs.length === 0) return

  log('info', `Cleaning up ${expiredJobs.length} expired jobs...`)
  const deleteStmt = db.prepare('DELETE FROM jobs WHERE id = ?')

  for (const job of expiredJobs) {
    await removeJobDir(job.id)
    if (job.file_path) {
      try {
        const file = Bun.file(job.file_path)
        if (await file.exists()) {
          await unlink(job.file_path)
        }
      } catch {}
      await cleanupPartialFiles(job.file_path)
    }
    deleteStmt.run(job.id)
  }
}

/**
 * กำจัด Orphan Job Folders ในโฟลเดอร์ temp/jobs ที่ค้างเกิน 1 ชั่วโมง และไม่มีอยู่ในระบบ Job
 * ไม่แตะต้อง DATA_DIR หรือคุกกี้โดยเด็ดขาด
 */
export async function cleanupOrphanFiles(): Promise<void> {
  const jobsDir = join(getTempDir(), 'jobs')
  try {
    const entries = await readdir(jobsDir).catch(() => [] as string[])
    const now = Date.now()
    const oneHourAgo = now - 3600000

    const activeJobIds = new Set(
      db.query<{ id: string }, []>(
        "SELECT id FROM jobs WHERE status IN ('completed', 'downloading', 'queued')"
      ).all().map(r => r.id)
    )

    for (const jobId of entries) {
      if (activeJobIds.has(jobId)) continue

      const fullJobDir = join(jobsDir, jobId)
      try {
        const dirStat = await stat(fullJobDir)
        if (dirStat.mtimeMs < oneHourAgo) {
          await rm(fullJobDir, { recursive: true, force: true })
          log('info', `Removed orphan job dir: ${jobId}`)
        }
      } catch {}
    }
  } catch (err) {
    log('warn', `Failed orphan cleanup: ${(err as Error).message}`)
  }
}
