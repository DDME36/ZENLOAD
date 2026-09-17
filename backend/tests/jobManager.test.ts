import { describe, it, expect, beforeAll } from 'bun:test'
import {
  initJobManager,
  createJob,
  getJob,
  verifyJobOwnership,
  setJobDownloading,
  updateJobProgress,
  completeJob,
  abortJob,
  sanitizeJobId,
} from '../src/services/jobManager'
import { CapacityGate, IpRateLimiter } from '../src/utils/limits'
import { AppError } from '../src/utils/errors'

describe('SQLite Job Manager & Security Tests', () => {
  beforeAll(async () => {
    await initJobManager()
  })

  it('should create a job and generate an access token', () => {
    const { jobId, accessToken } = createJob({
      url: 'https://youtube.com/watch?v=test12345',
      optionId: 'video_1080p',
      platform: 'youtube',
      identifier: 'test12345',
    })

    expect(jobId).toBeDefined()
    expect(accessToken).toBeDefined()
    expect(accessToken.length).toBeGreaterThan(10)

    const job = getJob(jobId)
    expect(job).not.toBeNull()
    expect(job?.status).toBe('queued')
    expect(job?.progress).toBe(0)
    expect(job?.platform).toBe('youtube')
    expect(job?.identifier).toBe('test12345')
  })

  it('should verify ownership with access token', () => {
    const { jobId, accessToken } = createJob({
      url: 'https://youtube.com/watch?v=test12345',
      optionId: 'video_720p',
      platform: 'youtube',
    })

    // Correct token passes
    const job = verifyJobOwnership(jobId, accessToken)
    expect(job.id).toBe(jobId)

    // Missing or invalid token throws FORBIDDEN (403)
    expect(() => verifyJobOwnership(jobId, 'wrong-token')).toThrow()
    expect(() => verifyJobOwnership(jobId, undefined)).toThrow()

    // Non-existent job throws JOB_NOT_FOUND (404)
    expect(() => verifyJobOwnership('non-existent-job-id', accessToken)).toThrow()
  })

  it('should update job lifecycle: queued -> downloading -> completed with stage progression', () => {
    const { jobId, accessToken } = createJob({
      url: 'https://youtube.com/watch?v=test12345',
      optionId: 'video_1080p',
      platform: 'youtube',
    })

    let job = getJob(jobId)
    expect(job?.status).toBe('queued')
    expect(job?.stage).toBe('queued')

    // Set downloading
    setJobDownloading(jobId)
    job = getJob(jobId)
    expect(job?.status).toBe('downloading')
    expect(job?.stage).toBe('downloading')

    // Update progress with stage
    updateJobProgress(jobId, 45.5, 'downloading')
    job = getJob(jobId)
    expect(job?.progress).toBe(45.5)
    expect(job?.stage).toBe('downloading')

    // Update progress to merging stage
    updateJobProgress(jobId, 93, 'merging')
    job = getJob(jobId)
    expect(job?.progress).toBe(93)
    expect(job?.stage).toBe('merging')

    // Update progress to converting stage
    updateJobProgress(jobId, 96, 'converting')
    job = getJob(jobId)
    expect(job?.progress).toBe(96)
    expect(job?.stage).toBe('converting')

    // Complete job
    completeJob(jobId, '/tmp/test_file.mp4', 'test_file.mp4', 'video/mp4', 10485760)
    job = getJob(jobId)
    expect(job?.status).toBe('completed')
    expect(job?.stage).toBe('ready')
    expect(job?.progress).toBe(100)
    expect(job?.filename).toBe('test_file.mp4')
    expect(job?.file_size).toBe(10485760)
    expect(job?.expires_at).toBeGreaterThan(Date.now())
  })

  it('should handle aborting a job cleanly', async () => {
    const { jobId } = createJob({
      url: 'https://youtube.com/watch?v=abortme',
      optionId: 'video_1080p',
      platform: 'youtube',
    })

    await abortJob(jobId)
    const job = getJob(jobId)
    expect(job?.status).toBe('aborted')
  })

  it('should sanitize job IDs and strip unsafe characters', () => {
    expect(sanitizeJobId('../../etc/passwd')).toBe('etcpasswd')
    expect(sanitizeJobId('safe_job-123')).toBe('safe_job-123')
    expect(sanitizeJobId('job;rm -rf /')).toBe('jobrm-rf')
  })
})

describe('CapacityGate Tests', () => {
  it('rejects a third immediate acquisition without retaining a waiter, then admits after release', () => {
    const gate = new CapacityGate(2, new AppError('TEST_BUSY', 'busy', 429))

    const firstLease = gate.tryAcquire()
    const secondLease = gate.tryAcquire()

    expect(firstLease).toBeFunction()
    expect(secondLease).toBeFunction()
    expect(gate.getActiveCount()).toBe(2)
    expect(gate.tryAcquire()).toBeNull()
    expect(gate.getActiveCount()).toBe(2)

    firstLease?.()
    expect(gate.getActiveCount()).toBe(1)

    const replacementLease = gate.tryAcquire()
    expect(replacementLease).toBeFunction()
    expect(gate.getActiveCount()).toBe(2)

    secondLease?.()
    replacementLease?.()
    expect(gate.getActiveCount()).toBe(0)
  })
})

describe('IP Rate Limiter Tests', () => {
  it('should throttle requests exceeding the limit', () => {
    const limiter = new IpRateLimiter(3, 5000)
    const testIp = '192.0.2.1'

    expect(() => limiter.check(testIp)).not.toThrow()
    expect(() => limiter.check(testIp)).not.toThrow()
    expect(() => limiter.check(testIp)).not.toThrow()
    // 4th call should throw 429
    expect(() => limiter.check(testIp)).toThrow()
  })
})
