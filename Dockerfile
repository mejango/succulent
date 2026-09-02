FROM node:26.5.0-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_BENDYSTRAW_URL
ARG NEXT_PUBLIC_PARA_API_KEY
ARG NEXT_PUBLIC_PARA_ENV
ARG NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID
ARG NEXT_PUBLIC_RPC_1
ARG NEXT_PUBLIC_RPC_10
ARG NEXT_PUBLIC_RPC_8453
ARG NEXT_PUBLIC_RPC_42161
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_BENDYSTRAW_URL=$NEXT_PUBLIC_BENDYSTRAW_URL \
    NEXT_PUBLIC_PARA_API_KEY=$NEXT_PUBLIC_PARA_API_KEY \
    NEXT_PUBLIC_PARA_ENV=$NEXT_PUBLIC_PARA_ENV \
    NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID \
    NEXT_PUBLIC_RPC_1=$NEXT_PUBLIC_RPC_1 \
    NEXT_PUBLIC_RPC_10=$NEXT_PUBLIC_RPC_10 \
    NEXT_PUBLIC_RPC_8453=$NEXT_PUBLIC_RPC_8453 \
    NEXT_PUBLIC_RPC_42161=$NEXT_PUBLIC_RPC_42161
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
