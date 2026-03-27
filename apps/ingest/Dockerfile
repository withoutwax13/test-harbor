FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm install --workspaces --include-workspace-root
CMD ["node", "apps/ingest/src/index.js"]
