# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
# Premium artifacts are installed only in the build stage. Never use a build ARG for this token.
RUN --mount=type=secret,id=heroui_token,required=true \
    npx -y hpsetup@4.7.4 "$(cat /run/secrets/heroui_token)"
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
WORKDIR /app
RUN mkdir -m 700 /app/data && chown node:node /app/data
COPY --chown=node:node server ./server
COPY --from=build --chown=node:node /app/dist ./dist
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
