FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable \
  && corepack install --global pnpm@11.19.0 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/scheduler/package.json apps/scheduler/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/monitoring/package.json packages/monitoring/package.json
COPY packages/notifications/package.json packages/notifications/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
COPY . .
RUN pnpm db:generate && pnpm build

FROM base AS api
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 4000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]

FROM base AS scheduler
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 4101
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/scheduler/dist/index.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 4102
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS web
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@linkalive/web", "start"]
