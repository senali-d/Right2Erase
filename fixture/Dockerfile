FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install express --omit=dev
COPY server.js ./
EXPOSE 4010
CMD ["node", "server.js"]
