
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
    dangerouslyAllowBrowser: true 
  });
};

const rotateKey = () => {
  if (API_KEYS.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
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
 * Enhanced prompt formatting.
 * Keeps emotions (parentheses) and directions [brackets] as context for the model.
 */
export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  let context = "";
  if (speaker?.accent && speaker.accent !== 'Neutral') {
    context += `[Accent: ${speaker.accent}] `;
  }
  
  // We keep the original text because it contains the user's (emotion) and [direction] tags.
  // The GPT-4o Mini TTS model uses these as non-verbal cues for tone generation.
  return context + text;
};

// --- Exported Functions ---

export const generateLineAudio = async (voice: string, text: string, speaker?: Speaker): Promise<string> => {
  return executeWithRetryAndRotation(async (client) => {
    const input = formatPromptWithSettings(text, speaker);
    
    const response = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voice as any,
      input: input,
      response_format: "pcm",
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
