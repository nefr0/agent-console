FROM node:24.11.1-bookworm-slim AS node
FROM python:3.12.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.163.0
WORKDIR /opt/agent-console
COPY . .
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /app
