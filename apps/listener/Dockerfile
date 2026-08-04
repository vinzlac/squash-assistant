# Contexte de build = racine du repo (monorepo npm workspaces) — voir
# .github/workflows/build-push-listener.yml (file: apps/listener/Dockerfile, context: .)
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/listener/package.json apps/listener/package.json
RUN npm ci
COPY packages/db ./packages/db
COPY apps/listener ./apps/listener
RUN npm run build -w @squash-assistant/db
RUN npm run build -w @squash-assistant/listener

FROM node:20-alpine
WORKDIR /app
ARG GIT_SHA=unknown
ARG GIT_COMMIT_DATE=unknown
ARG GIT_COMMIT_MESSAGE=unknown
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
ENV GIT_COMMIT_DATE=$GIT_COMMIT_DATE
ENV GIT_COMMIT_MESSAGE=$GIT_COMMIT_MESSAGE
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/listener/package.json apps/listener/package.json
RUN npm ci --omit=dev
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/listener/dist ./apps/listener/dist
USER node
CMD ["node", "apps/listener/dist/index.js"]
