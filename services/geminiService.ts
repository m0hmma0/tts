import { GoogleGenAI, Modality } from "@google/genai";
import { Speaker } from "../types";

// Initialize the client
// NOTE: process.env.API_KEY is injected by the environment.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a function if it fails with a 429 (Rate Limit) or 503 (Service Unavailable) error.
 * Uses exponential backoff.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 2000
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const isRateLimit =
      error?.status === 429 ||
      error?.code === 429 ||
      (error?.message && error.message.includes("429")) ||
      (error?.message && error.message.includes("quota"));

    const isServerError = error?.status === 503 || error?.code === 503;

    if (retries > 0 && (isRateLimit || isServerError)) {
      console.warn(
        `Request failed with ${error.status || "error"}. Retrying in ${delay}ms...`
      );
      await sleep(delay);
      // Exponential backoff: double the delay for the next retry
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Helper to inject speaker settings (accent, speed) into the text prompt as stage directions.
 * Example: "Hello" + { speed: 'Fast', accent: 'British' } -> "(speaking fast, British accent) Hello"
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

export const generateSpeech = async (
  script: string,
  speakers: Speaker[]
): Promise<string | undefined> => {
  
  // Construct the multi-speaker configuration
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
    // Fallback to single speaker if user cleared all speakers but hit generate
    speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Kore' },
      },
    };
  }

  return retryWithBackoff(async () => {
    try {
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
    } catch (error: any) {
      console.error("Error generating speech:", error);
      throw error;
    }
  });
};

export const previewSpeakerVoice = async (voiceName: string, text?: string): Promise<string> => {
  return retryWithBackoff(async () => {
    try {
      // Use provided text or a generic sentence that allows the user to hear the voice's tone and clarity
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
    } catch (error) {
      console.error("Error generating preview:", error);
      throw error;
    }
  });
};