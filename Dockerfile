FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the unprivileged "node" user that ships with the official image, not root.
COPY --from=build --chown=node:node /app ./
USER node

EXPOSE 3000
CMD ["npm", "start"]
