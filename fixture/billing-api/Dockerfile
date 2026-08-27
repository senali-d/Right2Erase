FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY billing-api/package.json ./package.json
COPY billing-api/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY billing-api/server.js ./server.js
EXPOSE 4010
CMD ["node", "server.js"]
