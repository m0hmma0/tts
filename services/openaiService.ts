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

        // OpenAI Quota or Rate Limit (429)
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

export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  if (!speaker) return text;
  // Note: OpenAI TTS doesn't use "system instructions" for style, 
  // so we keep the text clean but we can add subtle phonetic hints if needed.
  // For now, we return text as-is and handle speed via API parameter.
  return text;
};

// --- Exported Functions ---

export const generateLineAudio = async (voice: string, text: string, speaker?: Speaker): Promise<string> => {
  return executeWithRetryAndRotation(async (client) => {
    const response = await client.audio.speech.create({
      model: "tts-1",
      voice: voice as any,
      input: text,
      response_format: "pcm", // 24kHz 16-bit PCM
      speed: mapSpeedToNumeric(speaker?.speed),
    });

    const buffer = await response.arrayBuffer();
    // Convert ArrayBuffer to Base64 for the existing app architecture
    const uint8 = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  });
};