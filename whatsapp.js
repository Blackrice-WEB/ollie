const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  Browsers
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
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'pairing'
let pairingCode = null;
let currentPhoneNumber = null;
let qrCodeImage = null; // Store current QR code base64 image

const activeTimers = new Map();
const ollieThinkingLogs = [];

/**
 * Add Ollie thinking log
 */
function addThinkingLog(jid, senderName, step, detail) {
  const log = {
    jid,
    senderName,
    step,
    detail,
    timestamp: new Date().toISOString()
  };
  ollieThinkingLogs.unshift(log);
  if (ollieThinkingLogs.length > 100) {
    ollieThinkingLogs.pop();
  }
}

/**
 * Initialize WhatsApp connection module
 */
async function init() {
  await downloadSessionFromDatabase();

  const credsPath = path.join(process.cwd(), SESSION_FOLDER, 'creds.json');
  if (fs.existsSync(credsPath)) {
    console.log('WhatsApp credentials loaded from Supabase. Auto-connecting...');
    connectWhatsApp();
  } else {
    console.log('No WhatsApp session found in database. Initializing default connection...');
    connectWhatsApp(); 
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
 * Main WhatsApp connection handler
 */
async function connectWhatsApp() {
  try {
    if (sock) {
      console.log('Closing existing WhatsApp socket before reconnecting...');
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.end();
      } catch (e) {}
      sock = null;
    }

    connectionStatus = 'connecting';
    pairingCode = null;
    qrCodeImage = null;

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger,
      browser: Browsers.ubuntu('Chrome'), 
      defaultQueryTimeoutMs: undefined
    });

    setupSocketListeners(saveCreds);

  } catch (err) {
    console.error('Error in connectWhatsApp:', err.message);
    connectionStatus = 'disconnected';
  }
}

/**
 * Direct HTTP Pairing Code Flow (Knight Bot MD / Atlas MD Formula)
 * Ensures code is generated exactly once per request and cached safely.
 */
