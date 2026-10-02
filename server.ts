import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Modality } from '@google/genai';
import { calculateLifePath, calculatePersonalVibrations, LIFE_PATH_DETAILS, formatMarkdownReading, sanitizeMarkdownReading } from './src/utils/numerology.js';

// Load environment variables from .env.local and .env
dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Helper: Convert raw 16-bit mono PCM to standard 24kHz WAV buffer
function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
  const header = Buffer.alloc(44);
  const dataLength = pcmBuffer.length;
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// In-memory cache for synthesized voice audio to keep playback snappy and reduce API calls
const ttsAudioCache = new Map<string, string>();
// Cooldown timestamp if TTS daily free tier quota is reached (10 requests/day on free tier)
let ttsQuotaCooldownUntil = 0;

// Lazy initializer for Gemini SDK to prevent crash if key is absent
let aiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== 'MY_GEMINI_API_KEY') {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
  }
  return aiClient;
}

// 1. API: Calculate Life Path & Generate Intuitive Reading
app.post('/api/numerology/reading', async (req, res) => {
  try {
    const { name, birthDate, survey } = req.body;
    if (!birthDate) {
      return res.status(400).json({ error: 'birthDate (MM/DD/YYYY) is required.' });
    }

    const trace = calculateLifePath(birthDate);
    const detail = LIFE_PATH_DETAILS[trace.finalLifePath] || LIFE_PATH_DETAILS[1];
    const baseReading = formatMarkdownReading(name, birthDate, detail, trace, survey);

    const ai = getGemini();
    if (!ai) {
      // Fallback deterministic reading
      return res.json({ reading: baseReading, trace });
    }

    // Enhance reading via Gemini 3.6 Flash for deeply personalized intuitive guidance
    const prompt = `
You are an expert Numerologist and Intuitive Guide 🔮. Provide an insightful, deeply empathetic, and practical Life Path reading based on the user's details.

User Name: ${name || 'Honored Soul'}
Birth Date: ${birthDate}
Calculated Life Path Number: ${trace.finalLifePath} (${detail.title})
Calculation Trace: ${trace.explanation}
Intake Survey Details:
- Focus Area: ${survey?.focusArea || 'general life alignment'}
- Current Energy Level: ${survey?.energyLevel || 'balanced'}
- Current Challenge: ${survey?.currentChallenge || 'finding focus and purpose'}
- Intention: ${survey?.intention || 'peace, prosperity, and cosmic growth'}

CRITICAL INSTRUCTIONS:
Follow this exact response structure in clean Markdown:

1. **Life Path Summary** 🌟: Introduce the primary Life Path number and its core vibration.
   - For the calculation breakdown section, write a clean, simple, human-friendly sentence (e.g. "Born on ${trace.rawDate}: Month ${trace.month} reduces to ${trace.monthReduced}, Day ${trace.day} reduces to ${trace.dayReduced}, Year ${trace.year} reduces to ${trace.yearReduced} → ${trace.monthReduced} + ${trace.dayReduced} + ${trace.yearReduced} = ${trace.stepSum} → Life Path ${trace.finalLifePath}.").
   - STRICT PROHIBITION: NEVER use dollar signs ($ or $$), LaTeX syntax, backslashes, equation symbols, or robotic math terms. Keep it entirely plain English and conversational.
2. **Core Strengths & Superpowers** 💪: Highlight 3 key natural talents specifically tailored to their life path and intent.
3. **Growth Areas & Challenges** 🏔️: Explain 2 potential obstacles and how to overcome them with cosmic remedies.
4. **Actionable Cosmic Guidance** 🧘: Provide 1-2 daily practices aligned with their number and intention.

TONE: Warm, compassionate, empowering, soothing, professional yet deeply empathetic.
`;

    const aiRes = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        temperature: 0.7,
      },
    });

    const aiMarkdown = sanitizeMarkdownReading(aiRes.text || baseReading.markdownContent);
    const finalReading = {
      ...baseReading,
      markdownContent: aiMarkdown,
    };

    return res.json({ reading: finalReading, trace });
  } catch (err: any) {
    console.error('Error in /api/numerology/reading:', err);
    // Return fallback reading on error
    const trace = calculateLifePath(req.body.birthDate || '01/01/2000');
    const detail = LIFE_PATH_DETAILS[trace.finalLifePath] || LIFE_PATH_DETAILS[1];
    const baseReading = formatMarkdownReading(req.body.name, req.body.birthDate, detail, trace, req.body.survey);
    return res.json({ reading: baseReading, trace, warning: 'Generated using local engine fallback.' });
  }
});

