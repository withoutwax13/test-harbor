FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY apps ./apps
RUN npm install --workspaces --include-workspace-root
CMD ["node", "apps/web/src/server.js"]
