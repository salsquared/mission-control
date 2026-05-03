#!/bin/bash

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm use 24

cd /Users/sal/salsquared/mission-control

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export PORT=4101
APP_URL="http://localhost:$PORT"

if [ "$1" == "--restart" ] || [ "$1" == "restart" ]; then
  echo "Restarting mission-control-dev..."
  pm2 delete mission-control-dev 2>/dev/null || true
  if lsof -t -i:$PORT > /dev/null; then
    kill -9 $(lsof -t -i:$PORT) 2>/dev/null || true
  fi
fi

if nc -z localhost $PORT || nc -z 127.0.0.1 $PORT || nc -z ::1 $PORT; then
  echo "mission-control-dev already running on port $PORT."
  echo "Opening Chrome..."
  open -n -W -a "Google Chrome" --args --app="$APP_URL"
else
  echo "Starting mission-control-dev via PM2..."
  NODE_OPTIONS='--max-old-space-size=2048' pm2 start node_modules/next/dist/bin/next \
    --name "mission-control-dev" \
    --kill-timeout 5000 \
    -- dev -p $PORT --webpack

  echo "Waiting for dev server on port $PORT..."
  while ! nc -z localhost $PORT && ! nc -z 127.0.0.1 $PORT && ! nc -z ::1 $PORT; do
    sleep 1
  done
  sleep 3

  open -n -W -a "Google Chrome" --args --app="$APP_URL"
fi
