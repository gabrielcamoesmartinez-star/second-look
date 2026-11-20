# Build from the repo root:  docker build -f apps/worker/Dockerfile -t second-look-worker .
# The official Playwright image ships the exact Chromium build Playwright 1.65.1 expects.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @second-look/worker...

COPY packages/shared packages/shared
COPY apps/worker apps/worker

USER pwuser
WORKDIR /app/apps/worker
# SIGTERM reaches node directly (no shell), so graceful shutdown runs.
CMD ["node", "--import", "tsx", "src/main.ts"]
