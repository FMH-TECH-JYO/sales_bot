# syntax=docker/dockerfile:1
#
# One image that serves both the API and the built React app on a single port.
# That is deliberate: with Express serving web/dist there is no cross-origin
# call between the browser and the API, which means the session cookie can be
# SameSite=Lax and CORS_ORIGINS can stay empty. Splitting them into two
# deployments would reintroduce both problems for no benefit at this scale.

# --- build stage -------------------------------------------------------------
# The frontend is built here and only its output is copied forward, so the
# runtime image carries no Vite, no React sources and no dev dependencies.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first, so `npm ci` is cached and only re-runs when a dependency
# actually changes — not on every source edit.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY db/package.json ./db/
COPY web/package.json ./web/

RUN npm ci

COPY . .
RUN npm run build --workspace=web

# --- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. --ignore-scripts because no dependency in this
# tree needs a postinstall to work, and a package that runs arbitrary code at
# install time inside the production image is a supply-chain risk with nothing
# to weigh against it.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY db/package.json ./db/
COPY web/package.json ./web/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY config ./config
COPY server/src ./server/src
COPY db ./db
COPY --from=build /app/web/dist ./web/dist

# .env.example is REQUIRED at runtime, not just for developer convenience:
# config/env.js creates .env from it when none exists, and every value in it is
# a working default. Without it the container starts with process-environment
# values only, which is fine when they are all supplied and a confusing failure
# when one is missed.
COPY .env.example ./.env.example

# The .docx offer templates. generateOffer.js resolves them at
# server/templates/offers/ and hasTemplate() returns false when the directory
# is absent, so every offer request answers "No offer template uploaded yet for
# category X" — the app's final step, silently unavailable.
#
# NOTE: this directory is NOT currently in the repository. The templates were
# supplied as attachments and never committed, so this COPY fails the build
# until they are added. That is deliberate: a build that fails loudly is better
# than an image that deploys and cannot generate a single offer. See DEPLOY.md.
COPY server/templates ./server/templates

# The node image ships an unprivileged `node` user. Running as root inside a
# container is not isolation; a container escape starts from whatever the
# process already is.
#
# The app writes to two places: the uploads directory (only when
# STORAGE_DRIVER=local — use STORAGE_DRIVER=db in production and it writes
# nowhere) and the repo-root .env that config/env.js creates on first run.
RUN mkdir -p /app/server/uploads && chown -R node:node /app
USER node

EXPOSE 4000

# The container is healthy when the process answers, which is what /health
# reports. /ready is the one that checks the database, and it is deliberately
# NOT used here: a database outage should route traffic away from an instance,
# not make the orchestrator kill and restart it into the same outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are NOT run from here. Running them on container start means N
# replicas racing the same DDL on every deploy, and it puts a schema change
# inside the same command as a restart, so a bad migration takes the service
# down instead of failing a deploy step. Run `npm run db:migrate` as its own
# step before rolling out. See DEPLOY.md.
CMD ["node", "server/src/index.js"]
