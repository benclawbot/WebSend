# WebSend

**Private, two-way file transfer for devices on the same network.**

WebSend uses WebRTC data channels to move files directly between browsers. The signaling server only introduces devices and relays connection metadata; file bytes do not pass through it.

## Current status

The transfer pipeline has been hardened for desktop and mobile browsers.

- Single-file transfers
- Multi-file selection
- Complete folder transfer with directory structure preserved in a TAR archive
- Correct binary reconstruction and MIME types
- Ordered, reliable WebRTC data channels
- Mobile-safe backpressure and bounded send buffering
- Queued ICE candidates during connection setup
- Stable device identity across WebSocket reconnects
- Incoming request queue instead of overwritten prompts
- Transfer request, connection, and inactivity timeouts
- Explicit failure reasons when a target disappears or signaling fails
- Completion acknowledgements over the peer data channel
- Clickable received files with separate **Open** and **Save** actions
- Persistent received-file object URLs until the transfer entry is removed
- WebSocket heartbeat cleanup for stale phones and suspended tabs

The code now has stronger transport and state handling, but real-world browser behavior still depends on network configuration and mobile operating-system background policies. Cross-device validation should include Android Chrome, iOS Safari, desktop Chrome/Edge, Firefox, and Safari.

## How it works

1. Each browser establishes a WebSocket connection to the signaling server.
2. Devices on the same WebSend server appear in the nearby-device list.
3. The sender selects one file, several files, or a folder.
4. Multiple files and folders are packaged as a standards-compatible USTAR archive.
5. The receiver accepts or rejects the transfer.
6. WebRTC offer, answer, and ICE information are exchanged through WebSocket signaling.
7. File bytes move directly over an ordered, reliable WebRTC data channel in 16 KB chunks.
8. The sender applies backpressure when the browser's outbound buffer grows.
9. The receiver validates the exact byte count, reconstructs the original MIME type, and acknowledges completion over the data channel.
10. The completed receive entry becomes clickable so the file can be opened or saved.

## Features

### File and folder selection

Click a nearby device and choose:

- **Select files** for one or more individual files
- **Select folder** for a complete directory

A single file is sent as-is. Multiple files or a folder are bundled into a `.tar` archive so filenames and directory paths are retained.

### Mobile reliability

The transfer implementation includes several safeguards aimed specifically at phones and tablets:

- conservative 16 KB WebRTC messages
- send-buffer high/low water marks
- sequential asynchronous receive processing
- pending ICE-candidate queues
- stable device IDs after signaling reconnects
- peer-channel completion acknowledgements that do not depend on WebSocket continuity
- connection-loss grace periods
- stale WebSocket heartbeat cleanup
- explicit transfer timeouts and errors

### Received files

After a receive transfer completes:

- click the filename or external-link icon to open it
- click the download icon to save it
- remove the transfer entry when it is no longer needed

The browser decides whether a format can be displayed directly. Images, PDFs, text, audio, and video commonly open in-browser; unknown formats may download instead.

### Privacy

- No accounts
- No cloud file storage
- No file-size limit imposed by the application protocol
- File bytes travel peer to peer
- The signaling server sees transfer metadata, not file contents

## Quick start

### Requirements

- Node.js 18 or newer
- Two devices able to reach the same WebSend server
- A browser with WebRTC data-channel support

### Development

```bash
git clone https://github.com/benclawbot/WebSend.git
cd WebSend
npm install
npm run dev
```

Open `http://localhost:3000` on the host device. Other devices must use the host machine's LAN address, for example:

```text
http://192.168.1.25:3000
```

Do not use `localhost` from a second phone or computer; on that device, `localhost` points back to itself.

### Validation

```bash
npm run lint
npm run build
```

`npm run lint` runs TypeScript checking with no output. `npm run build` creates the production bundle in `dist/`.

## Production

```bash
npm run build
NODE_ENV=production npm run dev
```

The server uses `PORT=3000` by default and honors a custom `PORT` environment variable.

A production deployment must support long-lived WebSocket connections on `/ws`. A static-only Vite deployment is insufficient because discovery and WebRTC signaling require the Node server.

For transfers between devices, serve WebSend from a network address both devices can reach. HTTPS is recommended for internet-facing deployments. Local-network browser rules differ by platform, so test the exact origin and devices being used.

## Architecture

```text
Browser A                         Browser B
   │                                 │
   ├──── WebSocket signaling ────────┤
   │          Node server            │
   │                                 │
   └════ reliable WebRTC data ═══════┘
              file bytes
```

### Client

- React 19
- TypeScript
- Vite
- Tailwind CSS 4
- WebRTC data channels
- WebSocket signaling

### Server

- Express
- `ws`
- Vite middleware in development
- Static `dist/` hosting in production

## Transfer integrity and failure handling

WebSend relies on reliable, ordered SCTP delivery through WebRTC and adds application-level checks:

- received bytes must equal the advertised file size exactly
- excess bytes fail the transfer
- data-channel errors fail both the transfer state and connection
- receiver progress and final completion use data-channel control messages
- ICE candidates received before a remote description are queued and replayed
- unavailable targets generate an explicit signaling error
- cancelled transfers clean up buffers, timers, channels, and peer connections

## Known limitations

- Browsers must keep the page active enough to continue networking. Mobile operating systems may suspend background tabs or lock-screen activity.
- Some Wi-Fi networks enable client isolation, preventing devices from reaching each other even when connected to the same access point.
- Received files are assembled in browser memory before an object URL can be opened. Very large receives can exceed available memory on constrained phones.
- Folder selection uses the browser's directory-picker support. Availability varies by browser and operating system.
- Folder and multi-file transfers use TAR. Some mobile platforms need a file-manager application to extract TAR archives.
- WebRTC without a TURN relay may not connect across restrictive networks or different NATs. WebSend is primarily designed for reachable devices on the same LAN.

## Troubleshooting

### A device does not appear

- Confirm both devices opened the same server address and port.
- Do not use `localhost` on the second device.
- Check firewall rules on the host computer.
- Disable guest-network or access-point client isolation.
- Keep both browser tabs in the foreground during diagnosis.

### A transfer stays pending

- Confirm the receiver still has the incoming-transfer prompt open.
- Refresh both devices if either switched networks or slept.
- Check that `/ws` is supported by the deployment.

### A transfer fails on a phone

- Keep the screen awake and WebSend visible.
- Try a smaller file to separate memory pressure from connectivity.
- Verify the phone and host can reach each other directly on the LAN.
- Review the exact failure reason displayed under the transfer.

### A received file does not open

- Use the Save action and open it from the system file manager.
- Confirm the receiving platform supports the file format.
- TAR bundles may require an archive application on mobile.

## Repository status

The latest reliability pass covers the complete transfer lifecycle: selection, request queuing, signaling, ICE setup, data-channel flow control, byte validation, completion acknowledgement, cancellation, reconnect behavior, stale-client cleanup, and receiver-side opening.

The remaining validation priority is a physical-device matrix, especially long transfers and sleep/background transitions on iOS and Android.
