// frontend/src/App.jsx
import { useState } from 'react';
import { useWhatsApp } from './hooks/useWhatsApp';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

function App() {
  const {
    qrCode,
    connected,
    messages,
    contacts,
    loading,
    error,
    sendMessage,
    logout
  } = useWhatsApp(BACKEND_URL);

  const [selectedChat, setSelectedChat] = useState(null);
  const [messageText, setMessageText] = useState('');

  const handleSend = async (e) => {
    e.preventDefault();
    if (!messageText.trim() || !selectedChat) return;
    
    try {
      await sendMessage(selectedChat, messageText);
      setMessageText('');
    } catch (err) {
      // Error already handled in hook
    }
  };

  // Loading state
  if (!qrCode && !connected) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Menghubungkan ke WhatsApp...</p>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Sidebar - Contacts */}
      <aside className="sidebar">
        <div className="header">
          <h2>WhatsApp Web Clone</h2>
          {connected && (
            <button onClick={logout} className="logout-btn">
              Logout
            </button>
          )}
        </div>
        
        <div className="contacts-list">
          {contacts.map(contact => (
            <div
              key={contact.id}
              className={`contact-item ${selectedChat === contact.id ? 'active' : ''}`}
              onClick={() => setSelectedChat(contact.id)}
            >
              <div className="avatar">{contact.name?.[0]?.toUpperCase() || '?'}</div>
              <div className="contact-info">
                <span className="name">{contact.name || contact.id}</span>
                {contact.unreadCount > 0 && (
                  <span className="badge">{contact.unreadCount}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-area">
        {!connected ? (
          // QR Code Screen
          <div className="qr-container">
            <h3>Scan QR Code untuk menghubungkan WhatsApp</h3>
            {qrCode ? (
              <img src={qrCode} alt="QR Code" className="qr-code" />
            ) : (
              <div className="qr-loading">Memuat QR Code...</div>
            )}
            <p className="hint">
              Buka WhatsApp di HP → Settings → Linked Devices → Link a Device
            </p>
          </div>
        ) : !selectedChat ? (
          // Empty State
          <div className="empty-state">
            <p>👈 Pilih kontak untuk mulai chat</p>
          </div>
        ) : (
          // Chat Window
          <>
            <div className="chat-header">
              <h3>{contacts.find(c => c.id === selectedChat)?.name || selectedChat}</h3>
            </div>
            
            <div className="messages-container">
              {messages
                .filter(m => m.from === selectedChat || m.fromMe)
                .map(msg => (
                  <div
                    key={msg.id}
                    className={`message ${msg.fromMe ? 'sent' : 'received'}`}
                  >
                    <div className="bubble">{msg.text}</div>
                    <span className="status">
                      {msg.fromMe && (
                        msg.status === 'sent' ? '✓' :
                        msg.status === 'delivered' ? '✓✓' :
                        msg.status === 'read' ? '✓✓✓' : ''
                      )}
                    </span>
                  </div>
                ))}
            </div>
            
            <form onSubmit={handleSend} className="message-form">
              <input
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Ketik pesan..."
                disabled={loading}
              />
              <button type="submit" disabled={loading || !messageText.trim()}>
                {loading ? '⏳' : '➤'}
              </button>
            </form>
          </>
        )}
        
        {error && <div className="error-toast">{error}</div>}
      </main>
    </div>
  );
}

export default App;
