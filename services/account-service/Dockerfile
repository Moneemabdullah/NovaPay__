# syntax=docker/dockerfile:1

# --- Stage 1: install all dependencies (deterministic via lockfile) ---
FROM node:20-alpine AS deps
ENV PRISMA_GENERATE_SKIP_AUTOGENERATION=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: generate the Prisma client and typecheck the source ---
FROM node:20-alpine AS builder
ARG DATABASE_URL
ENV PRISMA_GENERATE_SKIP_AUTOGENERATION=true
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
    && npm run build

# --- Stage 3: runtime image with production dependencies only ---
FROM node:20-alpine AS production
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
ENV PRISMA_GENERATE_SKIP_AUTOGENERATION=true
WORKDIR /app
COPY package.json package-lock.json ./
# typescript is only an optional peer of @prisma/client/prisma; drop it for a true prod-only tree
RUN npm ci --omit=dev --omit=peer \
    && rm -rf node_modules/typescript node_modules/.bin/tsc
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]