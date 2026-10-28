# syntax=docker/dockerfile:1
# 协作空间 hub / 成员容器共用镜像：零外部依赖，Node 内置 node:sqlite
FROM node:22-alpine
WORKDIR /app
COPY src ./src
# 容器里不需要 package.json（.mjs 直接跑），也不需要装任何依赖
ENV NODE_ENV=production
EXPOSE 7321
CMD ["node", "src/cli.mjs", "serve", "--dir", "/space", "--listen", "0.0.0.0:7321"]
