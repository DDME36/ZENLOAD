import { unlink } from 'node:fs/promises'
import { log } from './helpers'

/**
 * สั่งหยุดกระบวนการ Subprocess และกระบวนการลูกทั้งหมด (Process Tree)
 * พร้อมรอ (await) ให้กระบวนการยุติการทำงานอย่างแท้จริง ก่อนส่งคืน Promise
 * ป้องกัน ffmpeg / python ตกค้างเป็น Zombie/Orphan บน Oracle Linux/Ubuntu
 */
export async function killProcessTree(proc: { pid: number; exited?: Promise<number>; kill: (signal?: any) => void }): Promise<void> {
  const pid = proc.pid
  if (!pid) return

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (!proc.exited) {
      await new Promise(r => setTimeout(r, timeoutMs))
      return true
    }
    let timer: any
    const timeoutPromise = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const exitedPromise = proc.exited.then(() => {
      clearTimeout(timer)
      return true
    }).catch(() => {
      clearTimeout(timer)
      return true
    })
    return Promise.race([exitedPromise, timeoutPromise])
  }

  try {
    if (process.platform === 'win32') {
      // บน Windows ใช้ taskkill เพื่อฆ่าทั้ง subtree
      try {
        const killer = Bun.spawn(['taskkill', '/PID', String(pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await killer.exited
      } catch {}
      await waitForExit(1000)
    } else {
      // บน Linux / macOS: ส่ง SIGTERM ไปยัง process group ก่อน
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          proc.kill('SIGTERM')
        } catch {}
      }
      try {
        Bun.spawn(['pkill', '-TERM', '-P', String(pid)], { stdout: 'ignore', stderr: 'ignore' })
      } catch {}

      const exitedGracefully = await waitForExit(1500)

      if (!exitedGracefully) {
        // หากยังไม่ยุติภายใน 1.5 วินาที ให้ส่ง SIGKILL บังคับหยุดทันที
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try { proc.kill('SIGKILL') } catch {}
        }
        try {
          Bun.spawn(['pkill', '-KILL', '-P', String(pid)], { stdout: 'ignore', stderr: 'ignore' })
        } catch {}
        await waitForExit(1000)
      }
    }
  } catch (err) {
    log('warn', `Failed to kill process tree for PID ${pid}`, { error: (err as Error).message })
  }
}

/**
 * ลบไฟล์ partial ที่ค้างอยู่ เช่น .part, .ytdl
 */
export async function cleanupPartialFiles(baseFilePath: string): Promise<void> {
  const possiblePaths = [
    baseFilePath,
    `${baseFilePath}.part`,
    `${baseFilePath}.ytdl`,
    baseFilePath.replace(/\.[^.]+$/, '.part'),
    baseFilePath.replace(/\.[^.]+$/, '.ytdl'),
  ]

  for (const p of possiblePaths) {
    try {
      const file = Bun.file(p)
      if (await file.exists()) {
        await unlink(p)
        log('info', `Cleaned up partial file: ${p}`)
      }
    } catch {}
  }
}

/**
 * รวม User AbortSignal และ Timeout เข้าด้วยกันอย่างเป็นแบบแผน (Composite Signal)
 */
export function createTimeoutSignal(timeoutMs: number, userSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => {
    timeoutCtrl.abort()
  }, timeoutMs)

  let compositeSignal: AbortSignal
  if (userSignal) {
    if (typeof (AbortSignal as any).any === 'function') {
      compositeSignal = (AbortSignal as any).any([userSignal, timeoutCtrl.signal])
    } else {
      const compositeCtrl = new AbortController()
      const onAbort = () => compositeCtrl.abort()
      userSignal.addEventListener('abort', onAbort)
      timeoutCtrl.signal.addEventListener('abort', onAbort)
      compositeSignal = compositeCtrl.signal
    }
  } else {
    compositeSignal = timeoutCtrl.signal
  }

  const cleanup = () => {
    clearTimeout(timer)
  }

  return { signal: compositeSignal, cleanup }
}
