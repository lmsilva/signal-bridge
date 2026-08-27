FROM node:20-alpine

WORKDIR /app

# tini: PID 1; certbot: host-driven Let's Encrypt DNS-01 (manual TXT) inside the container
# python3/py3-pip: the YouTube Lounge sidecar (pyytlounge) — there is no Node
# client for YouTube's undocumented Lounge API, so detection runs in Python.
# ffmpeg: Roll Credits poster frames and animated video previews (ffprobe comes
# with it), and it also lets yt-dlp merge separate video+audio streams.
# android-tools: `adb`, for the read-only logcat tail of the Huupe hoop. The
# bridge dials the hoop over wireless ADB (host networking); nothing is ever
# installed or written on the device.
RUN apk add --no-cache tini certbot python3 py3-pip ffmpeg android-tools

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# A venv keeps pyytlounge off the system Python that certbot uses; Alpine's
# python3 is PEP 668 "externally managed" and refuses a bare pip install.
#
# yt-dlp: prefer the PyPI pin in requirements-roll-credits.txt. QNAP builds often
# lose DNS mid-pip (`[Errno -3] Try again` → "from versions: none"); when that
# happens, fall back to the matching GitHub release binary (tag is zero-padded:
# PyPI 2026.8.19 ↔ GitHub 2026.08.19). Bump both when YouTube starts 400-ing.
COPY requirements-youtube.txt requirements-roll-credits.txt ./
ENV YT_DLP_GITHUB_TAG=2026.08.19
RUN python3 -m venv /opt/youtube-venv \
    && /opt/youtube-venv/bin/pip install --no-cache-dir --retries 10 --timeout 60 \
         -r requirements-youtube.txt \
    && ( /opt/youtube-venv/bin/pip install --no-cache-dir --retries 10 --timeout 60 \
           -r requirements-roll-credits.txt \
         || ( echo "WARN: pip could not reach PyPI for yt-dlp — installing GitHub ${YT_DLP_GITHUB_TAG}" \
              && /opt/youtube-venv/bin/python3 -c "\
import urllib.request; \
urllib.request.urlretrieve( \
  'https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_GITHUB_TAG}/yt-dlp', \
  '/opt/youtube-venv/bin/yt-dlp')" \
              && chmod a+rx /opt/youtube-venv/bin/yt-dlp ) ) \
    && /opt/youtube-venv/bin/yt-dlp --version
ENV YOUTUBE_PYTHON_BIN=/opt/youtube-venv/bin/python3
ENV YT_DLP_BIN=/opt/youtube-venv/bin/yt-dlp

COPY src ./src
COPY scripts ./scripts
RUN chmod +x /app/scripts/*.sh

ENV NODE_ENV=production

EXPOSE 3456

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