async function getPairingCodeDirect(phoneNumber) {
  // If we already have an active pairing code generated for this number, return it immediately!
  if (connectionStatus === 'pairing' && pairingCode && currentPhoneNumber === phoneNumber) {
    console.log(`[Direct Connect] Returning cached pairing code for: ${phoneNumber}`);
    return pairingCode;
  }

  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[Direct Connect] Initiating fresh pairing code generation for: ${phoneNumber}`);
      
      // Clean up previous sessions to start fresh
      await cleanupSession();

      const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

      const tempSock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: logger,
        browser: Browsers.ubuntu('Chrome'),
        defaultQueryTimeoutMs: undefined
      });

      tempSock.ev.on('creds.update', async () => {
        await saveCreds();
        await uploadSessionToDatabase();
      });

      tempSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // When the socket is fully handshaked, WhatsApp presents the QR code.
        // We intercept the QR code to request our pairing code instead!
        if (qr) {
          try {
            const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
            console.log(`[Direct Connect] Handshake complete. Fetching pairing code...`);
            
            const code = await tempSock.requestPairingCode(sanitizedPhone);
            const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
            
            // Lock and cache state
            sock = tempSock;
            connectionStatus = 'pairing';
            pairingCode = formattedCode;
            currentPhoneNumber = phoneNumber;
            qrCodeImage = null;

            setupSocketListeners(saveCreds);
            resolve(formattedCode);
          } catch (err) {
            console.error('[Direct Connect] requestPairingCode failed:', err.message);
            reject(err);
          }
        }

        if (connection === 'open') {
          connectionStatus = 'connected';
          pairingCode = null;
          qrCodeImage = null;
          console.log('[Direct Connect] Link successful! Ollie is online.');
          await uploadSessionToDatabase();
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('[Direct Connect] Socket closed. Reconnecting?', shouldReconnect);
          
          connectionStatus = 'disconnected';
          pairingCode = null;
          qrCodeImage = null;

          if (shouldReconnect && sock === tempSock) {
            setTimeout(() => connectWhatsApp(currentPhoneNumber), 5000);
          }
        }
      });

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Bind Baileys event listeners
 */
function setupSocketListeners(saveCreds) {
  if (!sock) return;

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await uploadSessionToDatabase();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // If QR code is received and we are NOT pairing via phone, render it
    if (qr && !currentPhoneNumber) {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        qrCodeImage = qrImage;
        connectionStatus = 'pairing';
      } catch (qrErr) {
        console.error('Error converting QR code to image:', qrErr.message);
      }
    }

    if (connection === 'connecting') {
      connectionStatus = 'connecting';
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      pairingCode = null;
      qrCodeImage = null;
      console.log('WhatsApp connection opened successfully!');
      await uploadSessionToDatabase();
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      pairingCode = null;
      qrCodeImage = null;

      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(currentPhoneNumber), 5000);
      } else {
        await cleanupSession();
      }
    }
  });

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

  addThinkingLog(jid, senderName, 'checking', 'Analyzing incoming message rules...');

  const senderJid = isGroup ? (key.participant || jid) : jid;

  // 1. Meet Detection
  addThinkingLog(jid, senderName, 'parsing', 'Scanning message for meeting keywords and times...');
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

  await db.getOrCreateContactProfile(jid, senderName);

  if (isMeeting) {
    await db.saveMeetingAlert({
      sender: senderName,
      message: messageContent,
      detected_time: detectedTime,
      detected_date: detectedDate,
      alert_type: 'meeting',
      is_read: false
    });
  }

  // 3. Check Blocked
  const isJidBlocked = await db.isBlocked(jid);
  const isSenderBlocked = isGroup ? await db.isBlocked(senderJid) : false;

  if (isJidBlocked || isSenderBlocked) {
    addThinkingLog(jid, senderName, 'done', 'Sender is blocked. Dropped message.');
    await db.updateMessageReply(savedMsg.id, '[Skipped - Blocked]', 'skipped');
    return;
  }

  // 4. Check Bot Active / Groups
  const botActiveSetting = await db.getSetting('bot_active', 'true');
  const groupReplySetting = await db.getSetting('auto_reply_groups', 'false');

  const isBotActive = botActiveSetting === 'true';
  const isGroupReplyEnabled = groupReplySetting === 'true';

  if (!isBotActive) {
    addThinkingLog(jid, senderName, 'done', 'Ollie bot is currently inactive. Dropped message.');
    await db.updateMessageReply(savedMsg.id, '[Skipped - Bot Inactive]', 'skipped');
    return;
  }

  if (isGroup && !isGroupReplyEnabled) {
    addThinkingLog(jid, senderName, 'done', 'Group replies are disabled. Dropped message.');
    await db.updateMessageReply(savedMsg.id, '[Skipped - Groups Disabled]', 'skipped');
    return;
  }

  // 5. Schedule Delayed AI Reply
  if (activeTimers.has(jid)) {
    const existing = activeTimers.get(jid);
    addThinkingLog(jid, senderName, 'scheduling', 'Follow-up message received! Resetting delay timer to avoid spamming...');
    clearTimeout(existing.timeoutId);
    
    if (existing.messageId) {
      await db.updateMessageReply(existing.messageId, '[Skipped - Follow-up received]', 'skipped');
    }
    activeTimers.delete(jid);
  }

  const delayStr = await db.getSetting('reply_delay', '10000');
  const delayMs = parseInt(delayStr, 10) || 10000;

  addThinkingLog(jid, senderName, 'scheduling', `Scheduled AI auto-reply to fire in ${delayMs / 1000} seconds.`);

  const startTime = Date.now();
  const timeoutId = setTimeout(async () => {
    try {
      // A. Vibe Detection
      addThinkingLog(jid, senderName, 'vibe_detecting', 'Running Groq vibe classification engine...');
      const vibe = await ai.detectVibe(messageContent);
      await db.updateContactVibe(jid, vibe);

      // B. Custom Poster trigger check
      const posterUrl = await db.getSetting('poster_url', '');
      const posterTrigger = await db.getSetting('poster_trigger', 'poster');
      const shouldSendPoster = messageContent.toLowerCase().includes(posterTrigger.toLowerCase());

      if (shouldSendPoster && posterUrl) {
        addThinkingLog(jid, senderName, 'sending', `User triggered keyword: "${posterTrigger}". Transmitting brochure poster...`);
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
      addThinkingLog(jid, senderName, 'ai_generating', 'Querying Groq Llama 3.3 for conversational auto-reply...');
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
      addThinkingLog(jid, senderName, 'sending', 'Transmitting auto-reply payload to phone...');
      await sock.sendMessage(jid, { text: aiReply });

      // E. Update Database
      await db.updateMessageReply(savedMsg.id, aiReply, 'replied');
      await db.getOrCreateContactProfile(jid, senderName);

      addThinkingLog(jid, senderName, 'done', 'Auto-reply processed successfully.');

    } catch (err) {
      console.error(`Failed to send auto-reply to ${senderName}:`, err.message);
      addThinkingLog(jid, senderName, 'done', `Failed to reply: ${err.message}`);
      await db.updateMessageReply(savedMsg.id, `[Error: ${err.message}]`, 'failed');
    } finally {
      activeTimers.delete(jid);
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
}

/**
 * Get active timers list
 */
function getActiveTimers() {
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
  return timersList;
}

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
    phoneNumber: currentPhoneNumber,
    activeTimers: getActiveTimers(),
    thinkingLogs: ollieThinkingLogs
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
  getPairingCodeDirect,
  disconnectWhatsApp,
  getStatus,
  sendManualMessage,
  activeTimers
};
