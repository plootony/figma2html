#!/usr/bin/env bash
# Stops the site2figma server.
fuser -k -TERM "${PORT:-4747}/tcp" 2>/dev/null && echo "Остановлен" || echo "Не был запущен"
