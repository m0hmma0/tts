
import OpenAI from "openai";
import { Speaker } from "../types";

// --- API Key Management ---

// @ts-ignore - injected by Vite
const API_KEYS: string[] = process.env.API_KEY_POOL || [];

let currentKeyIndex = 0;

const getClient = (): OpenAI => {
  const key = API_KEYS[currentKeyIndex];
  if (!key) throw new Error("No API Key available.");
  return new OpenAI({ 
    apiKey: key,
    dangerouslyAllowBrowser: true // Required for client-side usage
  });
};

const rotateKey = () => {
  if (API_KEYS.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`Switching OpenAI Key to index: ${currentKeyIndex}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeWithRetryAndRotation<T>(
  operation: (client: OpenAI) => Promise<T>,
  retries = 2,
  delay = 1000
): Promise<T> {
  const keysCount = Math.max(1, API_KEYS.length);
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (let k = 0; k < keysCount; k++) {
      try {
        const client = getClient();
        return await operation(client);
      } catch (error: any) {
        const status = error?.status || error?.code;
        const msg = error?.message || "";

        if (status === 429 || msg.toLowerCase().includes("quota")) {
          rotateKey();
          continue;
        }

        if ((status === 500 || status === 503) && attempt < retries) break;
        throw error;
      }
    }
    if (attempt < retries) await sleep(delay * Math.pow(2, attempt));
  }
  throw new Error("Failed after exhausting retries and keys.");
}

// --- Helper Utilities ---

const mapSpeedToNumeric = (speed?: string): number => {
  switch (speed) {
    case 'Very Slow': return 0.5;
    case 'Slow': return 0.8;
    case 'Fast': return 1.2;
    case 'Very Fast': return 1.5;
    default: return 1.0;
  }
};

/**
 * Injects hints into the text to help OpenAI's TTS interpret tone/accent.
 * While OpenAI TTS-1 doesn't officially support 'emotions', providing context
 * in brackets or prepending descriptors can sometimes influence the model.
 */
export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  if (!speaker) return text;
  
  let processedText = text;
  
  // Handle directions in parentheses (e.g. "(excitedly)")
  // We keep them in the text for OpenAI to "read" the context, 
  // but we can also prepend them explicitly if they aren't already there.
  
  const hints: string[] = [];
  if (speaker.accent && speaker.accent !== 'Neutral') {
    hints.push(`Accent: ${speaker.accent}`);
  }

  if (hints.length > 0) {
    return `[${hints.join(', ')}] ${processedText}`;
  }

  return processedText;
};

// --- Exported Functions ---

export const generateLineAudio = async (voice: string, text: string, speaker?: Speaker): Promise<string> => {
  return executeWithRetryAndRotation(async (client) => {
    // We pass the formatted text which includes hints for accent/directions
    const input = formatPromptWithSettings(text, speaker);
    
    const response = await client.audio.speech.create({
      model: "tts-1",
      voice: voice as any,
      input: input,
      response_format: "pcm", // 24kHz 16-bit PCM
      speed: mapSpeedToNumeric(speaker?.speed),
    });

    const buffer = await response.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  });
};
