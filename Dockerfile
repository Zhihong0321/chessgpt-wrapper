FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Create storage dir and ensure permissions
RUN mkdir -p /storage && chown -R pptruser:pptruser /storage /app

USER pptruser

CMD ["npm", "start"]
