# Contexte de build = racine du repo (monorepo npm workspaces) — voir
# .github/workflows/build-push-ui.yml (file: apps/ui/Dockerfile, context: .)
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/ui/package.json apps/ui/package.json
RUN npm ci
COPY packages/db ./packages/db
COPY apps/ui ./apps/ui
RUN npm run build -w @squash-assistant/db
RUN npm run build -w @squash-assistant/ui

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/ui/.next/standalone ./
COPY --from=build /app/apps/ui/.next/static ./apps/ui/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/ui/server.js"]