// 2. API: Daily Horoscope & Numerology Transit Forecast
app.post('/api/horoscope/daily', async (req, res) => {
  try {
    const { birthDate, lifePathNumber } = req.body;
    const dateObj = new Date();
    const dateStr = dateObj.toISOString().split('T')[0];
    
    let lpNum = Number(lifePathNumber);
    if (!lpNum || isNaN(lpNum)) {
      const trace = calculateLifePath(birthDate || '01/01/2000');
      lpNum = trace.finalLifePath;
    }

    const vibrations = calculatePersonalVibrations(birthDate || '01/01/2000', dateObj);
    const detail = LIFE_PATH_DETAILS[lpNum as keyof typeof LIFE_PATH_DETAILS] || LIFE_PATH_DETAILS[1];

    const ai = getGemini();
    if (!ai) {
      // Deterministic Daily Horoscope fallback
      return res.json({
        horoscope: {
          date: dateStr,
          lifePathNumber: lpNum,
          personalDayNumber: vibrations.personalDay,
          personalMonthNumber: vibrations.personalMonth,
          personalYearNumber: vibrations.personalYear,
          vibrationTheme: `Day of Personal Energy ${vibrations.personalDay}`,
          cosmicOverview: `Today carries a Personal Day ${vibrations.personalDay} vibration for Life Path ${lpNum}. Focus on grounding your intentions and taking intentional action aligned with ${detail.element} energy.`,
          keyAdvice: `Trust your intuition and maintain steady focus on your priority goals.`,
          luckyColor: vibrations.personalDay % 2 === 0 ? 'Emerald Green' : 'Solar Amber',
          luckyNumber: vibrations.personalDay,
          bestTimeOfDay: '11:11 AM',
          mindfulAffirmation: `I am aligned with the divine rhythm of my cosmic life path.`
        }
      });
    }

    const prompt = `
Generate a personalized Daily Horoscope & Numerology Transit for today (${dateStr}).
- User's Life Path Number: ${lpNum} (${detail.title})
- Personal Year: ${vibrations.personalYear}
- Personal Month: ${vibrations.personalMonth}
- Personal Day: ${vibrations.personalDay}

Return JSON with exact structure:
{
  "vibrationTheme": "Short theme phrase (e.g. Masterful Expression & Intuitive Focus)",
  "cosmicOverview": "2-3 sentences explaining today's planetary and personal day vibration.",
  "keyAdvice": "1 actionable cosmic piece of advice for today.",
  "luckyColor": "Color name",
  "luckyNumber": integer,
  "bestTimeOfDay": "Time string e.g. 2:44 PM",
  "mindfulAffirmation": "Direct empowering affirmation string"
}
`;

    const aiRes = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(aiRes.text || '{}');
    return res.json({
      horoscope: {
        date: dateStr,
        lifePathNumber: lpNum,
        personalDayNumber: vibrations.personalDay,
        personalMonthNumber: vibrations.personalMonth,
        personalYearNumber: vibrations.personalYear,
        vibrationTheme: parsed.vibrationTheme || `Personal Day ${vibrations.personalDay} Alignment`,
        cosmicOverview: parsed.cosmicOverview || `Embrace today's ${vibrations.personalDay} vibration to activate your inner potential.`,
        keyAdvice: parsed.keyAdvice || `Stay focused on what brings long-term peace and clarity.`,
        luckyColor: parsed.luckyColor || 'Celestial Gold',
        luckyNumber: parsed.luckyNumber || vibrations.personalDay,
        bestTimeOfDay: parsed.bestTimeOfDay || '10:00 AM',
        mindfulAffirmation: parsed.mindfulAffirmation || 'I step forward into my power with confidence.'
      }
    });
  } catch (err: any) {
    console.error('Error in /api/horoscope/daily:', err);
    // Graceful fallback daily horoscope
    const { birthDate, lifePathNumber } = req.body || {};
    const dateObj = new Date();
    const dateStr = dateObj.toISOString().split('T')[0];
    let lpNum = Number(lifePathNumber);
    if (!lpNum || isNaN(lpNum)) {
      const trace = calculateLifePath(birthDate || '01/01/2000');
      lpNum = trace.finalLifePath;
    }
    const vibrations = calculatePersonalVibrations(birthDate || '01/01/2000', dateObj);
    const detail = LIFE_PATH_DETAILS[lpNum as keyof typeof LIFE_PATH_DETAILS] || LIFE_PATH_DETAILS[1];
    return res.json({
      horoscope: {
        date: dateStr,
        lifePathNumber: lpNum,
        personalDayNumber: vibrations.personalDay,
        personalMonthNumber: vibrations.personalMonth,
        personalYearNumber: vibrations.personalYear,
        vibrationTheme: `Day of Personal Energy ${vibrations.personalDay}`,
        cosmicOverview: `Today carries a Personal Day ${vibrations.personalDay} vibration for Life Path ${lpNum}. Focus on grounding your intentions and taking intentional action aligned with ${detail.element} energy.`,
        keyAdvice: `Trust your intuition and maintain steady focus on your priority goals.`,
        luckyColor: vibrations.personalDay % 2 === 0 ? 'Emerald Green' : 'Solar Amber',
        luckyNumber: vibrations.personalDay,
        bestTimeOfDay: '11:11 AM',
        mindfulAffirmation: `I am aligned with the divine rhythm of my cosmic life path.`
      }
    });
  }
});

