# Build stage
FROM node:20-alpine AS builder

# Install pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
RUN corepack install

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN pnpm run build

# Production stage
FROM node:20-alpine

# Install pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
RUN corepack install

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy web files
COPY web/ ./web/

# Copy example config (user should mount their own config.json)
COPY config.example.json ./config.example.json

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/status || exit 1

# Run the application
CMD ["node", "dist/index.js"]
