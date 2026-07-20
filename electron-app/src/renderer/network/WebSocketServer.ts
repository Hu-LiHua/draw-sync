import { WebSocketServer as WsServer, WebSocket } from 'ws';
import { WsMessage } from '../data/protocol';

type MessageHandler = (msg: WsMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

export class DrawSyncServer {
  private wss: WsServer | null = null;
  private client: WebSocket | null = null;
  private onMessage: MessageHandler;
  private onConnectionChange: ConnectionHandler;

  constructor(onMessage: MessageHandler, onConnectionChange: ConnectionHandler) {
    this.onMessage = onMessage;
    this.onConnectionChange = onConnectionChange;
  }

  start(port = 8080): void {
    this.wss = new WsServer({ port });
    this.wss.on('connection', (ws) => {
      this.client = ws;
      this.onConnectionChange(true);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsMessage;
          this.onMessage(msg);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      });

      ws.on('close', () => {
        this.client = null;
        this.onConnectionChange(false);
      });

      ws.on('error', () => {
        this.client = null;
        this.onConnectionChange(false);
      });
    });
    console.log(`WebSocket server started on port ${port}`);
  }

  stop(): void {
    if (this.client) { this.client.close(); this.client = null; }
    if (this.wss) { this.wss.close(); this.wss = null; }
    this.onConnectionChange(false);
  }

  getPort(): number { return this.wss?.options?.port ?? 8080; }
}
