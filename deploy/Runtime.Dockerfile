FROM node:24.14.0-bookworm-slim AS workspace
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.9.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY tooling ./tooling
COPY config ./config
COPY legal ./legal
COPY tests ./tests
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
FROM workspace AS api
RUN rm -rf tooling config tests && find apps packages -type d -name tests -prune -exec rm -rf '{}' +
ENV NODE_ENV=production
RUN mkdir -p /var/lib/identity-avatars && chown node:node /var/lib/identity-avatars
USER node
CMD ["node", "apps/account-api/dist/main/main.js"]
FROM api AS account
CMD ["node", "apps/account-api/dist/main/main.js"]
FROM api AS admin
CMD ["node", "apps/admin-api/dist/main/main.js"]
FROM workspace AS tooling
CMD ["node", "tooling/prepare-lab.mjs"]
FROM workspace AS production-tooling
RUN rm -f tooling/bootstrap-lab.mjs tooling/smoke.mjs && find apps packages -type d -name tests -prune -exec rm -rf '{}' +
RUN rm -rf tests
USER node
CMD ["node", "tooling/init-catalogue.mjs"]
FROM nginx:1.28.0-alpine AS web
COPY --from=workspace /app/apps/account-web/dist /usr/share/nginx/html/account
COPY --from=workspace /app/apps/admin-web/dist /usr/share/nginx/html/admin
COPY deploy/local/nginx.conf /etc/nginx/conf.d/default.conf
FROM web AS production-web
COPY deploy/production/nginx.conf /etc/nginx/conf.d/default.conf
