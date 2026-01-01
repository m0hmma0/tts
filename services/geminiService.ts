
import { GoogleGenAI, Modality } from "@google/genai";
import { Speaker } from "../types";

// --- API Key Management ---

// @ts-ignore - injected by Vite
const rawPool = process.env.API_KEY_POOL;
let API_KEYS: string[] = [];

if (Array.isArray(rawPool)) {
  API_KEYS = rawPool;
} else if (typeof rawPool === 'string') {
  try {
    const parsed = JSON.parse(rawPool);
    if (Array.isArray(parsed)) API_KEYS = parsed;
  } catch (e) {
    if (rawPool.length > 10) API_KEYS = [rawPool];
  }
}

if (API_KEYS.length === 0 && process.env.API_KEY) {
  API_KEYS.push(process.env.API_KEY);
}

API_KEYS = [...new Set(API_KEYS.filter(k => !!k && k.trim().length > 0))];

// --- DEBUG LOGGING ---
if (API_KEYS.length === 0) {
    console.error("%c[Gemini Service] CRITICAL: No API Keys found!", "color: red; font-weight: bold; font-size: 14px;");
} else {
    console.log(`%c[Gemini Service] Loaded ${API_KEYS.length} API key(s).`, "color: green; font-weight: bold;");
}
// ---------------------

let currentKeyIndex = 0;

const getClient = (): GoogleGenAI => {
  if (API_KEYS.length === 0) {
    throw new Error("No API Keys configured. Please redeploy your application to update environment variables.");
  }
  const key = API_KEYS[currentKeyIndex];
  return new GoogleGenAI({ apiKey: key });
};

const rotateKey = () => {
  if (API_KEYS.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`[Gemini Service] Rotated API Key to index ${currentKeyIndex}`);
};

// --- Rate Limiter ---

class RateLimiter {
  private lastCallTime: number = 0;
  // Reduced to 4000ms (4s) to prevent "frozen" feeling, relying on 429 handling for backoff
  private minInterval: number = 4000; 

  async wait(onStatus?: (msg: string) => void) {
    const now = Date.now();
    const timeSinceLast = now - this.lastCallTime;
    
    if (timeSinceLast < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLast;
      if (onStatus) onStatus(`Throttling (${Math.ceil(waitTime/1000)}s)...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.lastCallTime = Date.now();
  }
}

const globalRateLimiter = new RateLimiter();

// --- Helper Utilities ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeWithRetryAndRotation<T>(
  operation: (ai: GoogleGenAI) => Promise<T>,
  retries = 10,
  onStatus?: (msg: string) => void
): Promise<T> {
  const keysCount = Math.max(1, API_KEYS.length);
  const maxAttempts = retries * keysCount + 20; 
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await globalRateLimiter.wait(onStatus);
      if (onStatus) onStatus("Sending request...");
      
      const ai = getClient();
      return await operation(ai);
    } catch (error: any) {
      const status = error?.status || error?.code;
      const msg = error?.message || "";

      // 400 Bad Request (Invalid API Key, Invalid Prompt) should NOT be retried
      if (status === 400 || msg.includes("INVALID_ARGUMENT") || msg.includes("API_KEY_INVALID")) {
         throw new Error(`API Error (Non-retriable): ${msg}`);
      }

      console.warn(`[Gemini Service] Attempt ${attempt + 1}/${maxAttempts} failed: ${msg}`);

      const isQuotaError = 
        status === 429 || 
        msg.includes("429") || 
        msg.includes("quota") || 
        msg.includes("resource_exhausted");

      if (isQuotaError) {
        if (API_KEYS.length > 1) {
          if (onStatus) onStatus("Quota hit. Rotating key...");
          rotateKey();
          await sleep(2000); 
          continue;
        } else {
          // Exponential backoff
          const attemptWithinKey = attempt; 
          const backoff = Math.min(30000, 5000 * Math.pow(1.5, attemptWithinKey)); 
          const seconds = Math.round(backoff / 1000);
          
          if (onStatus) onStatus(`Quota limit hit. Cooling down for ${seconds}s...`);
          console.log(`[Gemini Service] Quota limit (429). Waiting ${seconds}s before retry...`);
          
          await sleep(backoff);
          continue;
        }
      }

      const isServerError = status === 503 || status === 500;
      if (isServerError && attempt < maxAttempts - 1) {
         if (onStatus) onStatus("Server error. Retrying in 5s...");
         await sleep(5000);
         continue;
      }
      throw error;
    }
  }
  throw new Error("Failed to generate content after exhausting all retries and API keys.");
}

export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  if (!speaker) return text;

  const contextParts: string[] = [];

  if (speaker.instructions && speaker.instructions.trim()) {
    contextParts.push(`Persona instructions: ${speaker.instructions.trim()}`);
  }

  const specificDirections: string[] = [];
  if (speaker.speed && speaker.speed !== 'Normal') {
    specificDirections.push(`speaking ${speaker.speed.toLowerCase()}`);
  }
  if (speaker.accent && speaker.accent !== 'Neutral') {
    specificDirections.push(`${speaker.accent} accent`);
  }

  if (specificDirections.length > 0) {
    contextParts.push(`Direction: (${specificDirections.join(', ')})`);
  }

  if (contextParts.length === 0) {
    return text;
  }

  return `[${contextParts.join(' | ')}] ${text}`;
};

export const generateSpeech = async (
  script: string,
  speakers: Speaker[]
): Promise<string | undefined> => {
  
  const speakerVoiceConfigs = speakers.map((s) => ({
    speaker: s.name,
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: s.voice },
    },
  }));

  const hasMultipleSpeakers = speakers.length > 0;
  let speechConfig = hasMultipleSpeakers ? {
    multiSpeakerVoiceConfig: {
      speakerVoiceConfigs: speakerVoiceConfigs,
    },
  } : {
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: 'Kore' },
    },
  };

  return executeWithRetryAndRotation(async (ai) => {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: script }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: speechConfig,
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error("No audio data returned from the model.");
    }
    return base64Audio;
  });
};

export const previewSpeakerVoice = async (
  voiceName: string, 
  text?: string,
  onStatusUpdate?: (msg: string) => void
): Promise<string> => {
  return executeWithRetryAndRotation(async (ai) => {
    const promptText = text || `Hello! I am ${voiceName}, and I'm ready to read your script.`;
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: promptText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error("No audio data returned for preview.");
    }
    return base64Audio;
  }, 10, onStatusUpdate);
};
