import { GoogleGenAI, Modality } from "@google/genai";
import { Speaker } from "../types";

// --- API Key Management ---

// Parse the injected key pool. 
// If for some reason the pool is empty (local dev without setup), fallback to an empty array.
// @ts-ignore - injected by Vite
const API_KEYS: string[] = process.env.API_KEY_POOL || [];

if (API_KEYS.length === 0) {
  console.warn("No API Keys found in environment variables (API_KEY_1...5 or API_KEY).");
}

// Track the current key index in memory
let currentKeyIndex = 0;

/**
 * gets a new instance of the AI client using the current active key.
 */
const getClient = (): GoogleGenAI => {
  const key = API_KEYS[currentKeyIndex];
  if (!key) {
    throw new Error("No API Key available.");
  }
  return new GoogleGenAI({ apiKey: key });
};

/**
 * Rotates to the next API key in the pool.
 */
const rotateKey = () => {
  if (API_KEYS.length <= 1) return; // No point rotating if only 1 key
  const prevIndex = currentKeyIndex;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`Switching API Key: Index ${prevIndex} -> ${currentKeyIndex}`);
};

// --- Helper Utilities ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes an AI operation with automatic key rotation on Quota errors (429)
 * and exponential backoff for other transient errors.
 */
async function executeWithRetryAndRotation<T>(
  operation: (ai: GoogleGenAI) => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  // We allow trying every key in the pool once per logical "attempt"
  const keysCount = Math.max(1, API_KEYS.length);
  
  // Outer loop: Standard retries (backoff)
  for (let attempt = 0; attempt <= retries; attempt++) {
    
    // Inner loop: Rotation (try all keys if we hit quota limits)
    for (let k = 0; k < keysCount; k++) {
      try {
        const ai = getClient();
        return await operation(ai);
      } catch (error: any) {
        const status = error?.status || error?.code;
        const msg = error?.message || "";

        // Check for Quota/Rate Limit issues
        const isQuotaError = 
          status === 429 || 
          msg.includes("429") || 
          msg.includes("quota") || 
          msg.includes("resource_exhausted");

        if (isQuotaError) {
          console.warn(`Quota exceeded on key index ${currentKeyIndex}. Rotating...`);
          rotateKey();
          // Continue inner loop to try next key immediately
          continue;
        }

        // Check for transient server errors (503, 500) that might be worth waiting for
        const isServerError = status === 503 || status === 500;

        // If it's a server error and we haven't exhausted outer retries, break inner loop 
        // to hit the sleep() below, then retry.
        if (isServerError && attempt < retries) {
           console.warn(`Server error ${status}. Waiting...`);
           break; // Break inner loop, wait, then retry (possibly with same key)
        }

        // If it's a client error (400) or we are out of options, throw.
        throw error;
      }
    }

    // If we are here, we broke out of inner loop due to Server Error (or we exhausted keys but logic fell through)
    // Wait before outer retry
    if (attempt < retries) {
      await sleep(delay * Math.pow(2, attempt)); // Exponential backoff
    }
  }

  throw new Error("Failed to generate content after exhausting retries and API keys.");
}

/**
 * Helper to inject speaker settings (accent, speed) into the text prompt as stage directions.
 */
export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  if (!speaker) return text;

  const directions: string[] = [];

  // Handle Speed
  if (speaker.speed && speaker.speed !== 'Normal') {
    directions.push(`speaking ${speaker.speed.toLowerCase()}`);
  }

  // Handle Accent
  if (speaker.accent && speaker.accent !== 'Neutral') {
    directions.push(`${speaker.accent} accent`);
  }

  if (directions.length === 0) {
    return text;
  }

  // Combine directions
  const directionString = `(${directions.join(', ')})`;
  return `${directionString} ${text}`;
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

  let speechConfig = {};

  if (hasMultipleSpeakers) {
    speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: speakerVoiceConfigs,
      },
    };
  } else {
    speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Kore' },
      },
    };
  }

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