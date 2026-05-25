// backend/src/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const WhatsAppService = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Store connected WebSocket clients
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('🔌 Client connected');

  ws.on('close', () => {
    clients.delete(ws);
    console.log('🔌 Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    clients.delete(ws);
  });
});

// Initialize WhatsApp service
const whatsapp = new WhatsAppService(wss);
whatsapp.initialize().catch(console.error);

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', connected: whatsapp.isConnected });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: whatsapp.qrCode, connected: whatsapp.isConnected });
});

app.post('/api/send', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      return res.status(400).json({ error: 'to and text are required' });
    }
    const result = await whatsapp.sendMessage(to, text);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await whatsapp.getContacts();
    res.json({ success: true, data: contacts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    await whatsapp.logout();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down...');
  await whatsapp.logout?.();
  server.close();
  process.exit(0);
});
