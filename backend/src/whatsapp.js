// backend/src/whatsapp.js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs').promises;
const path = require('path');
const qrcode = require('qrcode');

class WhatsAppService {
  constructor(wsServer) {
    this.wsServer = wsServer;
    this.sock = null;
    this.authState = null;
    this.isConnected = false;
    this.qrCode = null;
  }

  async initialize() {
    const { state, saveCreds } = await useMultiFileAuthState(
      path.join(__dirname, '../auth')
    );
    this.authState = { state, saveCreds };

    const { version } = await fetchLatestBaileysVersion();
    
    this.sock = makeWASocket({
      version,
      logger: undefined,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined),
      },
      getMessage: async (key) => {
        // Implement message store if needed
        return { conversation: 'hello' };
      },
    });

    this.setupEventHandlers();
    return this.sock;
  }

  setupEventHandlers() {
    this.sock.ev.on('creds.update', this.authState.saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code untuk scanning
      if (qr) {
        this.qrCode = await qrcode.toDataURL(qr);
        this.broadcast({ type: 'qr', data: this.qrCode });
      }

      // Koneksi terbuka
      if (connection === 'open') {
        this.isConnected = true;
        this.broadcast({ 
          type: 'connected', 
          data: { 
            user: this.sock.user,
            message: 'WhatsApp terhubung!' 
          } 
        });
      }

      // Koneksi tertutup
      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        this.broadcast({ 
          type: 'disconnected', 
          data: { 
            reason: lastDisconnect?.error?.message,
            shouldReconnect 
          } 
        });

        if (shouldReconnect) {
          setTimeout(() => this.initialize(), 3000);
        }
      }
    });

    // Pesan masuk
    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue; // Skip pesan dari diri sendiri
        
        const chatId = msg.key.remoteJid;
        const sender = jidNormalizedUser(msg.key.participant || chatId);
        const text = msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text ||
                    JSON.stringify(msg.message);

        this.broadcast({
          type: 'message:incoming',
          data: {
            id: msg.key.id,
            from: sender,
            chatId,
            text,
            timestamp: msg.messageTimestamp,
            isGroup: chatId.endsWith('@g.us'),
          }
        });
      }
    });

    // Status pesan (sent/delivered/read)
    this.sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        this.broadcast({
          type: 'message:status',
          data: {
            id: update.key.id,
            status: update.update.status,
          }
        });
      }
    });
  }

  // Broadcast ke semua client WebSocket
  broadcast(payload) {
    if (!this.wsServer) return;
    
    const message = JSON.stringify(payload);
    this.wsServer.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
  }

  // Kirim pesan
  async sendMessage(to, text) {
    if (!this.isConnected) {
      throw new Error('WhatsApp belum terhubung');
    }
    const result = await this.sock.sendMessage(to, { text });
    return result;
  }

  // Logout & hapus session
  async logout() {
    await this.sock?.logout();
    await fs.rm(path.join(__dirname, '../auth'), { recursive: true, force: true });
    this.isConnected = false;
    this.broadcast({ type: 'logged_out' });
  }

  // Get contacts
  async getContacts() {
    const chats = await this.sock?.chatAll();
    return chats?.map(chat => ({
      id: chat.id,
      name: chat.name || jidNormalizedUser(chat.id),
      unreadCount: chat.unreadCount,
    })) || [];
  }
}

module.exports = WhatsAppService;
