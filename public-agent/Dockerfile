# Multi-stage build keeps the final image small and free of build tooling.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# iptables: egress lockdown at the container boundary.
# bind-tools:  dig, for resolving the OpenRouter hostname at boot.
# su-exec:     drop from root (required to set iptables) to node before exec.
RUN apk add --no-cache iptables bind-tools su-exec

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY SKILL.md ./SKILL.md
COPY knowledge ./knowledge
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /app/data && chown -R node:node /app/data /app/knowledge

# Start as root so entrypoint.sh can install iptables rules. It drops to
# node via su-exec before exec'ing node.
EXPOSE 4200
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]
