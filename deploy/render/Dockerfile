# Single-container image for a hosted demo (Render free tier: one web service + managed Postgres).
# Same code as the compose stack: nginx serves the SPA and proxies /v1 to the API on localhost,
# and the outbox worker runs as a second process. Locally, keep using `docker compose up --build`.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache nginx
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force
COPY api/tsconfig.json ./
COPY api/migrations ./migrations
COPY api/src ./src
COPY --from=web /web/dist /usr/share/nginx/html
COPY deploy/render/nginx.conf /etc/nginx/http.d/default.conf
COPY deploy/render/start.sh /start.sh
RUN chmod +x /start.sh
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["/start.sh"]
