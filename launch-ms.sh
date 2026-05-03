#!/bin/bash

# Load NVM (Node Version Manager) environment into the script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Explicitly tell NVM to use Node version 24 (LTS)
nvm use 24

# Go to your project directory
cd /Users/sal/salsquared/mission-control

# Explicitly source the .env file to ensure externally dependent APIs have their keys loaded.
# Using set -a automatically exports all variables defined in the sourced file.
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Set the port to 3101 to avoid conflicting with active development on port 4101
export PORT=3101

# Check for restart flag
if [ "$1" == "--restart" ] || [ "$1" == "restart" ]; then
  echo "Force restarting Mission Control..."
  # Set restart guard so PATCH/POST /api/tasks returns 503 during the kill window
  touch /Users/sal/salsquared/mission-control/.restart-flag
  pm2 delete mission-control 2>/dev/null || true
  if lsof -t -i:$PORT > /dev/null; then
    echo "Killing stale process on port $PORT..."
    kill -9 $(lsof -t -i:$PORT) 2>/dev/null || true
  fi
fi

# Check if the port is already in use (i.e. server running in the bg via pm2)
if nc -z localhost $PORT || nc -z 127.0.0.1 $PORT || nc -z ::1 $PORT; then
  echo "Mission Control server is already running on port $PORT."
  echo "Opening Chrome App..."
  # Use http://localhost:$PORT to let Chrome handle IPv4/IPv6 resolution dynamically
  open -n -W -a "Google Chrome" --args --app="http://localhost:$PORT"
else
  # Ensure PM2 log rotation is configured (idempotent)
  pm2 install pm2-logrotate 2>/dev/null || true
  pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
  pm2 set pm2-logrotate:retain 30 2>/dev/null || true

  echo "Running production DB migrations..."
  npm run migrate:prod

  echo "Starting the Next.js server via PM2..."
  # Start the Next.js server persistently in the background using PM2 directly to the binary.
  # This prevents NPM wrapper from leaving an orphaned node process running on port 3101 when deleted!
  NODE_OPTIONS='--max-old-space-size=1024' pm2 start node_modules/next/dist/bin/next --kill-timeout 10000 --name "mission-control" -- start -p $PORT

  # Wait for the server to bind to our custom port 3101 using localhost checks
  echo "Waiting for Mission Control server to start on port $PORT..."
  while ! nc -z localhost $PORT && ! nc -z 127.0.0.1 $PORT && ! nc -z ::1 $PORT; do
    sleep 1
  done

  # Wait an extra few seconds to make sure the server is ready to accept HTTP traffic
  sleep 3

  # Launch Google Chrome in "App" mode pointing to localhost instead of IP string
  # -W makes the script wait until this specific Chrome instance is closed!
  open -n -W -a "Google Chrome" --args --app="http://localhost:$PORT"

  # Note: 
  # We NO LONGER kill the PM2 server when the Chrome App window closes.
  # The server will persist and continuously run in the background.
  # If you need to view the server logs, use: `pm2 logs mission-control`
fi
