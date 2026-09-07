# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 24 || minor < 14) process.exit(1)"

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM base AS production-dependencies
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM base AS runtime
ARG UIMORI_CODEX_VERSION=""
RUN if [ -n "$UIMORI_CODEX_VERSION" ]; then npm install --global "@openai/codex@$UIMORI_CODEX_VERSION" --no-audit --no-fund && npm cache clean --force; fi
ENV NODE_ENV=production NR_HOST=0.0.0.0 NR_PORT=4310 NR_DB=/data/narrative.sqlite
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
# An empty named volume receives this directory's initial content and ownership.
RUN mkdir -p /data && touch /data/.uimori-data && chown -R node:node /data
USER node
EXPOSE 4310
CMD ["node", "dist/server/index.js"]
