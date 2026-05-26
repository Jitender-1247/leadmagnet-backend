# Use the official Microsoft Playwright image with Node.js pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Set working directory inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy your Express source code
COPY . .

# Expose the port your Express app listens on (e.g., 3000 or 8080)
EXPOSE 3000

# Start your Express server
CMD ["node", "server.js"]