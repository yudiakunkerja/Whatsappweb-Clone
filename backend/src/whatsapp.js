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
    this.logger = pino({ 
      level: process.env.LOG_LEVEL || 'debug',
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: { colorize: true }
      }
    });
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 15; // Tingkatkan max retry
    this.lastValidationError = null;
    this.validationErrorCount = 0;
  }

  async initialize() {
    try {
      const authPath = path.join(__dirname, '../auth');
      await fs.mkdir(authPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authPath);
      this.authState = { state, saveCreds };

      const { version } = await fetchLatestBaileysVersion();
      
      this.logger.info('🔧 Initializing Baileys v' + version.join('.'));
      
      this.sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        browser: Browsers.appropriate('Desktop'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        // ⚙️ Konfigurasi untuk cloud environment
        connectTimeoutMs: 90000,
        keepAliveIntervalMs: 45000,
        defaultQueryTimeoutMs: 45000,
        syncFullHistory: false,
        patchMessageBeforeSending: (msg) => msg,
        getMessage: async (key) => ({ conversation: '' }),
        ephemeralExpiration: WA_DEFAULT_EPHEMERAL,
        // 🔄 Tambahkan retry config
        retryRequestDelayMs: 3000,
        maxMsgRetryCount: 5,
      });

      this.setupEventHandlers();
      this.logger.info('📱 WhatsApp service initialized');
      return this.sock;
    } catch (error) {
      this.logger.error('❌ Init failed:', {
        message: error.message,
        name: error.name,
        stack: error.stack?.split('\n')[0]
      });
      throw error;
    }
  }

  setupEventHandlers() {
    this.sock.ev.on('creds.update', async () => {
      await this.authState.saveCreds();
      this.logger.debug('🔐 Creds updated');
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

      if (qr) {
        try {
          this.qrCode = await qrcode.toDataURL(qr);
          this.broadcast({ type: 'qr', data: this.qrCode });
          this.logger.info('📱 QR Code generated');
          this.reconnectAttempts = 0;
          this.validationErrorCount = 0;
        } catch (error) {
          this.logger.error('❌ QR generation failed:', error);
        }
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.user = this.sock.user;
        this.qrCode = null;
        this.reconnectAttempts = 0;
        this.validationErrorCount = 0;
        
        this.broadcast({ 
          type: 'connected', 
          data: { 
            user: { id: this.user?.id, name: this.user?.name || this.user?.pushName },
            message: 'WhatsApp berhasil terhubung!' 
          } 
        });
        this.logger.info('✅ Connected:', this.user?.id);
      }

      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || '';
        
        // 🔍 Deteksi "validation error" khusus
        const isValidationError = 
          errorMsg.toLowerCase().includes('validat') || 
          errorMsg.toLowerCase().includes('auth_fail') ||
          statusCode === 401 || statusCode === 403;

        if (isValidationError) {
          this.validationErrorCount++;
          this.lastValidationError = errorMsg;
          this.logger.warn(`⚠️ Validation error #${this.validationErrorCount}:`, errorMsg);
        }

        const shouldReconnect = this.shouldReconnect(statusCode, isValidationError);
        
        this.logger.warn('❌ Disconnected:', {
          reason: errorMsg,
          statusCode,
          shouldReconnect,
          attempts: this.reconnectAttempts,
          validationErrors: this.validationErrorCount
        });

        this.broadcast({ 
          type: 'disconnected', 
          data: { reason: errorMsg, shouldReconnect, statusCode } 
        });

        if (shouldReconnect) {
          this.reconnectAttempts++;
          // Exponential backoff + extra delay untuk validation error
          const baseDelay = isValidationError ? 5000 : 1000;
          const delay = Math.min(baseDelay * Math.pow(1.5, this.reconnectAttempts), 30000);
          
          this.logger.info(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          setTimeout(() => this.initialize(), delay);
        } else {
          this.logger.info('🚫 Stopping reconnect - clearing auth');
          await this.clearAuth();
          this.broadcast({ type: 'logged_out' });
          this.reconnectAttempts = 0;
          this.validationErrorCount = 0;
        }
      }

      if (receivedPendingNotifications) {
        this.logger.info('📨 Received pending notifications');
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const chatId = msg.key.remoteJid;
        const sender = jidNormalizedUser(msg.key.participant || chatId);
        
        let text = '';
        if (msg.message?.conversation) text = msg.message.conversation;
        else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
        else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;
        else if (msg.message?.videoMessage?.caption) text = msg.message.videoMessage.caption;

        if (!text) continue;

        this.broadcast({
          type: 'message:incoming',
          data: {
            id: msg.key.id, from: sender, chatId, text,
            timestamp: msg.messageTimestamp,
            isGroup: chatId.endsWith('@g.us'),
            pushName: msg.pushName,
          }
        });
        this.logger.info('📨 Message:', { from: sender, text: text.substring(0, 50) });
      }
    });

    this.sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        this.broadcast({
          type: 'message:status',
          data: { id: update.key.id, status: update.update.status }
        });
      }
    });

    this.sock.ev.on('chats.update', async (chats) => {
      this.broadcast({ type: 'chats:update', data: chats });
    });
  }

  // 🔍 LOGIKA RECONNECT YANG DIPERBAIKI
  shouldReconnect(statusCode, isValidationError) {
    // Jangan reconnect jika:
    if (statusCode === DisconnectReason.loggedOut) return false;
    if (statusCode === DisconnectReason.badSession) return false;
    if (statusCode === DisconnectReason.connectionReplaced) return false;
    
    // ✅ Khusus validation error: izinkan retry lebih banyak
    if (isValidationError) {
      // Izinkan sampai 5x validation error sebelum stop
      return this.validationErrorCount < 5;
    }
    
    // Default reconnect rules
    if (statusCode === DisconnectReason.connectionClosed) return true;
    if (statusCode === DisconnectReason.connectionLost) return true;
    if (statusCode === DisconnectReason.restartRequired) return true;
    if (statusCode === DisconnectReason.timedOut) return true;
    
    // Fallback: reconnect jika belum max attempts
    return this.reconnectAttempts < this.maxReconnectAttempts;
  }

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
          this.logger.error('❌ Broadcast failed:', err);
        }
      }
    });
    if (clientCount > 0) {
      this.logger.debug(`📡 Broadcast to ${clientCount} clients: ${payload.type}`);
    }
  }

  async sendMessage(to, text) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp belum terhubung. Silakan scan QR code.');
    }
    try {
      const result = await this.sock.sendMessage(to, { text });
      this.logger.info('✅ Sent:', { to, id: result?.key?.id });
      return result;
    } catch (error) {
      this.logger.error('❌ Send failed:', { message: error.message, to });
      throw error;
    }
  }

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
      this.logger.error('❌ Get chats failed:', error);
      return [];
    }
  }

  async logout() {
    try {
      if (this.sock) await this.sock.logout();
      await this.clearAuth();
      this.isConnected = false;
      this.user = null;
      this.qrCode = null;
      this.reconnectAttempts = 0;
      this.validationErrorCount = 0;
      this.broadcast({ type: 'logged_out' });
      this.logger.info('🚪 Logged out');
    } catch (error) {
      this.logger.error('❌ Logout error:', error);
      throw error;
    }
  }

  async clearAuth() {
    try {
      const authPath = path.join(__dirname, '../auth');
      await fs.rm(authPath, { recursive: true, force: true });
      this.logger.info('🗑️ Auth cleared');
    } catch (error) {
      this.logger.error('❌ Clear auth failed:', error);
    }
  }

  getStatus() {
    return {
      connected: this.isConnected,
      user: this.user,
      hasQR: !!this.qrCode,
      reconnectAttempts: this.reconnectAttempts,
      validationErrorCount: this.validationErrorCount
    };
  }
}

module.exports = WhatsAppService;
