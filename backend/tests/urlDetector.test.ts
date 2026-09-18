import { describe, it, expect } from 'bun:test'
import { detectUrl, isValidUrl } from '../src/services/urlDetector'

describe('URL Detector Tests', () => {
  it('should detect YouTube URLs correctly', () => {
    const res1 = detectUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(res1.platform).toBe('youtube')
    expect(res1.identifier).toBe('dQw4w9WgXcQ')

    const res2 = detectUrl('https://youtu.be/dQw4w9WgXcQ')
    expect(res2.platform).toBe('youtube')
    expect(res2.identifier).toBe('dQw4w9WgXcQ')

    const res3 = detectUrl('https://www.youtube.com/shorts/abcdef12345')
    expect(res3.platform).toBe('youtube')
    expect(res3.identifier).toBe('abcdef12345')
  })

  it('should detect Instagram URLs correctly', () => {
    const res1 = detectUrl('https://www.instagram.com/p/C123456789/')
    expect(res1.platform).toBe('instagram')
    expect(res1.identifier).toBe('C123456789')

    const res2 = detectUrl('https://instagram.com/reel/D987654321')
    expect(res2.platform).toBe('instagram')
    expect(res2.identifier).toBe('D987654321')

    const res3 = detectUrl('https://instagram.com/zentyr_user')
    expect(res3.platform).toBe('instagram')
    expect(res3.identifier).toBe('zentyr_user')

    const res4 = detectUrl('https://www.instagram.com/share/p/C123456789/')
    expect(res4.platform).toBe('instagram')
    expect(res4.contentType).toBe('post')
    expect(res4.originalUrl).toBe('https://www.instagram.com/p/C123456789/')

    const res5 = detectUrl('https://www.instagram.com/share/reel/D987654321/')
    expect(res5.platform).toBe('instagram')
    expect(res5.contentType).toBe('reel')
    expect(res5.originalUrl).toBe('https://www.instagram.com/reel/D987654321/')
  })

  it('should detect Facebook URLs correctly', () => {
    const res1 = detectUrl('https://www.facebook.com/profile.php?id=1000123456789')
    expect(res1.platform).toBe('facebook')
    expect(res1.identifier).toBe('1000123456789')

    const res2 = detectUrl('https://fb.watch/abc123xyz/')
    expect(res2.platform).toBe('facebook')
    expect(res2.identifier).toBe('abc123xyz')
  })

  it('should detect other supported platforms', () => {
    expect(detectUrl('https://soundcloud.com/artist/song-title').platform).toBe('soundcloud')
    expect(detectUrl('https://www.tiktok.com/@user/video/1234567890123456789').platform).toBe('tiktok')
    expect(detectUrl('https://www.tiktok.com/@user/video/1234567890123456789').contentType).toBe('video')
    expect(detectUrl('https://www.tiktok.com/@user/photo/7646726205856582930').platform).toBe('tiktok')
    expect(detectUrl('https://www.tiktok.com/@user/photo/7646726205856582930').contentType).toBe('album')
    expect(detectUrl('https://www.tiktok.com/@user/photo/7646726205856582930').identifier).toBe('7646726205856582930')
    expect(detectUrl('https://x.com/user/status/1234567890123456789').platform).toBe('twitter')
    expect(detectUrl('https://twitter.com/user/status/1234567890123456789').platform).toBe('twitter')
    expect(detectUrl('https://www.reddit.com/r/videos/comments/abcde/cool_video/').platform).toBe('reddit')
    expect(detectUrl('https://vimeo.com/123456789').platform).toBe('vimeo')
    expect(detectUrl('https://www.twitch.tv/videos/123456789').platform).toBe('twitch')
  })

  it('should not allow hostname spoofing via URL path or query', () => {
    // If an attacker hosts evil.com/youtube.com/watch?v=123
    const res = detectUrl('https://evil-attacker.com/youtube.com/watch?v=123')
    expect(res.platform).toBe('unknown')
  })

  it('should classify content types accurately for Instagram and Facebook', () => {
    // Instagram
    const igPost = detectUrl('https://www.instagram.com/p/C123456789/')
    expect(igPost.platform).toBe('instagram')
    expect(igPost.contentType).toBe('post')
    expect(igPost.identifier).toBe('C123456789')

    const igReel = detectUrl('https://instagram.com/reel/D987654321')
    expect(igReel.platform).toBe('instagram')
    expect(igReel.contentType).toBe('reel')
    expect(igReel.identifier).toBe('D987654321')

    const igProfile = detectUrl('https://instagram.com/zentyr_user')
    expect(igProfile.platform).toBe('instagram')
    expect(igProfile.contentType).toBe('profile')
    expect(igProfile.identifier).toBe('zentyr_user')

    const igStory = detectUrl('https://instagram.com/stories/zentyr_user/123456789')
    expect(igStory.platform).toBe('instagram')
    expect(igStory.contentType).toBe('story')

    // Facebook
    const fbProfile = detectUrl('https://www.facebook.com/profile.php?id=1000123456789')
    expect(fbProfile.platform).toBe('facebook')
    expect(fbProfile.contentType).toBe('profile')

    const fbWatch = detectUrl('https://fb.watch/abc123xyz/')
    expect(fbWatch.platform).toBe('facebook')
    expect(fbWatch.contentType).toBe('watch')

    const fbReel = detectUrl('https://www.facebook.com/reel/999888777')
    expect(fbReel.platform).toBe('facebook')
    expect(fbReel.contentType).toBe('reel')
    expect(fbReel.identifier).toBe('999888777')

    const fbVideo = detectUrl('https://www.facebook.com/watch/?v=1122334455')
    expect(fbVideo.platform).toBe('facebook')
    expect(fbVideo.contentType).toBe('watch')
    expect(fbVideo.identifier).toBe('1122334455')

    // YouTube playlist vs video
    const ytPlaylist = detectUrl('https://www.youtube.com/playlist?list=PL123456789')
    expect(ytPlaylist.platform).toBe('youtube')
    expect(ytPlaylist.contentType).toBe('playlist')

    const ytVideo = detectUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(ytVideo.platform).toBe('youtube')
    expect(ytVideo.contentType).toBe('video')
  })

  it('should detect direct media URLs for various media extensions', () => {
    const video = detectUrl('https://example.com/videos/sample.mp4')
    expect(video.platform).toBe('direct')
    expect(video.contentType).toBe('video')
    expect(video.identifier).toBe('sample.mp4')

    const audio = detectUrl('https://example.com/podcasts/track.mp3')
    expect(audio.platform).toBe('direct')
    expect(audio.contentType).toBe('audio')
    expect(audio.identifier).toBe('track.mp3')

    const image = detectUrl('https://example.com/gallery/photo.webp')
    expect(image.platform).toBe('direct')
    expect(image.contentType).toBe('image')
    expect(image.identifier).toBe('photo.webp')
  })

  it('should validate URLs properly in isValidUrl', () => {
    expect(isValidUrl('https://youtube.com/watch?v=123')).toBe(true)
    expect(isValidUrl('not-a-url')).toBe(false)
    expect(isValidUrl('http://169.254.169.254')).toBe(false) // Blocked by SSRF check!
    expect(isValidUrl('http://localhost:3000')).toBe(false) // Blocked by SSRF check!
  })
})
