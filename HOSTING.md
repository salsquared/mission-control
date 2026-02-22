# Mission Control - Mac Mini Hosting Guide

Follow these steps on your Mac mini to host the Mission Control Next.js server 24/7.

## Prerequisites
1. Ensure Node.js is installed on your Mac mini.
2. Clone or transfer this `mission-control` repository to the Mac mini.
3. Open Terminal in the project folder.

## 1. Install Dependencies & Build
Run the following commands to prepare the production build:
```bash
npm install
npm run build
```

## 2. Install PM2
PM2 is a robust process manager that will keep your Next.js app running in the background and automatically restart it if it crashes.
```bash
npm install -g pm2
```

## 3. Start the Server
Start the Next.js production server using PM2:
```bash
pm2 start npm --name "mission-control" -- run start
```
You can verify it's running by typing `pm2 status`.

## 4. Enable Auto-Start on Reboot
To ensure the server starts immediately when you turn on or reboot the Mac mini:
```bash
pm2 startup
```
*PM2 will output a command starting with `sudo env PATH...`. Copy and paste that entire command into your terminal and press Enter.*

Finally, save the current PM2 list so it remembers to start `mission-control`:
```bash
pm2 save
```

## 5. Accessing the App (Windows & Mac)
Your server is now running on port `3000` (by default).
1. On your Mac mini, open `System Settings` -> `Network` to find its local IP address (e.g., `192.168.1.10`).
2. On your Windows PC (or any device on your Wi-Fi), open Chrome or Edge and navigate to:
   `http://[MAC_MINI_IP_ADDRESS]:3000`
3. Click the "Install App" icon in the address bar to install it as a standalone PWA!
