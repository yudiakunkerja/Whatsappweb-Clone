// frontend/src/hooks/useWhatsApp.js
import { useState, useEffect, useCallback, useRef } from 'react';

export function useWhatsApp(backendUrl) {
  const [qrCode, setQrCode] = useState(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const wsRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT = 5;

  // Connect to WebSocket
  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = backendUrl.replace('http', 'ws')
      .replace('https', 'wss');
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('🔌 WebSocket connected');
      reconnectAttempts.current = 0;
      setError(null);
      // Request initial state
      fetchInitialState();
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerMessage(payload);
      } catch (err) {
        console.error('Parse error:', err);
      }
    };

    ws.onclose = () => {
      console.log('🔌 WebSocket closed');
      if (reconnectAttempts.current < MAX_RECONNECT) {
        reconnectAttempts.current++;
        setTimeout(connectWS, 2000 * reconnectAttempts.current);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setError('Koneksi server gagal');
    };
  }, [backendUrl]);

  // Handle messages from server
  const handleServerMessage = useCallback((payload) => {
    switch (payload.type) {
      case 'qr':
        setQrCode(payload.data);
        setConnected(false);
        break;
        
      case 'connected':
        setConnected(true);
        setQrCode(null);
        setError(null);
        break;
        
      case 'disconnected':
        setConnected(false);
        if (payload.data?.shouldReconnect === false) {
          setError('Sesi WhatsApp habis. Silakan scan QR ulang.');
        }
        break;
        
      case 'message:incoming':
        setMessages(prev => [...prev, {
          ...payload.data,
          fromMe: false,
          status: 'delivered'
        }]);
        break;
        
      case 'message:status':
        setMessages(prev => prev.map(msg => 
          msg.id === payload.data.id 
            ? { ...msg, status: payload.data.status }
            : msg
        ));
        break;
        
      case 'logged_out':
        setConnected(false);
        setQrCode(null);
        setMessages([]);
        break;
    }
  }, []);

  // Fetch initial state from REST API
  const fetchInitialState = async () => {
    try {
      const [qrRes, healthRes] = await Promise.all([
        fetch(`${backendUrl}/api/qr`),
        fetch(`${backendUrl}/api/health`)
      ]);
      
      const qrData = await qrRes.json();
      const healthData = await healthRes.json();
      
      if (qrData.qr) setQrCode(qrData.qr);
      setConnected(healthData.connected);
    } catch (err) {
      console.error('Fetch error:', err);
    }
  };

  // Send message
  const sendMessage = async (to, text) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${backendUrl}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text })
      });
      
      const result = await response.json();
      
      if (!response.ok) throw new Error(result.error);
      
      // Add to local messages immediately
      setMessages(prev => [...prev, {
        id: result.data?.key?.id || Date.now().toString(),
        from: to,
        text,
        timestamp: Date.now(),
        fromMe: true,
        status: 'sent'
      }]);
      
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Load contacts
  const loadContacts = async () => {
    try {
      const response = await fetch(`${backendUrl}/api/contacts`);
      const result = await response.json();
      if (result.success) {
        setContacts(result.data);
      }
    } catch (err) {
      console.error('Load contacts error:', err);
    }
  };

  // Logout
  const logout = async () => {
    try {
      await fetch(`${backendUrl}/api/logout`, { method: 'POST' });
      setConnected(false);
      setQrCode(null);
      setMessages([]);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  // Initialize
  useEffect(() => {
    connectWS();
    loadContacts();
    
    return () => {
      wsRef.current?.close();
    };
  }, [connectWS]);

  return {
    qrCode,
    connected,
    messages,
    contacts,
    loading,
    error,
    sendMessage,
    loadContacts,
    logout,
    reconnect: connectWS
  };
}
