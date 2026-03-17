import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { v4 as uuidv4 } from "uuid";

interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  deviceType: string;
}

const clients = new Map<string, Client>();

async function startServer() {
  const app = express();
  const PORT = 3000;

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Broadcast updated client list to everyone
  const broadcastClients = () => {
    const clientList = Array.from(clients.values()).map(c => ({
      id: c.id,
      name: c.name,
      deviceType: c.deviceType
    }));
    
    const message = JSON.stringify({ type: 'peers', peers: clientList });
    for (const client of clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  };

  wss.on('connection', (ws) => {
    const clientId = uuidv4();
    let clientName = `Device-${clientId.substring(0, 4)}`;
    let clientDeviceType = 'desktop';

    clients.set(clientId, { id: clientId, ws, name: clientName, deviceType: clientDeviceType });

    // Send the client its own ID
    ws.send(JSON.stringify({ type: 'welcome', id: clientId }));
    
    // Broadcast new list
    broadcastClients();

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === 'update-info') {
          const client = clients.get(clientId);
          if (client) {
            client.name = data.name || client.name;
            client.deviceType = data.deviceType || client.deviceType;
            broadcastClients();
          }
        } else if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
          // Forward signaling messages to the target peer
          const targetClient = clients.get(data.target);
          if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
            targetClient.ws.send(JSON.stringify({
              ...data,
              from: clientId
            }));
          }
        } else if (data.type === 'transfer-request' || data.type === 'transfer-response' || data.type === 'transfer-progress' || data.type === 'transfer-complete' || data.type === 'transfer-cancel') {
          // Forward transfer control messages
          const targetClient = clients.get(data.target);
          if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
            targetClient.ws.send(JSON.stringify({
              ...data,
              from: clientId
            }));
          }
        }
      } catch (e) {
        console.error('Failed to parse message', e);
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      broadcastClients();
    });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
