const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('./db');
const ai = require('./ai');

const SESSION_FOLDER = process.env.SESSION_FOLDER || 'auth_info_baileys';
const logger = pino({ level: 'silent' });

let sock = null;
let io = null;
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'pairing'
let pairingCode = null;
let currentPhoneNumber = null;
let qrCodeImage = null; // Store current QR code base64 image

const activeTimers = new Map();

/**
 * Initialize WhatsApp connection module
 */
async function init(socketIo) {
  io = socketIo;
  
  // Download credentials from Supabase before starting Baileys
  await downloadSessionFromDatabase();

  const credsPath = path.join(process.cwd(), SESSION_FOLDER, 'creds.json');
  if (fs.existsSync(credsPath)) {
    console.log('WhatsApp credentials loaded from Supabase. Auto-connecting...');
    connectWhatsApp();
  } else {
    console.log('No WhatsApp session found in database. Initializing default QR code connection...');
    connectWhatsApp(); // Start connection immediately to generate QR codes!
  }
}

/**
 * Helper to download session from Supabase
 */
async function downloadSessionFromDatabase() {
  try {
    const sessionData = await db.getAuthSession('creds.json');
    if (sessionData) {
      const sessionDir = path.join(process.cwd(), SESSION_FOLDER);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      fs.writeFileSync(path.join(sessionDir, 'creds.json'), sessionData);
      console.log('Successfully synchronized WhatsApp credentials from Supabase!');
    }
  } catch (err) {
    console.error('Failed to download session from Supabase:', err.message);
  }
}

/**
 * Helper to upload session to Supabase
 */
async function uploadSessionToDatabase() {
  try {
    const credsPath = path.join(process.cwd(), SESSION_FOLDER, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const credsContent = fs.readFileSync(credsPath, 'utf8');
      await db.saveAuthSession('creds.json', credsContent);
    }
  } catch (err) {
    console.error('Failed to upload session to Supabase:', err.message);
  }
}

/**
 * Main WhatsApp connection handler (Knight Bot MD Formula)
 */
async function connectWhatsApp(phoneNumber = null) {
  try {
    // Close and clean up any existing socket to prevent parallel conflicts
    if (sock) {
      console.log('Closing existing WhatsApp socket before reconnecting...');
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.end();
      } catch (e) {
        console.warn('Error closing old socket:', e.message);
      }
      sock = null;
    }

    connectionStatus = 'connecting';
    pairingCode = null;
    qrCodeImage = null;
    currentPhoneNumber = phoneNumber;
    broadcastStatus();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // Disables terminal QR codes
      logger: logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await uploadSessionToDatabase();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR Code Generation (Knight Bot MD style)
      if (qr) {
        try {
          // Convert QR code to base64 image data URL
          const qrImage = await QRCode.toDataURL(qr);
          qrCodeImage = qrImage;
          connectionStatus = 'pairing'; // Set to pairing to indicate linking mode
          
          console.log('New WhatsApp QR code generated. Pushing to dashboard...');
          
          if (io) {
            io.emit('qr_code', { qr: qrCodeImage });
          }
          broadcastStatus();
        } catch (qrErr) {
          console.error('Error converting QR code to image:', qrErr.message);
        }
      }

      if (connection === 'connecting') {
        connectionStatus = 'connecting';
        broadcastStatus();
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        pairingCode = null;
        qrCodeImage = null;
        console.log('WhatsApp connection successfully opened for Ollie!');
        await uploadSessionToDatabase();
        broadcastStatus();
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp connection closed. Reconnecting?', shouldReconnect);
        
        connectionStatus = 'disconnected';
        pairingCode = null;
        qrCodeImage = null;
        broadcastStatus();

        if (shouldReconnect) {
          setTimeout(() => connectWhatsApp(currentPhoneNumber), 5000);
        } else {
          await cleanupSession();
        }
      }
    });

    // Handle Phone Number Pairing Code (if requested by user)
    if (phoneNumber && !sock.authState.creds.registered) {
      connectionStatus = 'pairing';
      broadcastStatus();

      await delay(3000);
      const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
      console.log(`Requesting pairing code for phone: ${sanitizedPhone}...`);
      
      try {
        const code = await sock.requestPairingCode(sanitizedPhone);
        pairingCode = code;
        qrCodeImage = null; // Clear QR code since we are using pairing code
        console.log(`Generated pairing code for Oliver: ${pairingCode}`);
        
        if (io) {
          io.emit('pairing_code', { code: pairingCode });
        }
        broadcastStatus();
      } catch (err) {
        console.error('Error requesting pairing code:', err.message);
        connectionStatus = 'disconnected';
        pairingCode = null;
        broadcastStatus();
      }
    }

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        try {
          await handleIncomingMessage(msg);
        } catch (err) {
          console.error('Error handling message:', err.message);
        }
      }
    });

  } catch (err) {
    console.error('Error in connectWhatsApp:', err.message);
    connectionStatus = 'disconnected';
    broadcastStatus();
  }
}

