const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers,
  WA_DEFAULT_EPHEMERAL
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
    // 🔍 Ubah ke 'debug' sementara untuk lihat error asli dari Baileys
    this.logger = pino({ 
      level: process.env.LOG_LEVEL || 'debug',
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: { colorize: true }
      }
    });
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  async initialize() {
    try {
      const authPath = path.join(__dirname, '../auth');
      await fs.mkdir(authPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authPath);
      this.authState = { state, saveCreds };

      const { version } = await fetchLatestBaileysVersion();
      
      this.logger.info('🔧 Initializing Baileys with version:', version);
      
      // ⚙️ KONFIGURASI KHUSUS UNTUK CLOUD/RAILWAY
      this.sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        browser: Browsers.appropriate('Desktop'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        // 🌐 Konfigurasi WebSocket untuk bypass proxy Railway
        waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 30000,
        // ⚡ Optimasi untuk cloud
        syncFullHistory: false,
        patchMessageBeforeSending: (msg) => msg,
        // 📦 Message handler
        getMessage: async (key) => {
          return { conversation: '' };
        },
        // 🔐 Optional: ephemeral messages
        ephemeralExpiration: WA_DEFAULT_EPHEMERAL,
      });

      this.setupEventHandlers();
      this.logger.info('📱 WhatsApp service initialized successfully');
      
      return this.sock;
    } catch (error) {
      this.logger.error('❌ Failed to initialize WhatsApp:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      throw error;
    }
  }

  setupEventHandlers() {
    // Handle credentials update
    this.sock.ev.on('creds.update', async () => {
      await this.authState.saveCreds();
      this.logger.debug('🔐 Credentials updated');
    });

    // Handle connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

      this.logger.debug('🔗 Connection update:', { 
        connection, 
        qr: !!qr,
        receivedPendingNotifications 
      });

      // QR Code received
      if (qr) {
        try {
          this.qrCode = await qrcode.toDataURL(qr);
          this.broadcast({ type: 'qr', data: this.qrCode });
          this.logger.info('📱 QR Code generated and sent to client');
          this.reconnectAttempts = 0; // Reset reconnect counter on new QR
        } catch (error) {
          this.logger.error('❌ QR Code generation failed:', error);
        }
      }

      // Connection opened
      if (connection === 'open') {
        this.isConnected = true;
        this.user = this.sock.user;
        this.qrCode = null;
        this.reconnectAttempts = 0;
        
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
        const shouldReconnect = this.shouldReconnect(statusCode);
        
        this.logger.warn('❌ WhatsApp disconnected:', {
          reason: lastDisconnect?.error?.message,
          statusCode,
          shouldReconnect,
          attempts: this.reconnectAttempts
        });

        this.broadcast({ 
          type: 'disconnected', 
          data: { 
            reason: lastDisconnect?.error?.message,
            shouldReconnect,
            statusCode
          } 
        });

        if (shouldReconnect) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * this.reconnectAttempts, 10000);
          this.logger.info(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          setTimeout(() => this.initialize(), delay);
        } else {
          this.logger.info('🚫 Not reconnecting - clearing auth data');
          await this.clearAuth();
          this.broadcast({ type: 'logged_out' });
        }
      }

      // Handle pending notifications
      if (receivedPendingNotifications) {
        this.logger.info('📨 Received pending notifications');
      }
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;
        const sender = jidNormalizedUser(msg.key.participant || chatId);
        
        let text = '';
        if (msg.message?.conversation) {
          text = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          text = msg.message.extendedTextMessage.text;
        } else if (msg.message?.imageMessage?.caption) {
          text = msg.message.imageMessage.caption;
        } else if (msg.message?.videoMessage?.caption) {
          text = msg.message.videoMessage.caption;
        } else if (msg.message?.documentMessage?.caption) {
          text = msg.message.documentMessage.caption;
        }

        if (!text) {
          this.logger.debug('⚠️ Message with no text received, skipping');
          continue;
        }

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

        this.logger.info('📨 New message:', { from: sender, text: text.substring(0, 50) + '...' });
      }
    });

    // Handle message status updates
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

    // Handle chat updates
    this.sock.ev.on('chats.update', async (chats) => {
      this.broadcast({
        type: 'chats:update',
        data: chats
      });
    });

    // Handle connection reset / validation errors
    this.sock.ev.on('connection.reset', async () => {
      this.logger.warn('🔄 Connection reset by server');
    });

    this.sock.ev.on('messages.reaction', async (reactions) => {
      this.logger.debug('⚡ Message reaction:', reactions);
    });
  }

  // 🔍 Helper: Tentukan apakah harus reconnect berdasarkan status code
  shouldReconnect(statusCode) {
    // Jangan reconnect jika:
    if (statusCode === DisconnectReason.loggedOut) return false;
    if (statusCode === DisconnectReason.badSession) return false;
    if (statusCode === DisconnectReason.connectionClosed) return true;
    if (statusCode === DisconnectReason.connectionLost) return true;
    if (statusCode === DisconnectReason.connectionReplaced) return false;
    if (statusCode === DisconnectReason.restartRequired) return true;
    if (statusCode === DisconnectReason.timedOut) return true;
    
    // Default: reconnect jika belum mencapai max attempts
    return this.reconnectAttempts < this.maxReconnectAttempts;
  }

  // Broadcast to all WebSocket clients
  broadcast(payload) {
    if (!this.wsServer) return;
    
    const message = JSON.stringify(payload);
    let clientCount = 0;
    
    this.wsServer.clients.forEach(client => {
      if (client.readyState === 1) {
        try {
          client.send(message);
          clientCount++;
        } catch (err) {
          this.logger.error('❌ Failed to send to client:', err);
        }
      }
    });

    if (clientCount > 0) {
      this.logger.debug(`📡 Broadcast to ${clientCount} clients:`, payload.type);
    }
  }

  // Send message
  async sendMessage(to, text) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp belum terhubung. Silakan scan QR code.');
    }

    try {
      const result = await this.sock.sendMessage(to, { text });
      this.logger.info('✅ Message sent:', { to, id: result?.key?.id });
      return result;
    } catch (error) {
      this.logger.error('❌ Failed to send message:', {
        message: error.message,
        to
      });
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
      this.logger.error('❌ Failed to get chats:', error);
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
      this.reconnectAttempts = 0;
      
      this.broadcast({ type: 'logged_out' });
      this.logger.info('🚪 User logged out successfully');
    } catch (error) {
      this.logger.error('❌ Logout error:', error);
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
      this.logger.error('❌ Failed to clear auth:', error);
    }
  }

  // Get connection status
  getStatus() {
    return {
      connected: this.isConnected,
      user: this.user,
      hasQR: !!this.qrCode,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

module.exports = WhatsAppService;
