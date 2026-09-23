FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/avainpelaaja.db
RUN mkdir -p /data
EXPOSE 8080
CMD ["node","server/index.js"]
