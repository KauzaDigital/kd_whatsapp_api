FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production PORT=3000 KD_MESSAGES_DB=/data/messages.sqlite
EXPOSE 3000
CMD ["node", "src/app.js"]
