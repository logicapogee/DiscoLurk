# syntax=docker/dockerfile:1.7
# DiscoLurk for NAS / servers: `lurk serve --headless` with system Google Chrome. linux/amd64 only,
# because Google publishes no Linux arm64 build of Chrome.
#   docker build -f docker/Dockerfile --platform linux/amd64 -t ghcr.io/logicapogee/discolurk:dev .
# Settings come from the environment at run time (see docker/.env.example); their defaults live in
# the application, not here.

# The bundle is plain JavaScript, so it is built on the build host's own platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
# Dependencies are fetched from the lockfile alone, so this layer survives source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --store-dir /pnpm/store
COPY packages ./packages
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY data ./data
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /pnpm/store
RUN pnpm build:ui && node scripts/build-docker.ts

FROM node:24-bookworm-slim
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 || (echo "DiscoLurk images are linux/amd64 only: Google Chrome has no Linux arm64 build" && exit 1)
ENV DEBIAN_FRONTEND=noninteractive
# Chrome from Google's own apt repository (no Playwright browser download); a CJK and an emoji font
# so Chinese forum pages render; tzdata so TZ works; tini reaps Chrome's helper processes as PID 1.
# The image runs only its own bundle, so the package managers that ship with the Node image go.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tzdata tini fonts-wqy-microhei fonts-noto-color-emoji \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

RUN groupadd --gid 10001 lurk \
 && useradd --uid 10001 --gid lurk --create-home --home-dir /home/lurk lurk \
 && mkdir -p /data \
 && chown lurk:lurk /data

COPY --from=build /src/dist/docker /app

# Everything the app writes (profiles, schedules, logs) lives under $XDG_DATA_HOME/disco-lurk.
ENV XDG_DATA_HOME=/data \
    NODE_ENV=production
VOLUME ["/data"]
USER lurk
WORKDIR /home/lurk
EXPOSE 8080

# lurk serve listens on LURK_PORT when it is set, else on its default 8080.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.LURK_PORT||8080}/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/lurk.cjs"]
CMD ["serve", "--headless", "--host", "0.0.0.0"]
