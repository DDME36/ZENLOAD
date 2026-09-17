import { describe, it, expect } from 'bun:test'
import {
  isPrivateOrReservedIp,
  isInternalHostname,
  parseAndValidateUrl,
  isAllowedImageProxyHost,
  isSafeSubpath,
} from '../src/utils/security'

describe('SSRF & IP Security Tests', () => {
  it('should identify private IPv4 ranges as dangerous', () => {
    // Loopback
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('127.255.255.254')).toBe(true)
    // Cloud Metadata Service (Oracle/AWS/GCP)
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true)
    expect(isPrivateOrReservedIp('169.254.1.1')).toBe(true)
    // RFC 1918 Private Ranges
    expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true)
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true)
    // 0.0.0.0
    expect(isPrivateOrReservedIp('0.0.0.0')).toBe(true)
    // Multicast & Reserved
    expect(isPrivateOrReservedIp('224.0.0.1')).toBe(true)
    expect(isPrivateOrReservedIp('240.0.0.1')).toBe(true)
  })

  it('should identify public IPv4 ranges as safe', () => {
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false)
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false)
    expect(isPrivateOrReservedIp('142.250.190.46')).toBe(false) // Google
  })

  it('should identify dangerous IPv6 addresses', () => {
    expect(isPrivateOrReservedIp('::1')).toBe(true)
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true)
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true)
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true)
  })

  it('should identify internal hostnames', () => {
    expect(isInternalHostname('localhost')).toBe(true)
    expect(isInternalHostname('myhost.local')).toBe(true)
    expect(isInternalHostname('server.internal')).toBe(true)
    expect(isInternalHostname('metadata.google.internal')).toBe(true)
    expect(isInternalHostname('instance-data')).toBe(true)
    expect(isInternalHostname('youtube.com')).toBe(false)
  })

  it('should reject invalid or dangerous URLs in parseAndValidateUrl', () => {
    // Protocol checks
    expect(() => parseAndValidateUrl('ftp://example.com/file')).toThrow()
    expect(() => parseAndValidateUrl('file:///etc/passwd')).toThrow()
    expect(() => parseAndValidateUrl('javascript:alert(1)')).toThrow()

    // SSRF target checks
    expect(() => parseAndValidateUrl('http://169.254.169.254/opc/v1/instance/')).toThrow()
    expect(() => parseAndValidateUrl('http://127.0.0.1:3001/api/debug-cookies')).toThrow()
    expect(() => parseAndValidateUrl('http://localhost:3001')).toThrow()
    expect(() => parseAndValidateUrl('http://10.0.0.5/secret')).toThrow()
  })

  it('should allow valid public URLs', () => {
    const parsed = parseAndValidateUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(parsed.hostname).toBe('www.youtube.com')
    expect(parsed.searchParams.get('v')).toBe('dQw4w9WgXcQ')
  })

  it('should correctly filter image proxy domains', () => {
    expect(isAllowedImageProxyHost('scontent.fbcdn.net')).toBe(true)
    expect(isAllowedImageProxyHost('instagram.com')).toBe(true)
    expect(isAllowedImageProxyHost('i.ytimg.com')).toBe(true)
    expect(isAllowedImageProxyHost('evil-attacker.com')).toBe(false)
  })

  it('should prevent path traversal via isSafeSubpath', () => {
    const base = process.platform === 'win32' ? 'C:\\temp\\jobs' : '/tmp/jobs'
    const safeSub = process.platform === 'win32' ? 'C:\\temp\\jobs\\job123\\file.mp4' : '/tmp/jobs/job123/file.mp4'
    const traversal = process.platform === 'win32' ? 'C:\\temp\\jobs\\..\\secret.txt' : '/tmp/jobs/../secret.txt'
    const unrelated = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd'

    expect(isSafeSubpath(base, safeSub)).toBe(true)
    expect(isSafeSubpath(base, traversal)).toBe(false)
    expect(isSafeSubpath(base, unrelated)).toBe(false)
  })
})
