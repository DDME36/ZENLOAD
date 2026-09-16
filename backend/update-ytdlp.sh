#!/bin/bash
# สคริปต์สำหรับอัปเดต yt-dlp และ gallery-dl บน Ubuntu Production Server
set -e

echo "🔄 Updating yt-dlp, yt-dlp-ejs, and gallery-dl..."

# อัปเดตแพ็กเกจด้วย pip3
pip3 install --break-system-packages --upgrade yt-dlp yt-dlp-ejs gallery-dl

# แสดงเวอร์ชันปัจจุบัน
echo "✅ yt-dlp version: $(yt-dlp --version)"
echo "✅ gallery-dl version: $(gallery-dl --version)"

echo "✅ Downloader tools update complete!"

