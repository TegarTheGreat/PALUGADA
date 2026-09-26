# PALUGADA in one image: the control plane, its worker and the owner's console.
#
# `docker compose up -d --build` runs it beside its database (docker-compose.yml);
# `npm run setup` writes the .env both read. The server is TypeScript that
# Node 22.18+ runs as it is, so the only build is the console's.

FROM node:22-bookworm-slim AS console
WORKDIR /app/console
COPY console/package.json console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY console/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY config ./config
COPY --from=console /app/console/dist ./console/dist

# Not as root: the platform starts agent CLIs on a company's behalf, and a
# process that can be talked into running something should not own the box.
# HOME is where those CLIs keep their own settings.
USER node
ENV HOME=/home/node PALUGADA_HOST=0.0.0.0 PALUGADA_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Migrations first, under an advisory lock, so replicas starting together
# apply each once; then the platform, as PID 1's only child that matters.
CMD ["sh", "-c", "node scripts/migrate.ts && exec node src/main.ts"]
