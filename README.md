This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Prerequisites

This project requires **Node.js LTS** (currently **v24.13.1**). We recommend using [nvm](https://github.com/nvm-sh/nvm) (or [nvm-windows](https://github.com/coreybutler/nvm-windows) for Windows) to manage your Node versions.

To install and use the recommended version:

```bash
nvm install lts
nvm use lts
```

## Getting Started

To test the application run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

The development server runs on **port 4101** and is configured to use up to **2GB of RAM** (`--max-old-space-size=2048`).

Open [http://localhost:4101](http://localhost:4101) with your browser to see the result.

### Running as a Desktop App (Production)

To run the application natively on the desktop without terminal windows:

```bash
npm run build
./launch-ms.sh
```

The production build runs on **port 3101** to avoid conflicts with active development, and is optimized to use a maximum of **1GB of RAM** (`--max-old-space-size=1024`). The `launch-ms.sh` script automatically opens a Chrome window in "App Mode" pointing to `http://127.0.0.1:3101`.


## Documentation

- [API Documentation](docs/apis.md) - keeps track of internal and external APIs consumed by this project.
