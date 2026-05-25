const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs').promises;
const path = require('path');
const qrcode = require('qrcode');
const pino = require('pino');

class WhatsAppService {
  constructor(wsServer) {
    this.wsServer = wsServer;
    this.sock = null;
    this.authState = null;
    this.isConnected = false;
    this.qrCode = null;
    this.user = null;
    this.logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  }

  async initialize() {
    try {
      const authPath = path.join(__dirname, '../auth');
      
      // Ensure auth directory exists
      await fs.mkdir(authPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authPath);
      this.authState = { state, saveCreds };

      const { version } = await fetchLatestBaileysVersion();
      
      this.sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        browser: Browsers.appropriate('Desktop'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        getMessage: async (key) => {
          // You can implement message store here
          return { conversation: 'hello' };
        },
      });

      this.setupEventHandlers();
      this.logger.info('📱 WhatsApp service initialized');
      
      return this.sock;
    } catch (error) {
      this.logger.error('Failed to initialize WhatsApp:', error);
      throw error;
    }
  }

  setupEventHandlers() {
    // Handle credentials update
    this.sock.ev.on('creds.update', this.authState.saveCreds);

    // Handle connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code received
      if (qr) {
        try {
          this.qrCode = await qrcode.toDataURL(qr);
          this.broadcast({ type: 'qr', data: this.qrCode });
          this.logger.info('📱 QR Code generated');
        } catch (error) {
          this.logger.error('QR Code generation failed:', error);
        }
      }

      // Connection opened
      if (connection === 'open') {
        this.isConnected = true;
        this.user = this.sock.user;
        this.qrCode = null;
        
        this.broadcast({ 
          type: 'connected', 
          data: { 
            user: {
              id: this.user?.id,
              name: this.user?.name || this.user?.pushName
            },
            message: 'WhatsApp berhasil terhubung!' 
          } 
        });
        
        this.logger.info('✅ WhatsApp connected:', this.user);
      }

      // Connection closed
      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        this.broadcast({ 
          type: 'disconnected', 
          data: { 
            reason: lastDisconnect?.error?.message,
            shouldReconnect,
            statusCode
          } 
        });

        this.logger.warn('❌ WhatsApp disconnected:', {
          reason: lastDisconnect?.error?.message,
          shouldReconnect,
          statusCode
        });

        if (shouldReconnect) {
          this.logger.info('🔄 Reconnecting in 3 seconds...');
          setTimeout(() => this.initialize(), 3000);
        } else {
          // Clear auth data on logout
          await this.clearAuth();
        }
      }
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue; // Skip messages from self

        const chatId = msg.key.remoteJid;
        const sender = jidNormalizedUser(msg.key.participant || chatId);
        
        // Extract message text
        let text = '';
        if (msg.message?.conversation) {
          text = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          text = msg.message.extendedTextMessage.text;
        } else if (msg.message?.imageMessage?.caption) {
          text = msg.message.imageMessage.caption;
        } else if (msg.message?.videoMessage?.caption) {
          text = msg.message.videoMessage.caption;
        }

        if (!text) continue;

        this.broadcast({
          type: 'message:incoming',
          data: {
            id: msg.key.id,
            from: sender,
            chatId,
            text,
            timestamp: msg.messageTimestamp,
            isGroup: chatId.endsWith('@g.us'),
            pushName: msg.pushName,
          }
        });

        this.logger.info('📨 New message:', { from: sender, text });
      }
    });

    // Handle message status updates (sent, delivered, read)
    this.sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        this.broadcast({
          type: 'message:status',
          data: {
            id: update.key.id,
            status: update.update.status,
            timestamp: update.update.messageTimestamp,
          }
        });
      }
    });

    // Handle chat updates (unread count, etc)
    this.sock.ev.on('chats.update', async (chats) => {
      this.broadcast({
        type: 'chats:update',
        data: chats
      });
    });
  }

  // Broadcast to all WebSocket clients
  broadcast(payload) {
    if (!this.wsServer) return;
    
    const message = JSON.stringify(payload);
    let clientCount = 0;
    
    this.wsServer.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
        clientCount++;
      }
    });

    if (clientCount > 0) {
      this.logger.debug(`📡 Broadcast to ${clientCount} clients:`, payload.type);
    }
  }

  // Send message
  async sendMessage(to, text) {
    if (!this.isConnected) {
      throw new Error('WhatsApp belum terhubung. Silakan scan QR code.');
    }

    try {
      const result = await this.sock.sendMessage(to, { text });
      this.logger.info('✅ Message sent:', { to, id: result.key.id });
      return result;
    } catch (error) {
      this.logger.error('Failed to send message:', error);
      throw error;
    }
  }

  // Get all chats/contacts
  async getChats() {
    if (!this.sock) return [];
    
    try {
      const chats = await this.sock.chatAll();
      return chats.map(chat => ({
        id: chat.id,
        name: chat.name || jidNormalizedUser(chat.id),
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.conversationTimestamp,
      }));
    } catch (error) {
      this.logger.error('Failed to get chats:', error);
      return [];
    }
  }

  // Logout and clear session
  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
      await this.clearAuth();
      this.isConnected = false;
      this.user = null;
      this.qrCode = null;
      
      this.broadcast({ type: 'logged_out' });
      this.logger.info('🚪 User logged out');
    } catch (error) {
      this.logger.error('Logout error:', error);
      throw error;
    }
  }

  // Clear authentication data
  async clearAuth() {
    try {
      const authPath = path.join(__dirname, '../auth');
      await fs.rm(authPath, { recursive: true, force: true });
      this.logger.info('🗑️ Auth data cleared');
    } catch (error) {
      this.logger.error('Failed to clear auth:', error);
    }
  }

  // Get connection status
  getStatus() {
    return {
      connected: this.isConnected,
      user: this.user,
      hasQR: !!this.qrCode
    };
  }
}

module.exports = WhatsAppService;
