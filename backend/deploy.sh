#!/bin/bash
# ==============================================================================
# Zenload Backend — Production Deployment Script for Ubuntu Oracle Cloud
# Target Path: /home/ubuntu/zenload-backend
# Service Name: zenload-backend.service
# ==============================================================================
set -e

echo "🚀 [Zenload] Starting production deployment on Ubuntu Oracle..."

# 1. ตรวจสอบโฟลเดอร์ทำงาน
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
echo "📂 Working directory: $APP_DIR"

# 2. ตรวจสอบ Bun runtime
if ! command -v bun &> /dev/null; then
  if [ -f "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "❌ Error: Bun runtime not found. Please install Bun first."
    exit 1
  fi
fi
echo "✅ Bun version: $(bun --version)"

# 3. ตรวจสอบเครื่องมือดาวน์โหลด (yt-dlp, gallery-dl, ffmpeg, deno)
echo "🔍 Checking downloader dependencies..."
command -v yt-dlp >/dev/null 2>&1 || echo "⚠️ Warning: yt-dlp not found in PATH"
command -v gallery-dl >/dev/null 2>&1 || echo "⚠️ Warning: gallery-dl not found in PATH"
command -v ffmpeg >/dev/null 2>&1 || echo "⚠️ Warning: ffmpeg not found in PATH"
command -v deno >/dev/null 2>&1 || echo "⚠️ Warning: deno not found in PATH (needed for YouTube JS challenge solver)"

# 4. สร้าง Directory สำหรับ Persistent Data และ Temp หากยังไม่มี
mkdir -p data/cookies logs /tmp/download-everything
chmod 755 data logs /tmp/download-everything

# 5. ติดตั้ง/อัปเดต Node modules ด้วย Bun แบบ Production
echo "📦 Installing production dependencies..."
bun install --production

# 6. ตรวจสอบ Typecheck และความสมบูรณ์ของโค้ด
echo "🧪 Running type check..."
bun run typecheck

# 7. รีสตาร์ท systemd service
SERVICE_NAME="zenload-backend.service"
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || [ -f "/etc/systemd/system/$SERVICE_NAME" ]; then
  echo "🔄 Restarting $SERVICE_NAME..."
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2

  # ตรวจสอบ Health Check
  echo "🩺 Checking backend health..."
  HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health || true)
  if [ "$HEALTH_STATUS" = "200" ]; then
    echo "✅ Backend is healthy and running! (HTTP 200)"
  else
    echo "⚠️ Warning: Health check returned HTTP $HEALTH_STATUS. Checking systemctl status..."
    sudo systemctl status "$SERVICE_NAME" --no-pager -n 15
  fi
else
  echo "ℹ️ Note: $SERVICE_NAME not found or inactive. Run with: bun run src/index.ts or configure systemd."
fi

echo "🎉 [Zenload] Deployment script completed successfully!"
