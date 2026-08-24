FROM node:20-alpine

WORKDIR /app

# tini: PID 1; certbot: host-driven Let's Encrypt DNS-01 (manual TXT) inside the container
# python3/py3-pip: the YouTube Lounge sidecar (pyytlounge) — there is no Node
# client for YouTube's undocumented Lounge API, so detection runs in Python.
# ffmpeg: Roll Credits poster frames and animated video previews (ffprobe comes
# with it), and it also lets yt-dlp merge separate video+audio streams.
RUN apk add --no-cache tini certbot python3 py3-pip ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# A venv keeps pyytlounge off the system Python that certbot uses; Alpine's
# python3 is PEP 668 "externally managed" and refuses a bare pip install.
COPY requirements-youtube.txt requirements-roll-credits.txt ./
RUN python3 -m venv /opt/youtube-venv \
    && /opt/youtube-venv/bin/pip install --no-cache-dir -r requirements-youtube.txt \
    && /opt/youtube-venv/bin/pip install --no-cache-dir -r requirements-roll-credits.txt
ENV YOUTUBE_PYTHON_BIN=/opt/youtube-venv/bin/python3
ENV YT_DLP_BIN=/opt/youtube-venv/bin/yt-dlp

COPY src ./src
COPY scripts ./scripts
RUN chmod +x /app/scripts/*.sh

ENV NODE_ENV=production

EXPOSE 3456

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
