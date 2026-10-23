FROM node:25-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# App files stay owned by root, so the unprivileged runtime user can read but
# never modify the code it runs.
COPY . .
USER node

EXPOSE 4000
CMD ["node", "server.js"]