function broadcastThinking(jid, senderName, step, detail) {
  if (io) {
    io.emit('ollie_thinking', {
      jid,
      senderName,
      step,
      detail,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Handle incoming message
 */
async function handleIncomingMessage(msg) {
  if (!msg.message) return;
  
  const messageContent = getMessageText(msg.message);
  if (!messageContent) return;

  const key = msg.key;
  const jid = key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const fromMe = key.fromMe;

  if (fromMe) return;

  const senderName = msg.pushName || 'WhatsApp Contact';
  console.log(`New message from ${senderName} (${jid}): "${messageContent}"`);

  broadcastThinking(jid, senderName, 'checking', 'Analyzing incoming message rules...');

  const senderJid = isGroup ? (key.participant || jid) : jid;

  // 1. Meet Detection
  broadcastThinking(jid, senderName, 'parsing', 'Scanning message for meeting keywords and times...');
  const meetingRegex = /\b(meeting|call|zoom|appointment|interview|schedule|teams|google meet|skype|sync|calendar|facetime)\b/i;
  const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)|\b(?:tomorrow|today|tonight|next\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

  const isMeetingWord = meetingRegex.test(messageContent);
  const isTimeWord = timeRegex.test(messageContent);
  const isMeeting = isMeetingWord && isTimeWord;

  let detectedTime = '';
  let detectedDate = '';
  if (isMeeting) {
    const timeMatch = messageContent.match(timeRegex);
    detectedTime = timeMatch ? timeMatch[0] : 'Unspecified Time';
    detectedDate = 'Tomorrow';
  }

  // 2. Save message to Supabase
  const savedMsg = await db.saveMessage({
    jid,
    sender_name: senderName,
    message_text: messageContent,
    reply_text: null,
    reply_status: 'pending',
    is_group: isGroup,
    is_meeting: isMeeting
  });

  const profile = await db.getOrCreateContactProfile(jid, senderName);

  if (io && savedMsg) {
    io.emit('new_message', {
      ...savedMsg,
      id: savedMsg.id || Date.now(),
      profile
    });
  }

  if (isMeeting) {
    const alert = await db.saveMeetingAlert({
      sender: senderName,
      message: messageContent,
      detected_time: detectedTime,
      detected_date: detectedDate,
      alert_type: 'meeting',
      is_read: false
    });

    if (io) {
      io.emit('meeting_alert', {
        ...alert,
        id: alert.id || Date.now()
      });
    }
  }

  // 3. Check Blocked
  const isJidBlocked = await db.isBlocked(jid);
  const isSenderBlocked = isGroup ? await db.isBlocked(senderJid) : false;

  if (isJidBlocked || isSenderBlocked) {
    broadcastThinking(jid, senderName, 'done', 'Sender is blocked. Dropped message.');
    await db.updateMessageReply(savedMsg.id, '[Skipped - Blocked]', 'skipped');
    if (io && savedMsg.id) {
      io.emit('reply_status_update', { id: savedMsg.id, status: 'skipped', reply_text: '[Skipped - Blocked]' });
    }
    return;
  }

  // 4. Check Bot Active / Groups
  const botActiveSetting = await db.getSetting('bot_active', 'true');
  const groupReplySetting = await db.getSetting('auto_reply_groups', 'false');

  const isBotActive = botActiveSetting === 'true';
  const isGroupReplyEnabled = groupReplySetting === 'true';

  if (!isBotActive) {
    broadcastThinking(jid, senderName, 'done', 'Ollie bot is currently inactive. Dropped message.');
    await db.updateMessageReply(savedMsg.id, '[Skipped - Bot Inactive]', 'skipped');
    if (io && savedMsg.id) {
      io.emit('reply_status_update', { id: savedMsg.id, status: 'skipped', reply_text: '[Skipped - Bot Inactive]' });
    }
    return;
  }

  if (isGroup && !isGroupReplyEnabled) {
    broadcastThinking(jid, senderName, 'done', 'Group replies are disabled. Dropped message.');
    await db.updateMessageReply(savedMsg.id, '[Skipped - Groups Disabled]', 'skipped');
    if (io && savedMsg.id) {
      io.emit('reply_status_update', { id: savedMsg.id, status: 'skipped', reply_text: '[Skipped - Groups Disabled]' });
    }
    return;
  }

  // 5. Schedule Delayed AI Reply
  if (activeTimers.has(jid)) {
    const existing = activeTimers.get(jid);
    broadcastThinking(jid, senderName, 'scheduling', 'Follow-up message received! Resetting delay timer to avoid spamming...');
    clearTimeout(existing.timeoutId);
    
    if (existing.messageId) {
      await db.updateMessageReply(existing.messageId, '[Skipped - Follow-up received]', 'skipped');
      if (io) {
        io.emit('reply_status_update', { id: existing.messageId, status: 'skipped', reply_text: '[Skipped - Follow-up received]' });
      }
    }
    activeTimers.delete(jid);
  }

  const delayStr = await db.getSetting('reply_delay', '10000');
  const delayMs = parseInt(delayStr, 10) || 10000;

  broadcastThinking(jid, senderName, 'scheduling', `Scheduled AI auto-reply to fire in ${delayMs / 1000} seconds.`);

  const startTime = Date.now();
  const timeoutId = setTimeout(async () => {
    try {
      // A. Vibe Detection
      broadcastThinking(jid, senderName, 'vibe_detecting', 'Running Groq vibe classification engine...');
      const vibe = await ai.detectVibe(messageContent);
      await db.updateContactVibe(jid, vibe);

      // B. Custom Poster trigger check
      const posterUrl = await db.getSetting('poster_url', '');
      const posterTrigger = await db.getSetting('poster_trigger', 'poster');
      const shouldSendPoster = messageContent.toLowerCase().includes(posterTrigger.toLowerCase());

      if (shouldSendPoster && posterUrl) {
        broadcastThinking(jid, senderName, 'sending', `User triggered keyword: "${posterTrigger}". Transmitting brochure poster...`);
        try {
          await sock.sendMessage(jid, { 
            image: { url: posterUrl }, 
            caption: `Hey ${senderName}! Here is the official brochure poster you requested.` 
          });
        } catch (mediaErr) {
          console.error('Failed to send poster media:', mediaErr.message);
        }
      }

      // C. AI reply generation
      broadcastThinking(jid, senderName, 'ai_generating', 'Querying Groq Llama 3.3 for conversational auto-reply...');
      const chatHistory = await db.getChatHistory(jid, 5);
      const personalityPrompt = await db.getSetting('ai_personality', '');
      const customRules = await db.getSetting('bot_rules', '');

      const aiReply = await ai.generateReply(
        messageContent,
        senderName,
        chatHistory,
        vibe,
        personalityPrompt,
        customRules
      );

      // D. Send WhatsApp Message
      broadcastThinking(jid, senderName, 'sending', 'Transmitting auto-reply payload to phone...');
      await sock.sendMessage(jid, { text: aiReply });

      // E. Update Database
      await db.updateMessageReply(savedMsg.id, aiReply, 'replied');
      const updatedProfile = await db.getOrCreateContactProfile(jid, senderName);

      if (io && savedMsg.id) {
        io.emit('reply_status_update', {
          id: savedMsg.id,
          status: 'replied',
          reply_text: aiReply,
          profile: {
            ...updatedProfile,
            vibe: vibe
          }
        });
      }

      broadcastThinking(jid, senderName, 'done', 'Auto-reply processed successfully.');

    } catch (err) {
      console.error(`Failed to send auto-reply to ${senderName}:`, err.message);
      broadcastThinking(jid, senderName, 'done', `Failed to reply: ${err.message}`);
      await db.updateMessageReply(savedMsg.id, `[Error: ${err.message}]`, 'failed');
      if (io && savedMsg.id) {
        io.emit('reply_status_update', { id: savedMsg.id, status: 'failed', reply_text: `[Error: ${err.message}]` });
      }
    } finally {
      activeTimers.delete(jid);
      broadcastTimers();
    }
  }, delayMs);

  activeTimers.set(jid, {
    timeoutId,
    messageId: savedMsg.id,
    messageText: messageContent,
    senderName,
    isGroup,
    startTime,
    delayMs
  });

  broadcastTimers();
}

/**
 * Broadcast current connection status
 */
function broadcastStatus() {
  if (io) {
    io.emit('status_update', {
      status: connectionStatus,
      pairingCode: pairingCode,
      qrCode: qrCodeImage, // Broadcast QR code base64 image
      phoneNumber: currentPhoneNumber
    });
  }
}

/**
 * Broadcast active timers
 */
function broadcastTimers() {
  if (!io) return;
  
  const timersList = [];
  const now = Date.now();
  
  for (const [jid, data] of activeTimers.entries()) {
    const elapsed = now - data.startTime;
    const timeLeft = Math.max(0, data.delayMs - elapsed);
    timersList.push({
      jid,
      senderName: data.senderName,
      messageText: data.messageText,
      timeLeft,
      totalDelay: data.delayMs,
      messageId: data.messageId
    });
  }
  
  io.emit('timers_update', timersList);
}

// Periodically update active timers
setInterval(() => {
  if (activeTimers.size > 0) {
    broadcastTimers();
  }
}, 1000);

/**
 * Helper to extract raw text
 */
function getMessageText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage) return message.extendedTextMessage.text;
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
  if (message.videoMessage && message.videoMessage.caption) return message.videoMessage.caption;
  return '';
}

/**
 * Disconnect WhatsApp
 */
async function disconnectWhatsApp() {
  try {
    connectionStatus = 'disconnected';
    pairingCode = null;
    qrCodeImage = null;
    currentPhoneNumber = null;

    if (sock) {
      try {
        await sock.logout();
      } catch (e) {}
      sock.end();
      sock = null;
    }

    await cleanupSession();
    broadcastStatus();
    console.log('WhatsApp disconnected and credentials cleared.');
    return true;
  } catch (err) {
    console.error('Error disconnecting WhatsApp:', err.message);
    return false;
  }
}

async function cleanupSession() {
  try {
    await db.clearAuthSession();
    const sessionPath = path.join(process.cwd(), SESSION_FOLDER);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    console.log('Cleared local and Supabase auth sessions.');
  } catch (err) {
    console.error('Error cleaning session:', err.message);
  }
}

function getStatus() {
  return {
    status: connectionStatus,
    pairingCode,
    qrCode: qrCodeImage,
    phoneNumber: currentPhoneNumber
  };
}

async function sendManualMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp is not connected.');
  }
  
  const result = await sock.sendMessage(jid, { text });
  
  await db.saveMessage({
    jid,
    sender_name: 'Me (Manual)',
    message_text: `[Manual Message]`,
    reply_text: text,
    reply_status: 'replied',
    is_group: jid.endsWith('@g.us'),
    is_meeting: false
  });

  return result;
}

module.exports = {
  init,
  connectWhatsApp,
  disconnectWhatsApp,
  getStatus,
  sendManualMessage,
  activeTimers
};
