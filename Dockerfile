FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    ARKADE_SIDECAR_HOST=0.0.0.0 \
    ARKADE_SIDECAR_PORT=8765 \
    ARKADE_SIDECAR_STATE_PATH=/data/arkade-sidecar-state.json \
    ARKADE_STORAGE_PATH=/data/arkade-wallet.sqlite \
    ARKADE_SWAP_STORAGE_PATH=/data/arkade-swaps.sqlite

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs ./

RUN mkdir -p /data && chown -R node:node /app /data

USER node

VOLUME ["/data"]

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.ARKADE_SIDECAR_PORT || 8765}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
