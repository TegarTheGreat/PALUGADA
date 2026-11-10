# PALUGADA in one image: the control plane, its worker and the owner's console.
#
# `docker compose up -d --build` runs it beside its database (docker-compose.yml);
# `npm run setup` writes the .env both read. The server is TypeScript that
# Node 22.18+ runs as it is, so the only build is the console's.
#
# Both stages start from one image, pinned by digest under its tag: a tag is
# moved to new contents whenever Node or Debian ships, so the same Dockerfile
# built on two days was two images. The digest is the multi-platform index
# of node:22-bookworm-slim on 2026-09-30 (Node 22.23.3), as Docker Hub and
# its mirror both served it; Dependabot proposes the next one.

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS console
WORKDIR /app/console
COPY console/package.json console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY console/ ./
RUN npm run build

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production
# tini is PID 1, and Node its child. An agent CLI's own children outlive it
# now and then -- a tool process, a shell -- and are handed to PID 1 when it
# exits. Node as PID 1 never waits for a process it did not start, so each
# stayed a zombie for the life of the container; tini reaps them, and passes
# SIGTERM on so the worker still hands its work back. git keeps the history
# of the charters (F3.11, charter-repository.ts); without it they are kept as
# files with no history.
#
# Chromium, for the companies' browsers (src/browser/), with a font whose
# letters are as wide as the ones pages ask for; Debian's, so its security
# updates are Debian's. About 270 MB: `--build-arg PALUGADA_BROWSER=0`
# leaves it out, and the browser is then unbound and the boot says so. It
# runs with its sandbox, which needs the seccomp profile docker-compose.yml
# gives the container (deploy/docker/seccomp-chromium.json).
ARG PALUGADA_BROWSER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git \
      $(if [ "$PALUGADA_BROWSER" = 1 ]; then echo chromium fonts-liberation; fi) \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY config ./config
COPY deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY --from=console /app/console/dist ./console/dist

# Not as root: the platform starts agent CLIs on a company's behalf, and a
# process that can be talked into running something should not own the box.
# HOME is where those CLIs keep their own settings.
USER node
ENV HOME=/home/node PALUGADA_HOST=0.0.0.0 PALUGADA_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The database provisioned when a superuser's URL is given, migrations run
# when the schema owner's is, and then the platform, under tini, without
# either and without any database password the container was handed
# (deploy/docker/entrypoint.sh says why PID 1 must not hold them). Docker
# Compose migrates in a service of its own and gives the platform no such
# URL at all.
ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
CMD ["node", "src/main.ts"]
