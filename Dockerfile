FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create storage dir; ownership fixed at runtime by entrypoint (Railway mounts override build-time chown)
RUN mkdir -p /storage && chown -R pptruser:pptruser /storage /app

# Stay root so entrypoint can fix volume ownership, then drops to pptruser
ENTRYPOINT ["/entrypoint.sh"]
