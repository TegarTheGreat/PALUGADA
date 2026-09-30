# The image `npm run container:check` runs one role's run in
# (scripts/container-check.ts): Node, and a runtime that reports what it
# could and could not do from inside the container the `docker` backend
# starts. Nothing of PALUGADA is in it; the flags are what is being checked.
FROM node:22-alpine
COPY probe.mjs /probe/probe.mjs
ENTRYPOINT ["node", "/probe/probe.mjs"]
