import express from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
}

interface Client {
  id: string;
  ws: AliveWebSocket;
  name: string;
  deviceType: string;
}

const clients = new Map<string, Client>();
const FORWARDED_TYPES = new Set([
  'offer',
  'answer',
  'ice-candidate',
  'transfer-request',
  'transfer-response',
  'transfer-progress',
  'transfer-complete',
  'transfer-cancel',
  'transfer-error',
]);
const DELIVERY_ERROR_TYPES = new Set([
  'offer',
  'answer',
  'transfer-request',
  'transfer-response',
  'transfer-complete',
  'transfer-cancel',
  'transfer-error',
]);

const isValidDeviceId = (value: string | null) =>
  Boolean(value && /^[a-zA-Z0-9_-]{8,128}$/.test(value));

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 64 * 1024,
  });

  const broadcastClients = () => {
    const peers = Array.from(clients.values()).map(client => ({
      id: client.id,
      name: client.name,
      deviceType: client.deviceType,
    }));
    const message = JSON.stringify({ type: 'peers', peers });
    for (const client of clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
    }
  };

  const sendDeliveryError = (
    ws: AliveWebSocket,
    transferId: unknown,
    reason: string,
  ) => {
    if (ws.readyState !== WebSocket.OPEN || typeof transferId !== 'string') return;
    ws.send(JSON.stringify({ type: 'delivery-error', transferId, reason }));
  };

  wss.on('connection', (socket, request) => {
    const ws = socket as AliveWebSocket;
    ws.isAlive = true;

    const requestUrl = new URL(request.url || '/ws', `http://${request.headers.host || 'localhost'}`);
    const requestedId = requestUrl.searchParams.get('deviceId');
    const clientId = isValidDeviceId(requestedId) ? requestedId as string : uuidv4();
    const existing = clients.get(clientId);
    if (existing && existing.ws !== ws) existing.ws.terminate();

    const client: Client = {
      id: clientId,
      ws,
      name: `Device-${clientId.slice(0, 4)}`,
      deviceType: 'desktop',
    };
    clients.set(clientId, client);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.send(JSON.stringify({ type: 'welcome', id: clientId }));
    broadcastClients();

    ws.on('message', rawMessage => {
      try {
        const data = JSON.parse(rawMessage.toString()) as Record<string, unknown>;
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (data.type === 'update-info') {
          const current = clients.get(clientId);
          if (current?.ws === ws) {
            if (typeof data.name === 'string' && data.name.trim()) {
              current.name = data.name.trim().slice(0, 80);
            }
            if (data.deviceType === 'mobile' || data.deviceType === 'desktop') {
              current.deviceType = data.deviceType;
            }
            broadcastClients();
          }
          return;
        }

        if (typeof data.type !== 'string' || !FORWARDED_TYPES.has(data.type)) return;
        if (typeof data.target !== 'string') {
          sendDeliveryError(ws, data.transferId, 'Transfer target is invalid');
          return;
        }

        const targetClient = clients.get(data.target);
        if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) {
          if (DELIVERY_ERROR_TYPES.has(data.type)) {
            sendDeliveryError(ws, data.transferId, 'The target device is no longer connected');
          }
          return;
        }

        targetClient.ws.send(JSON.stringify({ ...data, from: clientId }));
      } catch (error) {
        console.error('Failed to process signaling message', error);
      }
    });

    ws.on('close', () => {
      if (clients.get(clientId)?.ws === ws) {
        clients.delete(clientId);
        broadcastClients();
      }
    });

    ws.on('error', error => {
      console.error(`WebSocket error for ${clientId}`, error);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.ws.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.ws.isAlive = false;
      client.ws.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', peers: clients.size });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

void startServer();
