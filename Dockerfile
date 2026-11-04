# syntax=docker/dockerfile:1
# AI Town Planner web app (phone PWA): frontend + Rust API server in one small image.

# 1) Frontend (Vite) -> /web/dist
FROM node:20-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npx vite build

# 2) API server (reuses the desktop core from src-tauri/src)
FROM rust:1-bookworm AS server
WORKDIR /src
COPY src-tauri/src ./src-tauri/src
COPY src-tauri/knowledge ./src-tauri/knowledge
COPY server ./server
WORKDIR /src/server
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked && cp target/release/atp-server /usr/local/bin/atp-server

# 3) Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=server /usr/local/bin/atp-server /usr/local/bin/atp-server
COPY --from=web /web/dist /app/dist
ENV DATA_DIR=/data DIST_DIR=/app/dist PORT=8080
EXPOSE 8080
CMD ["atp-server"]
