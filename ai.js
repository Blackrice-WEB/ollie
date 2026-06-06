const Groq = require('groq-sdk');
require('dotenv').config();

// User provided Groq API Key
const apiKey = process.env.GROQ_API_KEY || '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';
let groq = null;

if (apiKey) {
  groq = new Groq({ apiKey });
} else {
  console.warn('WARNING: GROQ_API_KEY is not set. AI replies will run in fallback simulation.');
}

/**
 * Generates a natural human-like reply using Groq
 */
async function generateReply(messageText, senderName, chatHistory = [], contactVibe = 'friendly', personalityPrompt = '', customRules = '') {
  const defaultPrompt = "You are Ollie, a friendly and highly intelligent AI WhatsApp assistant created for Oliver. Keep replies casual, incredibly natural, and human-like. Never mention you are an AI or created by a tech company.";
  const systemPrompt = personalityPrompt || defaultPrompt;

  let historyContext = '';
  if (chatHistory && chatHistory.length > 0) {
    historyContext = chatHistory.map(h => {
      const parts = [];
      if (h.message_text) parts.push(`${senderName}: ${h.message_text}`);
      if (h.reply_text) parts.push(`Me (Ollie): ${h.reply_text}`);
      return parts.join('\n');
    }).join('\n\n');
  }

  let vibeInstruction = '';
  switch (contactVibe?.toLowerCase()) {
    case 'casual':
      vibeInstruction = 'Use casual text style, lowercase letters, short phrases, and emojis like a close friend.';
      break;
    case 'formal':
      vibeInstruction = 'Use polite, elegant, grammatically correct language. Maintain respectful greetings.';
      break;
    case 'friendly':
      vibeInstruction = 'Be warm, highly enthusiastic, helpful, and use welcoming emojis like 😊 or 🙌.';
      break;
    case 'professional':
      vibeInstruction = 'Be brief, highly professional, direct, and outcome-oriented.';
      break;
    case 'urgent':
      vibeInstruction = 'Keep your reply extremely short, direct, reassuring, and immediate.';
      break;
    case 'romantic':
      vibeInstruction = 'Use affectionate, highly caring language and sweet emojis (e.g., ❤️, 😊).';
      break;
    case 'business':
      vibeInstruction = 'Be structured, goal-focused, and talk about scheduling or efficiency.';
      break;
    case 'playful':
      vibeInstruction = 'Use teasing, light-hearted humor, and funny jokes or banter.';
      break;
    case 'angry':
      vibeInstruction = 'Stay extremely safe, soothing, diplomatic, and understanding. Defuse their anger immediately.';
      break;
    default:
      vibeInstruction = 'Respond naturally matching the user\'s tone.';
  }

  const prompt = `
System Rules:
${systemPrompt}

Oliver's Custom Rules for Ollie:
${customRules || 'No special rules pasted yet. Just follow standard helpful assistant guidelines.'}

Current Vibe Style for this contact: ${contactVibe}
Instruction: ${vibeInstruction}

CRITICAL RULES:
1. You are Ollie, Oliver's personal assistant. NEVER break character.
2. Keep replies short (1-2 sentences maximum) as typical for a WhatsApp chat.
3. Match the tone of the sender perfectly.
4. Do not include any tags, headers, or prefixes. Just output the clean raw chat message to send.

Recent Chat History:
${historyContext || 'No previous history.'}

New Message:
From: ${senderName}
Message: "${messageText}"

Write Ollie's WhatsApp reply now (do not wrap in quotes or add greetings unless natural):`;

  if (!groq) {
    return generateFallbackReply(messageText, senderName, contactVibe);
  }

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are Ollie, replying to a WhatsApp message for your owner Oliver.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.85,
      max_tokens: 150
    });

    let reply = chatCompletion.choices[0]?.message?.content || '';
    reply = reply.trim().replace(/^"|"$/g, '');
    return reply;
  } catch (err) {
    console.error('Error generating AI reply from Groq:', err.message);
    return generateFallbackReply(messageText, senderName, contactVibe);
  }
}

/**
 * Detects the vibe of an incoming message as a single word
 */
async function detectVibe(messageText) {
  const prompt = `
Analyze the vibe of the following WhatsApp message and classify it into EXACTLY ONE of these words:
casual, formal, friendly, professional, urgent, romantic, business, playful, angry.

Message: "${messageText}"

Return ONLY the single word in lowercase. Do not write any other text, explanation, or punctuation.`;

  if (!groq) {
    return detectFallbackVibe(messageText);
  }

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 10
    });

    let vibe = chatCompletion.choices[0]?.message?.content || '';
    vibe = vibe.trim().toLowerCase().replace(/[^a-z]/g, '');
    
    const allowedVibes = ['casual', 'formal', 'friendly', 'professional', 'urgent', 'romantic', 'business', 'playful', 'angry'];
    if (allowedVibes.includes(vibe)) {
      return vibe;
    }
    return 'friendly';
  } catch (err) {
    console.error('Error detecting vibe from Groq:', err.message);
    return detectFallbackVibe(messageText);
  }
}

function generateFallbackReply(messageText, senderName, vibe) {
  const lower = messageText.toLowerCase();
  if (lower.includes('hello') || lower.includes('hey') || lower.includes('hi')) {
    return `Hey ${senderName}! Ollie here. Hope you are doing great! What's up?`;
  }
  if (lower.includes('poster') || lower.includes('flyer') || lower.includes('brochure')) {
    return `Absolutely! I am sending you the poster right away. Let me know if you need anything else!`;
  }
  return `Thanks for the message! Let me check on this and get back to you in a little bit.`;
}

function detectFallbackVibe(messageText) {
  const lower = messageText.toLowerCase();
  if (lower.includes('urgent') || lower.includes('asap')) return 'urgent';
  if (lower.includes('sincerely') || lower.includes('dear')) return 'formal';
  return 'friendly';
}

module.exports = {
  generateReply,
  detectVibe
};
