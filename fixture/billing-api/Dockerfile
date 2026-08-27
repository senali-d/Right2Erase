FROM node:22-alpine
WORKDIR /app
COPY billing-api/package.json ./package.json
RUN npm install --omit=dev
COPY billing-api/server.js ./server.js
EXPOSE 4010
CMD ["node", "server.js"]
