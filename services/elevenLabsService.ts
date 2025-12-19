
import { Speaker } from "../types";

// @ts-ignore - injected by Vite
const API_KEYS: string[] = process.env.API_KEY_POOL || [];
let currentKeyIndex = 0;

const rotateKey = () => {
  if (API_KEYS.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
};

const getActiveKey = () => API_KEYS[currentKeyIndex];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeRequest(voiceId: string, text: string, speaker?: Speaker): Promise<ArrayBuffer> {
  const apiKey = getActiveKey();
  if (!apiKey) throw new Error("No ElevenLabs API Key found.");

  // Map speed to stability/clarity if needed, but for ElevenLabs we use stability/similarity
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text: formatPromptWithSettings(text, speaker),
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true
      }
    }),
  });

  if (response.status === 429) {
    rotateKey();
    throw new Error("Rate limit exceeded. Rotating key...");
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail?.message || `ElevenLabs API error: ${response.status}`);
  }

  return await response.arrayBuffer();
}

export const formatPromptWithSettings = (text: string, speaker?: Speaker): string => {
  if (!speaker) return text;
  let context = "";
  if (speaker.accent && speaker.accent !== 'Neutral') {
    context += `[Accent: ${speaker.accent}] `;
  }
  // ElevenLabs v2 models are very responsive to text context
  return context + text;
};

export const generateLineAudio = async (voiceId: string, text: string, speaker?: Speaker): Promise<string> => {
  let retries = 2;
  while (retries > 0) {
    try {
      const buffer = await executeRequest(voiceId, text, speaker);
      const uint8 = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < uint8.length; i += chunkSize) {
        const chunk = uint8.subarray(i, Math.min(i + chunkSize, uint8.length));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
      }
      return btoa(binary);
    } catch (err: any) {
      if (err.message.includes("Rotating") && retries > 1) {
        retries--;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to generate audio after retries.");
};
