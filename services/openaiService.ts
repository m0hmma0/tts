
import { VoiceName } from "../types";

const OPENAI_API_URL = "https://api.openai.com/v1/audio/speech";

/**
 * Generates audio using OpenAI TTS API.
 * Returns a Base64 encoded string of the audio file (MP3).
 */
export const generateOpenAISpeech = async (
  text: string,
  voice: VoiceName,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> => {
  if (!apiKey) {
    throw new Error("OpenAI API Key is missing. Please enter it in the Speaker Manager.");
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1", // Standard model for speed/cost. Use 'tts-1-hd' for higher quality if needed.
      input: text,
      voice: voice,
      response_format: "mp3",
      speed: 1.0 // OpenAI doesn't support complex stage directions for speed natively like Gemini
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(`OpenAI API Error: ${err.error?.message || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return arrayBufferToBase64(arrayBuffer);
};

// Helper to convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