// 3. API: Intuitive Oracle Chat (Gemini 3.8 Flash)
app.post('/api/gemini/chat', async (req, res) => {
  try {
    const { messages, userProfile } = req.body;
    const ai = getGemini();

    if (!ai) {
      return res.json({
        reply: "🔮 I am your Intuitive Guide. Add your GEMINI_API_KEY in the Secrets panel to activate deep AI live guidance! In the meantime, trust your inner Life Path wisdom and intuition."
      });
    }

    const systemInstruction = `
You are an expert Numerologist, Mystic, and Intuitive Guide 🔮.
User Context:
- Name: ${userProfile?.name || 'Seeker'}
- Birth Date: ${userProfile?.birthDate || 'Not specified'}
- Life Path Number: ${userProfile?.lifePathNumber || 'Not calculated yet'}

Tone: Warm, empathetic, uplifting, wise, and practical.
Format your responses neatly using Markdown formatting, bullet points where helpful, and subtle cosmic emojis. Never do doom-and-gloom; always empower the user with actionable spiritual and practical wisdom.
`;

    // Format chat history
    const contents = (messages || []).map((m: any) => ({
      role: m.sender === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    }));

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: contents,
      config: {
        systemInstruction,
        temperature: 0.7,
      }
    });

    return res.json({ reply: response.text });
  } catch (err: any) {
    console.error('Error in /api/gemini/chat:', err);
    return res.json({
      reply: "🔮 *The cosmic energies are aligning softly.* Take a deep, mindful breath and trust your inner compass. Feel free to ask your question again in a moment."
    });
  }
});

// Helper function for curated high-definition cosmic vision fallback artwork
const FALLBACK_VISION_GALLERY: Record<string, string[]> = {
  wealth: [
    'https://images.unsplash.com/photo-1518241353330-0f7941c2d9b5?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=1200&q=80',
  ],
  love: [
    'https://images.unsplash.com/photo-1518199266791-5375a83190b7?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=80',
  ],
  health: [
    'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=1200&q=80',
  ],
  spiritual: [
    'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1531306728370-e2ebd9d7bb99?auto=format&fit=crop&w=1200&q=80',
  ],
  creative: [
    'https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?auto=format&fit=crop&w=1200&q=80',
  ],
  cosmic: [
    'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=1200&q=80',
  ],
};

