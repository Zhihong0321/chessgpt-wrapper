#!/bin/sh
# Fix /storage ownership when Railway mounts the volume as root
if [ -d /storage ]; then
    chown -R pptruser:pptruser /storage 2>/dev/null || true
fi
exec su -s /bin/sh pptruser -c "npm start"
