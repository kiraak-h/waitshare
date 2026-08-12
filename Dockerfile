# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    SEED_DEMO=0
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /app/server/data
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
