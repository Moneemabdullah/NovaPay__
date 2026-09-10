# syntax=docker/dockerfile:1

# --- Stage 1: install all dependencies (deterministic via lockfile) ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: typecheck the source ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Stage 3: runtime image with production dependencies only ---
# No registry fetch here: reuse the node_modules tree from `builder`
# and strip dev/peer packages locally with `npm prune` (offline deletion).
FROM node:20-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
# typescript is only an optional peer of @prisma/client/prisma; drop it for a true prod-only tree
RUN npm prune --omit=dev --omit=peer \
    && rm -rf node_modules/typescript node_modules/.bin/tsc
COPY --from=builder /app/src ./src
EXPOSE 3000
CMD ["npm", "run", "start"]