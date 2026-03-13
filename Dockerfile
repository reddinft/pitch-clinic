FROM oven/bun:1-alpine
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["bun", "server.js"]
