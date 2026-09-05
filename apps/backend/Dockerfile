# Build context is the repo root (pnpm workspace needs the root lockfile and
# the sibling apps/*/package.json files that pnpm-workspace.yaml globs):
#   docker build -f apps/backend/Dockerfile -t hexvault-backend .

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /repo

# apps/backend's own postinstall runs `prisma generate`, which needs
# prisma/schema.prisma on disk, so the full backend source has to be in
# place before `pnpm install` — no package.json-only caching trick here.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY apps/backend apps/backend
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hexvault/backend run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/backend

COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/backend /repo/apps/backend

EXPOSE 8080
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main.js"]
