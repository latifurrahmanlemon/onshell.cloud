FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml turbo.json tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN yarn install

FROM deps AS build
COPY . .
RUN yarn turbo build --filter @onshell/api...

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/yarn.lock /app/.yarnrc.yml /app/turbo.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/packages ./packages
EXPOSE 4000
CMD ["yarn", "workspace", "@onshell/api", "start"]
