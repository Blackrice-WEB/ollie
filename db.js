// Fix Node.js 20 WebSocket compatibility issue with Supabase
try {
  const ws = require('ws');
  global.WebSocket = ws;
} catch (e) {
  console.warn('Could not load ws package globally, make sure it is installed if running in Node.js environment');
}

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// User provided Supabase Credentials
const supabaseUrl = process.env.SUPABASE_URL || 'https://xjbtvnbzmtyixsdvztjb.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_elzVTBJi3ZcKgY5nWnsDwA_fYESJxXf';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Helper to initialize default settings in the database
async function initSettings() {
  const defaultSettings = [
    { key: 'bot_active', value: 'true' },
    { key: 'reply_delay', value: '10000' }, // 10 seconds responsive delay
    { key: 'ai_personality', value: 'You are Ollie, a friendly and highly intelligent AI WhatsApp assistant created for Oliver. Keep replies casual, incredibly natural, and human-like. Never mention you are an AI.' },
    { key: 'auto_reply_groups', value: 'false' },
    { key: 'owner_name', value: 'Oliver' },
    { key: 'bot_name', value: 'Ollie' },
    { key: 'owner_phone', value: '254705760434' },
    { key: 'poster_url', value: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80' },
    { key: 'poster_trigger', value: 'poster' },
    { key: 'bot_rules', value: '1. Act as Ollie, Oliver\'s personal assistant.\n2. If the sender asks for a "poster", "flyer", or "brochure", make sure to mention you are sending the official poster.\n3. Always match their vibe (casual/friendly/formal).\n4. Keep answers short and sweet (1-2 sentences).' }
  ];

  try {
    for (const setting of defaultSettings) {
      const { data, error } = await supabase
        .from('bot_settings')
        .select('value')
        .eq('key', setting.key)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error(`Error checking setting ${setting.key}:`, error.message);
        continue;
      }

      if (!data) {
        await supabase.from('bot_settings').insert([setting]);
      }
    }
  } catch (err) {
    console.error('Error initializing settings:', err.message);
  }
}

// Get setting by key
async function getSetting(key, defaultValue = '') {
  try {
    const { data, error } = await supabase
      .from('bot_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error) return defaultValue;
    return data ? data.value : defaultValue;
  } catch (err) {
    return defaultValue;
  }
}

// Set setting by key
async function setSetting(key, value) {
  try {
    const { error } = await supabase
      .from('bot_settings')
      .upsert({ key, value }, { onConflict: 'key' });

    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`Error setting ${key}:`, err.message);
    return false;
  }
}

// Get all settings
async function getAllSettings() {
  try {
    const { data, error } = await supabase
      .from('bot_settings')
      .select('*');
    
    if (error) throw error;
    
    const settingsObj = {};
    data.forEach(item => {
      settingsObj[item.key] = item.value;
    });
    return settingsObj;
  } catch (err) {
    console.error('Error getting all settings:', err.message);
    return {};
  }
}

// Save message
async function saveMessage({ jid, sender_name, message_text, reply_text = null, reply_status = 'pending', is_group = false, is_meeting = false }) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert([
        {
          jid,
          sender_name,
          message_text,
          reply_text,
          reply_status,
          is_group,
          is_meeting,
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) throw error;
    return data ? data[0] : null;
  } catch (err) {
    console.error('Error saving message:', err.message);
    return { jid, sender_name, message_text, reply_text, reply_status, is_group, is_meeting, created_at: new Date().toISOString() };
  }
}

// Update message reply
async function updateMessageReply(id, reply_text, reply_status) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .update({ reply_text, reply_status })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data ? data[0] : null;
  } catch (err) {
    console.error('Error updating message reply:', err.message);
    return null;
  }
}

// Check if a JID is blocked
async function isBlocked(jid) {
  try {
    const { data } = await supabase
      .from('blocked_contacts')
      .select('jid')
      .eq('jid', jid)
      .maybeSingle();

    return !!data;
  } catch (err) {
    return false;
  }
}

// Get all blocked contacts
async function getBlockedContacts() {
  try {
    const { data, error } = await supabase
      .from('blocked_contacts')
      .select('*');
    
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error getting blocked contacts:', err.message);
    return [];
  }
}

// Block a contact
async function blockContact(jid, name, is_group = false) {
  try {
    const { data, error } = await supabase
      .from('blocked_contacts')
      .upsert({ jid, name, is_group }, { onConflict: 'jid' })
      .select();

    if (error) throw error;
    return data ? data[0] : null;
  } catch (err) {
    console.error('Error blocking contact:', err.message);
    return null;
  }
}

