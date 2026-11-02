FROM node:22-alpine
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
# dev deps included: the image also runs migrations, the worker and the test suite via tsx/vitest
RUN npm ci --include=dev && npm cache clean --force
COPY --chown=node:node tsconfig.json vitest.config.ts ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
