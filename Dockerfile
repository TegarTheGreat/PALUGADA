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
# tini is PID 1, and Node its child. An agent CLI's own children outlive it
# now and then -- a tool process, a shell -- and are handed to PID 1 when it
# exits. Node as PID 1 never waits for a process it did not start, so each
# stayed a zombie for the life of the container; tini reaps them, and passes
# SIGTERM on so the worker still hands its work back.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
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
# apply each once; then the platform, as the only child of tini.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node scripts/migrate.ts && exec node src/main.ts"]