// Unblock a contact
async function unblockContact(jid) {
  try {
    const { error } = await supabase
      .from('blocked_contacts')
      .delete()
      .eq('jid', jid);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Error unblocking contact:', err.message);
    return false;
  }
}

// Get or create contact profile
async function getOrCreateContactProfile(jid, name) {
  try {
    const { data, error } = await supabase
      .from('contact_profiles')
      .select('*')
      .eq('jid', jid)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;

    const now = new Date().toISOString();

    if (data) {
      const { data: updated, error: updateError } = await supabase
        .from('contact_profiles')
        .update({
          message_count: (data.message_count || 0) + 1,
          last_seen: now,
          name: name || data.name
        })
        .eq('jid', jid)
        .select();

      if (updateError) throw updateError;
      return updated ? updated[0] : data;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('contact_profiles')
        .insert([
          {
            jid,
            name: name || 'Unknown Contact',
            vibe: 'friendly',
            message_count: 1,
            last_seen: now,
            notes: ''
          }
        ])
        .select();

      if (insertError) throw insertError;
      return inserted ? inserted[0] : null;
    }
  } catch (err) {
    console.error('Error in getOrCreateContactProfile:', err.message);
    return { jid, name, vibe: 'friendly', message_count: 1, last_seen: new Date().toISOString() };
  }
}

// Update contact vibe
async function updateContactVibe(jid, vibe) {
  try {
    const { data, error } = await supabase
      .from('contact_profiles')
      .update({ vibe })
      .eq('jid', jid)
      .select();

    if (error) throw error;
    return data ? data[0] : null;
  } catch (err) {
    console.error('Error updating contact vibe:', err.message);
    return null;
  }
}

// Save meeting alert
async function saveMeetingAlert({ sender, message, detected_time = '', detected_date = '', alert_type = 'meeting', is_read = false }) {
  try {
    const { data, error } = await supabase
      .from('meeting_alerts')
      .insert([
        {
          sender,
          message,
          detected_time,
          detected_date,
          alert_type,
          is_read,
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) throw error;
    return data ? data[0] : null;
  } catch (err) {
    console.error('Error saving meeting alert:', err.message);
    return { sender, message, detected_time, detected_date, alert_type, is_read, created_at: new Date().toISOString() };
  }
}

// Get all meeting alerts
async function getMeetingAlerts() {
  try {
    const { data, error } = await supabase
      .from('meeting_alerts')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error getting meeting alerts:', err.message);
    return [];
  }
}

// Mark alert as read
async function markAlertAsRead(id) {
  try {
    const { data, error } = await supabase
      .from('meeting_alerts')
      .update({ is_read: true })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data ? data[0] : null;
  } catch (err) {
    console.error('Error marking alert as read:', err.message);
    return null;
  }
}

// Mark all alerts as read
async function markAllAlertsAsRead() {
  try {
    const { error } = await supabase
      .from('meeting_alerts')
      .update({ is_read: true })
      .eq('is_read', false);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Error marking all alerts as read:', err.message);
    return false;
  }
}

// Get message history
async function getChatHistory(jid, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('jid', jid)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data ? data.reverse() : [];
  } catch (err) {
    console.error('Error getting chat history:', err.message);
    return [];
  }
}

// Get recent messages
async function getRecentMessages(limit = 100) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error getting recent messages:', err.message);
    return [];
  }
}

// Save auth session file
async function saveAuthSession(fileId, dataString) {
  try {
    const { error } = await supabase
      .from('auth_session')
      .upsert({ file_id: fileId, data: dataString, updated_at: new Date().toISOString() }, { onConflict: 'file_id' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`Error saving auth session ${fileId}:`, err.message);
    return false;
  }
}

// Get auth session file
async function getAuthSession(fileId) {
  try {
    const { data, error } = await supabase
      .from('auth_session')
      .select('data')
      .eq('file_id', fileId)
      .maybeSingle();
    if (error) return null;
    return data ? data.data : null;
  } catch (err) {
    return null;
  }
}

// Clear auth session
async function clearAuthSession() {
  try {
    const { error } = await supabase
      .from('auth_session')
      .delete()
      .neq('file_id', 'placeholder');
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Error clearing auth session:', err.message);
    return false;
  }
}

module.exports = {
  supabase,
  initSettings,
  getSetting,
  setSetting,
  getAllSettings,
  saveMessage,
  updateMessageReply,
  isBlocked,
  getBlockedContacts,
  blockContact,
  unblockContact,
  getOrCreateContactProfile,
  updateContactVibe,
  saveMeetingAlert,
  getMeetingAlerts,
  markAlertAsRead,
  markAllAlertsAsRead,
  getChatHistory,
  getRecentMessages,
  saveAuthSession,
  getAuthSession,
  clearAuthSession
};
