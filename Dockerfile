# Use official Node.js 18 LTS (slim) as base image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json .
RUN npm install

# Copy application code
COPY bot.js .

# Command to run the bot
CMD ["node", "bot.js"]