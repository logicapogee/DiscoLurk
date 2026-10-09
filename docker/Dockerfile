# syntax=docker/dockerfile:1.7
# DiscoLurk for NAS / servers: `lurk serve --headless` with system Google Chrome. linux/amd64 only,
# because Google publishes no Linux arm64 build of Chrome.
#   docker build -f docker/Dockerfile --platform linux/amd64 -t ghcr.io/logicapogee/discolurk:dev .

# The bundle is plain JavaScript, so it is built on the build host's own platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY data ./data
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN node scripts/build-docker.ts

FROM node:24-bookworm-slim
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 || (echo "DiscoLurk images are linux/amd64 only: Google Chrome has no Linux arm64 build" && exit 1)
ENV DEBIAN_FRONTEND=noninteractive
# Chrome from Google's own apt repository (no Playwright browser download); CJK and emoji fonts so
# Chinese forum pages render; tzdata so TZ works; tini reaps Chrome's helper processes as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tzdata tini fonts-noto-cjk fonts-noto-color-emoji \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 lurk \
 && useradd --uid 10001 --gid lurk --create-home --home-dir /home/lurk lurk \
 && mkdir -p /data \
 && chown lurk:lurk /data

COPY --from=build /src/dist/docker /app

# Everything the app writes (profiles, schedules, logs) lives under $XDG_DATA_HOME/disco-lurk.
ENV XDG_DATA_HOME=/data \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    LURK_SITE=linuxdo \
    LURK_RUNS_PER_DAY=2 \
    LURK_WINDOW=07:00-23:00 \
    LURK_JITTER_MIN=15 \
    LURK_RUN_ON_START=true
VOLUME ["/data"]
USER lurk
WORKDIR /home/lurk
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/lurk.cjs"]
CMD ["serve", "--headless", "--host", "0.0.0.0", "--port", "8080"]
