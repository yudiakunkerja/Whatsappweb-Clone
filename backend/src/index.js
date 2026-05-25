require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const WhatsAppService = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws'
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Store connected WebSocket clients
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`🔌 Client connected. Total clients: ${clients.size}`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🔌 Client disconnected. Total clients: ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    clients.delete(ws);
  });

  // Handle client messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📥 Client message:', data.type);
      
      // Handle client requests if needed
      ws.send(JSON.stringify({ type: 'ack', data: 'received' }));
    } catch (error) {
      console.error('Failed to parse client message:', error);
    }
  });
});

// Initialize WhatsApp service
let whatsappService;

const initializeWhatsApp = async () => {
  try {
    whatsappService = new WhatsAppService(wss);
    await whatsappService.initialize();
    console.log('✅ WhatsApp service initialized');
  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp:', error);
    setTimeout(initializeWhatsApp, 5000);
  }
};

// Start WhatsApp initialization
initializeWhatsApp();

// ============ API ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  const status = whatsappService?.getStatus() || { connected: false };
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    ...status 
  });
});

// Get QR code
app.get('/api/qr', (req, res) => {
  const status = whatsappService?.getStatus() || {};
  res.json({ 
    qr: status.hasQR ? whatsappService.qrCode : null, 
    connected: status.connected 
  });
});

// Send message
app.post('/api/send', async (req, res) => {
  try {
    const { to, text } = req.body;
    
    if (!to || !text) {
      return res.status(400).json({ 
        error: 'Field "to" dan "text" wajib diisi' 
      });
    }

    if (!whatsappService) {
      return res.status(503).json({ 
        error: 'WhatsApp service belum siap' 
      });
    }

    const result = await whatsappService.sendMessage(to, text);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      error: error.message || 'Gagal mengirim pesan' 
    });
  }
});

// Get chats/contacts
app.get('/api/chats', async (req, res) => {
  try {
    if (!whatsappService) {
      return res.status(503).json({ error: 'Service belum siap' });
    }

    const chats = await whatsappService.getChats();
    res.json({ success: true, data: chats });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/api/logout', async (req, res) => {
  try {
    if (!whatsappService) {
      return res.status(503).json({ error: 'Service belum siap' });
    }

    await whatsappService.logout();
    res.json({ success: true, message: 'Berhasil logout' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get connection status
app.get('/api/status', (req, res) => {
  const status = whatsappService?.getStatus() || { 
    connected: false,
    user: null,
    hasQR: false
  };
  res.json({ success: true, data: status });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║  🚀 WhatsApp Backend Server            ║
║  ────────────────────────────────────  ║
║  Port: ${PORT}
║  URL: http://localhost:${PORT}
║  WebSocket: ws://localhost:${PORT}/ws
║  Environment: ${process.env.NODE_ENV || 'development'}
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received. Shutting down gracefully...');
  
  // Close WebSocket server
  wss.clients.forEach(client => client.close());
  wss.close();
  
  // Logout WhatsApp
  await whatsappService?.logout();
  
  // Close HTTP server
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received');
  process.exit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
