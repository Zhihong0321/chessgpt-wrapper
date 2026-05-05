FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app

# Create storage dir before switching users
RUN mkdir -p /storage

COPY --chown=pptruser:pptruser package*.json ./

# Run npm ci as pptruser so puppeteer's Chrome lands in /home/pptruser/.cache/puppeteer
USER pptruser
RUN npm ci --only=production

USER root
COPY --chown=pptruser:pptruser . .

# Fix ownership (Railway volume mounts as root, entrypoint re-fixes at runtime)
RUN chown -R pptruser:pptruser /storage /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Stay root so entrypoint can fix volume ownership, then drops to pptruser
ENTRYPOINT ["/entrypoint.sh"]
