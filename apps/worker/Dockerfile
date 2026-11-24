# Build from the repo root:  docker build -f apps/worker/Dockerfile .
FROM mcr.microsoft.com/playwright:v1.49.1-noble AS build
WORKDIR /app
RUN npm i -g pnpm@9.15.9
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @second-look/worker...
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @second-look/worker build \
 && pnpm --filter @second-look/worker deploy --prod /out

FROM mcr.microsoft.com/playwright:v1.49.1-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER pwuser
# SIGTERM from the platform triggers a graceful shutdown (finish or re-queue running audits).
CMD ["node", "dist/index.js"]
