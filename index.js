const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const db = require('./db');
const whatsapp = require('./whatsapp');

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// Serve index.html and static assets from the root directory directly (Flat Structure)
app.use(express.static(path.join(__dirname, '.')));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'] // Explicitly enable websocket transports first
});

io.on('connection', (socket) => {
  console.log(`Dashboard client connected: ${socket.id}`);
  socket.emit('status_update', whatsapp.getStatus());

  socket.on('disconnect', () => {
    console.log(`Dashboard client disconnected: ${socket.id}`);
  });
});

async function initializeApp() {
  console.log('Initializing database and default settings...');
  await db.initSettings();
  
  console.log('Initializing WhatsApp module...');
  await whatsapp.init(io);
}
initializeApp().catch(err => {
  console.error('Failed to initialize application:', err.message);
});

// ==========================================
// API ROUTES
// ==========================================

app.get('/api/status', (req, res) => {
  try {
    const status = whatsapp.getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/connect', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Phone number is required' });
  }

  try {
    console.log(`Dashboard requested pairing code for phone number: ${phoneNumber}`);
    whatsapp.connectWhatsApp(phoneNumber);
    res.json({ success: true, message: 'Pairing process initiated. Look for the code via Socket.IO.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  try {
    const success = await whatsapp.disconnectWhatsApp();
    if (success) {
      res.json({ success: true, message: 'WhatsApp disconnected successfully.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to disconnect.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const messages = await db.getRecentMessages(100);
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await db.getMeetingAlerts();
    res.json({ success: true, alerts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/alerts/:id/read', async (req, res) => {
  const { id } = req.params;
  try {
    const alert = await db.markAlertAsRead(id);
    if (alert) {
      io.emit('alert_marked_read', { id });
      res.json({ success: true, alert });
    } else {
      res.status(404).json({ success: false, error: 'Alert not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/alerts/read-all', async (req, res) => {
  try {
    const success = await db.markAllAlertsAsRead();
    if (success) {
      io.emit('all_alerts_read');
      res.json({ success: true, message: 'All alerts marked as read' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to mark all as read' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/blocked', async (req, res) => {
  try {
    const blocked = await db.getBlockedContacts();
    res.json({ success: true, blocked });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/blocked', async (req, res) => {
  const { jid, name, is_group } = req.body;
  if (!jid) {
    return res.status(400).json({ success: false, error: 'JID is required' });
  }

  try {
    const blocked = await db.blockContact(jid, name || 'Blocked Contact', !!is_group);
    if (blocked) {
      res.json({ success: true, blocked });
    } else {
      res.status(500).json({ success: false, error: 'Failed to block contact' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/blocked/:jid', async (req, res) => {
  const { jid } = req.params;
  try {
    const success = await db.unblockContact(jid);
    if (success) {
      res.json({ success: true, message: 'Contact unblocked successfully.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to unblock contact.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getAllSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  const { key, value } = req.body;
  if (!key) {
    return res.status(400).json({ success: false, error: 'Key is required' });
  }

  try {
    const success = await db.setSetting(key, String(value));
    if (success) {
      res.json({ success: true, key, value });
    } else {
      res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { jid, text } = req.body;
  if (!jid || !text) {
    return res.status(400).json({ success: false, error: 'JID and text are required' });
  }

  try {
    const result = await whatsapp.sendManualMessage(jid, text);
    res.json({ success: true, message: 'Message sent successfully.', result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single-page fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Ollie AI WhatsApp Bot Server is running on port ${PORT}`);
  console.log(`   Dashboard URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
