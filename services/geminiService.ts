
import { GoogleGenAI, Modality } from "@google/genai";
import { Speaker } from "../types";

// --- API Key Management ---

// Parse the pool correctly as JSON, with fallback
// @ts-ignore - injected by Vite
const rawPool = process.env.API_KEY_POOL;
let API_KEYS: string[] = [];
try {
  API_KEYS = typeof rawPool === 'string' ? JSON.parse(rawPool) : [];
} catch (e) {
  console.error("Failed to parse API_KEY_POOL", e);
  API_KEYS = [];
}

let currentKeyIndex = 0;

const getClient = (): GoogleGenAI => {
  if (API_KEYS.length === 0) {
    throw new Error("No API Keys available in configuration.");
  }
  const key = API_KEYS[currentKeyIndex];
  return new GoogleGenAI({ apiKey: key });
};

const rotateKey = () => {
  if (API_KEYS.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`Rotated API Key to index ${currentKeyIndex}`);
};

// --- Rate Limiter ---

class RateLimiter {
  private lastCallTime: number = 0;
  private minInterval: number = 7000; // 7 seconds between calls (approx 8.5 RPM)

  async wait() {
    const now = Date.now();
    const timeSinceLast = now - this.lastCallTime;
    
    if (timeSinceLast < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLast;
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
  retries = 3
): Promise<T> {
  // If we have multiple keys, we can try more aggressively. 
  // If only 1 key, we must respect backoff strictly.
  const keysCount = Math.max(1, API_KEYS.length);
  const maxAttempts = retries * keysCount; 
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Enforce rate limit before every attempt
      await globalRateLimiter.wait();

      const ai = getClient();
      return await operation(ai);
    } catch (error: any) {
      const status = error?.status || error?.code;
      const msg = error?.message || "";

      console.warn(`API Attempt ${attempt + 1} failed: ${msg}`);

      const isQuotaError = 
        status === 429 || 
        msg.includes("429") || 
        msg.includes("quota") || 
        msg.includes("resource_exhausted");

      if (isQuotaError) {
        if (API_KEYS.length > 1) {
          rotateKey();
          // Short wait after rotation
          await sleep(1000); 
          continue;
        } else {
          // Exponential backoff if single key
          const backoff = 7000 * Math.pow(2, attempt); 
          console.log(`Quota hit (single key). Backing off for ${backoff}ms...`);
          await sleep(backoff);
          continue;
        }
      }

      const isServerError = status === 503 || status === 500;
      if (isServerError && attempt < maxAttempts - 1) {
         await sleep(2000);
         continue;
      }
      throw error;
    }
  }
  throw new Error("Failed to generate content after exhausting retries and API keys.");
}

/**
 * Enhanced helper to inject speaker settings and general instructions into the text prompt.
 */
export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  if (!speaker) return text;

  const contextParts: string[] = [];

  // 1. General Speaker Instructions (System/Persona level)
  if (speaker.instructions && speaker.instructions.trim()) {
    contextParts.push(`Persona instructions: ${speaker.instructions.trim()}`);
  }

  // 2. Specific Voice Directions
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

  // Combine instructions as a prefix block
  return `[${contextParts.join(' | ')}] ${text}`;
};

// --- Exported Functions ---

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

export const previewSpeakerVoice = async (voiceName: string, text?: string): Promise<string> => {
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
  });
};
