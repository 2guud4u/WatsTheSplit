# WatsTheSplit — single-stage Bun image: build dist, run server.
FROM oven/bun:1.4

WORKDIR /app

COPY package.json tsconfig.json vite.config.ts index.html ./
COPY client ./client
COPY server ./server

# VITE_BASE = deploy path prefix baked into the client bundle (import.meta.env.BASE_URL).
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE

RUN bun install --frozen-lockfile=false 2>/dev/null || bun install
RUN bunx vite build

ENV PORT=8081
ENV DB_PATH=/data/data.db
EXPOSE 8081

# /data is bind-mounted from the host for the SQLite DB.
VOLUME /data
CMD ["bun", "server/index.ts"]
