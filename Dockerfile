FROM node:20-alpine

WORKDIR /app

# tini: PID 1; certbot: host-driven Let's Encrypt DNS-01 (manual TXT) inside the container
RUN apk add --no-cache tini certbot

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
RUN chmod +x /app/scripts/*.sh

ENV NODE_ENV=production

EXPOSE 3456

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
