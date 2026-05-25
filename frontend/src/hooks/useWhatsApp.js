import { useState, useEffect, useCallback, useRef } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export function useWhatsApp() {
  const [qrCode, setQrCode] = useState(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [user, setUser] = useState(null);
  
  const wsRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT = 10;
  const messageIdsSent = useRef(new Set());

  // Connect to WebSocket
  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('✅ WebSocket already connected');
      return;
    }

    const wsUrl = BACKEND_URL.replace('http', 'ws')
      .replace('https', 'wss') + '/ws';
    
    console.log('🔌 Connecting to WebSocket:', wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket connected');
      reconnectAttempts.current = 0;
      setError(null);
      fetchInitialState();
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        console.log('📥 WS Message:', payload.type);
        handleServerMessage(payload);
      } catch (err) {
        console.error('❌ Parse error:', err);
      }
    };

    ws.onclose = () => {
      console.log('🔌 WebSocket closed');
      if (reconnectAttempts.current < MAX_RECONNECT) {
        reconnectAttempts.current++;
        const delay = Math.min(1000 * reconnectAttempts.current, 5000);
        console.log(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
        setTimeout(connectWS, delay);
      } else {
        setError('Koneksi server gagal. Silakan refresh halaman.');
      }
    };

    ws.onerror = (err) => {
      console.error('❌ WebSocket error:', err);
      setError('Koneksi ke server gagal');
    };
  }, []);

  // Handle messages from server
  const handleServerMessage = useCallback((payload) => {
    switch (payload.type) {
      case 'qr':
        setQrCode(payload.data);
        setConnected(false);
        setUser(null);
        setError(null);
        break;
        
      case 'connected':
        setConnected(true);
        setQrCode(null);
        setUser(payload.data.user);
        setError(null);
        loadContacts();
        break;
        
      case 'disconnected':
        setConnected(false);
        if (payload.data?.shouldReconnect === false) {
          setError('Sesi WhatsApp habis. Silakan scan QR ulang.');
          setQrCode(null);
          setUser(null);
        }
        break;
        
      case 'message:incoming':
        // Prevent duplicates
        if (messageIdsSent.current.has(payload.data.id)) {
          console.log('⚠️ Duplicate message ignored:', payload.data.id);
          return;
        }
        
        messageIdsSent.current.add(payload.data.id);
        setMessages(prev => {
          // Keep only last 100 messages
          const newMessages = [...prev, {
            ...payload.data,
            fromMe: false,
            status: 'delivered'
          }];
          return newMessages.slice(-100);
        });
        break;
        
      case 'message:status':
        setMessages(prev => prev.map(msg => 
          msg.id === payload.data.id 
            ? { ...msg, status: getStatusText(payload.data.status) }
            : msg
        ));
        break;
        
      case 'logged_out':
        setConnected(false);
        setQrCode(null);
        setMessages([]);
        setContacts([]);
        setUser(null);
        break;
        
      default:
        console.log('📨 Unknown message type:', payload.type);
    }
  }, []);

  const getStatusText = (status) => {
    switch(status) {
      case 1: return 'sent';
      case 2: return 'delivered';
      case 3: return 'read';
      default: return 'sent';
    }
  };

  // Fetch initial state from REST API
  const fetchInitialState = async () => {
    try {
      console.log('🔄 Fetching initial state...');
      const [statusRes, qrRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/status`),
        fetch(`${BACKEND_URL}/api/qr`)
      ]);
      
      const statusData = await statusRes.json();
      const qrData = await qrRes.json();
      
      console.log('📊 Status:', statusData);
      console.log('📊 QR:', qrData);
      
      if (statusData.success) {
        setConnected(statusData.data.connected);
        setUser(statusData.data.user);
        if (statusData.data.connected) {
          setQrCode(null);
          loadContacts();
        }
      }
      
      if (qrData.qr && !qrData.connected) {
        setQrCode(qrData.qr);
      }
    } catch (err) {
      console.error('❌ Fetch error:', err);
      setError('Gagal menghubungkan ke server');
    }
  };

  // Send message
  const sendMessage = async (to, text) => {
    if (!text.trim()) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${BACKEND_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text })
      });
      
      const result = await response.json();
      
      if (!response.ok) throw new Error(result.error);
      
      // Add to local messages immediately
      const tempId = `temp_${Date.now()}`;
      setMessages(prev => [...prev, {
        id: tempId,
        from: to,
        text,
        timestamp: Date.now(),
        fromMe: true,
        status: 'sending'
      }]);
      
      console.log('✅ Message sent:', result);
      return result;
    } catch (err) {
      console.error('❌ Send error:', err);
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Load contacts
  const loadContacts = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/chats`);
      const result = await response.json();
      if (result.success) {
        setContacts(result.data);
        console.log('📇 Contacts loaded:', result.data.length);
      }
    } catch (err) {
      console.error('❌ Load contacts error:', err);
    }
  };

  // Logout
  const logout = async () => {
    try {
      await fetch(`${BACKEND_URL}/api/logout`, { method: 'POST' });
      setConnected(false);
      setQrCode(null);
      setMessages([]);
      setContacts([]);
      setUser(null);
    } catch (err) {
      console.error('❌ Logout error:', err);
    }
  };

  // Initialize
  useEffect(() => {
    console.log('🚀 useWhatsApp initialized');
    connectWS();
    
    return () => {
      console.log('🧹 Cleaning up WebSocket');
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectWS]);

  return {
    qrCode,
    connected,
    messages,
    contacts,
    loading,
    error,
    user,
    sendMessage,
    loadContacts,
    logout,
    reconnect: connectWS,
    backendUrl: BACKEND_URL
  };
}
