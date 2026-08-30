FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3006
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma generate && npm run start"]
