# WebSend

**2-way Airdrop for any device on the same WiFi.**

No accounts. No size limits. No internet required. Transfer files instantly between phones, tablets, and computers — regardless of OS.

## How it works

WebSend uses WebRTC for true peer-to-peer file transfer. Files are chunked into 16KB pieces and sent directly between devices on the same network. No cloud. No server middleman. Just local discovery via WebSocket signaling.

## Features

- **Unlimited file size** — chunked 16KB peer-to-peer transfer
- **Any device** — phone, tablet, desktop, mixed OS
- **Truly local** — works without internet
- **Auto-discovery** — devices appear automatically on the same WiFi
- **Progress tracking** — real-time transfer progress with cancel support
- **No accounts** — zero sign-up, zero tracking

## Quick Start

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/benclawbot/WebSend.git
cd WebSend
npm install
npm run dev
```

Then open `http://localhost:3000` on any device connected to the same WiFi network.

## Deploy

### Build for production

```bash
npm run build
```

This generates a static bundle in `dist/`. Serve it with any static host:

```bash
npx serve dist
# or
npm run preview
```

### Deploy to Vercel / Netlify

The app is a standard Vite React app. Set `dist/` as the output directory.

For full P2P functionality, you need the WebSocket signaling server. Deploy the Node server separately, or add it as a serverless function.

## Tech

- React 19 + TypeScript
- Vite
- Tailwind CSS v4
- WebRTC (peer-to-peer data channels)
- WebSocket (device discovery signaling)
- Express + ws (signaling server)

## Why WebSend?

AirDrop only works Apple-to-Apple. Snapdrop and similar tools are browser-only and often slow. WebSend gives you:

- **No size limits** — chunked 16KB WebRTC data channels handle any file size
- **Native feel** — progressive web app that works like a real app
- **Full device support** — iOS Safari, Android Chrome, desktop browsers, any OS
- **No cloud dependency** — works completely offline on any LAN

## Contributing

Issues and PRs welcome.