function getFallbackVisionImage(promptStr: string = ''): string {
  const p = promptStr.toLowerCase();
  let key = 'cosmic';
  if (p.includes('wealth') || p.includes('money') || p.includes('abundance') || p.includes('financial')) {
    key = 'wealth';
  } else if (p.includes('love') || p.includes('soulmate') || p.includes('heart') || p.includes('partner')) {
    key = 'love';
  } else if (p.includes('health') || p.includes('body') || p.includes('vitality') || p.includes('wellness')) {
    key = 'health';
  } else if (p.includes('spiritual') || p.includes('peace') || p.includes('meditation') || p.includes('soul')) {
    key = 'spiritual';
  } else if (p.includes('creative') || p.includes('art') || p.includes('expression') || p.includes('studio')) {
    key = 'creative';
  }

  const pool = FALLBACK_VISION_GALLERY[key] || FALLBACK_VISION_GALLERY.cosmic;
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex];
}

// 4. API: Generate Cosmic Goal Vision Board Artwork (Nano Banana / Gemini Flash Image with Curated Fallback)
app.post('/api/vision/generate-image', async (req, res) => {
  const { prompt = '', aspectRatio } = req.body;
  try {
    const ai = getGemini();

    if (!ai) {
      // Return high quality curated fallback image if API key is not configured
      const fallbackUrl = getFallbackVisionImage(prompt);
      return res.json({ imageUrl: fallbackUrl, note: 'Using curated cosmic vision gallery.' });
    }

    const validAspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'];
    const selectedRatio = validAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1';

    const imagePrompt = `A stunning, high quality cosmic vision art, ethereal manifestation aesthetic: ${prompt}. Celestial colors, sacred geometry, glowing starlight, high resolution art.`;

    const aiRes = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-image',
      contents: {
        parts: [{ text: imagePrompt }]
      },
      config: {
        imageConfig: {
          aspectRatio: selectedRatio as any,
        }
      }
    });

    let imageUrl = '';
    const parts = aiRes.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
        break;
      }
    }

    if (!imageUrl) {
      const fallbackUrl = getFallbackVisionImage(prompt);
      return res.json({ imageUrl: fallbackUrl, note: 'Using curated cosmic vision gallery.' });
    }

    return res.json({ imageUrl });
  } catch (err: any) {
    console.log('Image generation API quota limit reached; smoothly serving curated vision artwork fallback.');
    // Graceful fallback on quota exceeded / rate limits
    const fallbackUrl = getFallbackVisionImage(prompt);
    return res.json({
      imageUrl: fallbackUrl,
      note: 'Serving curated high-definition cosmic vision artwork.'
    });
  }
});

// 5. API: High-Fidelity Gemini AI Text-to-Speech Engine (gemini-3.1-flash-tts-preview)
app.post('/api/gemini/tts', async (req, res) => {
  try {
    const { text, voice = 'Kore' } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Valid text is required for voice synthesis.' });
    }

    let cleanText = text
      .replace(/\*{1,3}/g, ' ')
      .replace(/_{1,3}/g, ' ')
      .replace(/#+\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanText) {
      return res.status(400).json({ error: 'Text string is empty.' });
    }

    // If TTS daily quota is currently in cooldown, immediately use client device fallback
    if (Date.now() < ttsQuotaCooldownUntil) {
      return res.json({
        fallback: true,
        reason: 'quota_cooldown',
        message: 'Gemini TTS daily quota limit reached; using high-quality device synthesis fallback.',
      });
    }

    // Allow full chunks up to 1200 characters for natural speech
    const trimmed = cleanText.length > 1200 ? cleanText.slice(0, 1200) : cleanText;
    const cacheKey = `${voice}_${trimmed}`;

    if (ttsAudioCache.has(cacheKey)) {
      return res.json({
        audioUrl: ttsAudioCache.get(cacheKey),
        source: 'cache',
        voice,
      });
    }

    const ai = getGemini();
    if (!ai) {
      return res.json({
        error: 'Gemini API not initialized.',
        fallback: true,
        message: 'Using device speech engine fallback.'
      });
    }

    const validVoices = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir'];
    const chosenVoice = validVoices.includes(voice) ? voice : 'Kore';

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{ parts: [{ text: trimmed }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: chosenVoice },
          },
        },
      },
    });

    const base64Data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Data) {
      return res.json({ error: 'No audio data returned from Gemini TTS', fallback: true });
    }

    // Convert 24kHz 16-bit mono PCM into standard WAV
    const pcmBuffer = Buffer.from(base64Data, 'base64');
    const wavBuffer = pcmToWav(pcmBuffer, 24000, 1, 16);
    const audioDataUrl = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;

    // Cache the result (keep max 120 items in memory)
    if (ttsAudioCache.size > 120) {
      const firstKey = ttsAudioCache.keys().next().value;
      if (firstKey) ttsAudioCache.delete(firstKey);
    }
    ttsAudioCache.set(cacheKey, audioDataUrl);

    return res.json({
      audioUrl: audioDataUrl,
      source: 'gemini-3.1-flash-tts-preview',
      voice: chosenVoice,
    });
  } catch (err: any) {
    const errStr = String(err?.message || err || '');
    const isQuotaOrRateLimit =
      errStr.includes('429') ||
      errStr.includes('RESOURCE_EXHAUSTED') ||
      errStr.includes('quota') ||
      errStr.includes('Quota');

    if (isQuotaOrRateLimit) {
      // Cooldown for 1 hour so subsequent calls seamlessly use device speech synthesis immediately
      ttsQuotaCooldownUntil = Date.now() + 60 * 60 * 1000;
      console.log('Gemini TTS daily quota reached (free tier); gracefully activating device speech synthesis fallback.');
      return res.json({
        fallback: true,
        reason: 'quota_exhausted',
        message: 'TTS daily limit reached, seamlessly using device voice synthesis.',
      });
    }

    console.log('Gemini TTS synthesis error; falling back to device audio:', err?.message || err);
    return res.json({
      fallback: true,
      error: err?.message || 'Failed to synthesize Gemini AI audio',
      reason: 'synthesis_fallback'
    });
  }
});

