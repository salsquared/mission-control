#!/bin/bash

# Load NVM (Node Version Manager) environment into the script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Explicitly tell NVM to use Node version 24 (LTS)
nvm use 24

# Go to your project directory
cd /Users/sal/salsquared/mission-control

# Set the port to 3101 to avoid conflicting with active development on port 4101
export PORT=3101

# Start the Next.js server in the background using the production build
npm run start &
SERVER_PID=$!

# Wait for the server to bind to our custom port 3101
echo "Waiting for Mission Control server to start on port $PORT..."
while ! nc -z 127.0.0.1 $PORT; do
  sleep 1
done

# Wait an extra few seconds to make sure the server is ready to accept HTTP traffic
sleep 3

# Launch Google Chrome in "App" mode pointing to the exact IP
# -W makes the script wait until this specific Chrome instance is closed!
open -n -W -a "Google Chrome" --args --app="http://127.0.0.1:$PORT"

# Shut down the Next.js server when the Chrome App window is closed
kill $SERVER_PID
