# Contexte de build = racine du repo (monorepo npm workspaces) — voir
# .github/workflows/build-push.yml (file: apps/worker/Dockerfile, context: .)
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker
RUN npm run build -w @squash-assistant/db
RUN npm run build -w @squash-assistant/worker

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --omit=dev
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
USER node
CMD ["node", "apps/worker/dist/index.js"]
