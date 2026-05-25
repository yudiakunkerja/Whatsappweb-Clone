import { useState } from 'react';
import { useWhatsApp } from './hooks/useWhatsApp';

function App() {
  const {
    qrCode,
    connected,
    messages,
    contacts,
    loading,
    error,
    user,
    sendMessage,
    logout
  } = useWhatsApp();

  const [selectedChat, setSelectedChat] = useState(null);
  const [messageText, setMessageText] = useState('');

  const handleSend = async (e) => {
    e.preventDefault();
    if (!messageText.trim() || !selectedChat) return;
    
    try {
      await sendMessage(selectedChat, messageText);
      setMessageText('');
    } catch (err) {
      console.error('Failed to send:', err);
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('id-ID', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  // Loading state
  if (!qrCode && !connected && contacts.length === 0) {
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
          <h2>
            <i className="fab fa-whatsapp" style={{color: '#25D366', marginRight: '8px'}}></i>
            WhatsApp Web
          </h2>
          {connected && user && (
            <button onClick={logout} className="logout-btn">
              Logout
            </button>
          )}
        </div>
        
        <div className="contacts-list">
          {contacts.length === 0 ? (
            <div style={{padding: '20px', textAlign: 'center', color: '#667781'}}>
              {connected ? 'Tidak ada chat' : 'Menunggu koneksi...'}
            </div>
          ) : (
            contacts.map(contact => (
              <div
                key={contact.id}
                className={`contact-item ${selectedChat === contact.id ? 'active' : ''}`}
                onClick={() => setSelectedChat(contact.id)}
              >
                <div className="avatar">
                  {contact.name?.[0]?.toUpperCase() || contact.id.split('@')[0][0]}
                </div>
                <div className="contact-info">
                  <span className="name">
                    {contact.name || contact.id.split('@')[0]}
                  </span>
                </div>
                {contact.unreadCount > 0 && (
                  <span className="badge">{contact.unreadCount}</span>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-area">
        {!connected ? (
          // QR Code Screen
          <div className="qr-container">
            <h3>📱 Scan QR Code untuk menghubungkan WhatsApp</h3>
            {qrCode ? (
              <img src={qrCode} alt="QR Code" className="qr-code" />
            ) : (
              <div className="qr-loading" style={{
                width: '256px',
                height: '256px',
                background: '#f0f2f5',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '24px'
              }}>
                <div className="spinner" style={{width: '30px', height: '30px'}}></div>
              </div>
            )}
            <p className="hint">
              Buka WhatsApp di HP Anda → Pengaturan → Perangkat Tertaut → Tautkan Perangkat
            </p>
          </div>
        ) : !selectedChat ? (
          // Empty State
          <div className="empty-state">
            <div style={{textAlign: 'center'}}>
              <div style={{fontSize: '64px', marginBottom: '16px'}}>💬</div>
              <p>Pilih kontak untuk mulai chat</p>
            </div>
          </div>
        ) : (
          // Chat Window
          <>
            <div className="chat-header">
              <h3>
                {contacts.find(c => c.id === selectedChat)?.name || 
                 selectedChat.split('@')[0]}
              </h3>
            </div>
            
            <div className="messages-container">
              {messages
                .filter(m => m.from === selectedChat || m.fromMe)
                .map(msg => (
                  <div
                    key={msg.id}
                    className={`message ${msg.fromMe ? 'sent' : 'received'}`}
                  >
                    <div className="bubble">
                      {msg.text}
                    </div>
                    {msg.fromMe && (
                      <span className="status">
                        {msg.status === 'sending' ? '⏳' :
                         msg.status === 'sent' ? '✓' :
                         msg.status === 'delivered' ? '✓✓' :
                         msg.status === 'read' ? '✓✓✓' : ''}
                      </span>
                    )}
                    <span style={{
                      fontSize: '11px',
                      color: '#667781',
                      marginLeft: '4px',
                      alignSelf: 'flex-end',
                      marginBottom: '4px'
                    }}>
                      {formatTime(msg.timestamp)}
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
                autoFocus
              />
              <button type="submit" disabled={loading || !messageText.trim()}>
                {loading ? '⏳' : '➤'}
              </button>
            </form>
          </>
        )}
        
        {error && (
          <div className="error-toast">
            ⚠️ {error}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