// Payout and subscription revenue endpoints
const PAYOUT_FILE = path.join(process.cwd(), 'payout_config.json');

app.get('/api/subscription/payout-config', (req, res) => {
  try {
    if (fs.existsSync(PAYOUT_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAYOUT_FILE, 'utf-8'));
      return res.json({ success: true, config: data });
    }
  } catch {}
  return res.json({
    success: true,
    config: {
      stripeMonthlyLink: process.env.STRIPE_MONTHLY_LINK || '',
      stripeAnnualLink: process.env.STRIPE_ANNUAL_LINK || '',
      stripeLifetimeLink: process.env.STRIPE_LIFETIME_LINK || '',
      paypalUsername: process.env.PAYPAL_USERNAME || '',
      cashAppHandle: process.env.CASHAPP_HANDLE || '',
      venmoHandle: process.env.VENMO_HANDLE || '',
      payoutEmail: process.env.PAYOUT_EMAIL || '',
      currency: 'USD',
      isConfigured: false,
    },
  });
});

app.post('/api/subscription/payout-config', (req, res) => {
  try {
    const config = req.body || {};
    fs.writeFileSync(PAYOUT_FILE, JSON.stringify(config, null, 2), 'utf-8');
    return res.json({ success: true, config });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to save payout config' });
  }
});

app.post('/api/subscription/checkout', (req, res) => {
  try {
    const { planId = 'annual', provider = 'stripe' } = req.body || {};
    let config: any = {};
    if (fs.existsSync(PAYOUT_FILE)) {
      try { config = JSON.parse(fs.readFileSync(PAYOUT_FILE, 'utf-8')); } catch {}
    }

    if (provider === 'stripe') {
      const link = planId === 'monthly' ? config.stripeMonthlyLink : (planId === 'lifetime' ? config.stripeLifetimeLink : config.stripeAnnualLink);
      if (link) {
        return res.json({ success: true, checkoutUrl: link, provider: 'stripe' });
      }
    } else if (provider === 'paypal' && config.paypalUsername) {
      const amt = planId === 'monthly' ? '9.99' : (planId === 'lifetime' ? '99.00' : '59.88');
      const cleanUser = config.paypalUsername.replace(/^@/, '').trim();
      return res.json({
        success: true,
        checkoutUrl: `https://www.paypal.com/paypalme/${cleanUser}/${amt}USD`,
        provider: 'paypal',
      });
    }

    return res.json({
      success: true,
      demo: true,
      message: 'Instant demo activation ready',
      planId,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Checkout failed' });
  }
});

// Start Express + Vite setup
async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✨ Numerology & Life Path Guide Server running on http://localhost:${PORT}`);
  });
}

startServer();
