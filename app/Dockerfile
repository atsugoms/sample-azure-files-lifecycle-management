FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY job/package*.json job/
RUN npm ci --prefix job
COPY job/src job/src
COPY job/scripts/azure-web-demo.mjs job/scripts/azure-web-demo.mjs
COPY job/tsconfig.json job/
COPY app/package*.json app/
RUN npm ci --prefix app
COPY app/src app/src
COPY app/tsconfig.json app/
RUN npm run build --prefix app && npm prune --omit=dev --prefix app && npm prune --omit=dev --prefix job

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /workspace/app
COPY --from=build --chown=node:node /workspace/job /workspace/job
COPY --from=build --chown=node:node /workspace/app /workspace/app
COPY --chown=node:node app/public /workspace/app/public
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
