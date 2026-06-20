FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

EXPOSE 3456

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
