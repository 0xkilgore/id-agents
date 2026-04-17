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
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY SKILL.md ./SKILL.md
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4200
CMD ["node", "dist/server.js"]
