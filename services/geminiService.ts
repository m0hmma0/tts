
import { GoogleGenAI, Modality } from "@google/genai";
import { Speaker } from "../types";

// --- Helper Utilities ---

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

/**
 * Generates audio for a single line using Gemini TTS.
 * This function follows the @google/genai guidelines for text-to-speech.
 */
export const generateLineAudio = async (voice: string, text: string, speaker?: Speaker): Promise<string> => {
  // Always use process.env.API_KEY directly when initializing the @google/genai client instance.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const processedText = formatPromptWithSettings(text, speaker);
  
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: processedText }] }],
    config: {
      // responseModalities must be an array with a single `Modality.AUDIO` element.
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error("No audio data returned from Gemini.");
  }
  return base64Audio;
};

/**
 * Generates multi-speaker audio for an entire script.
 */
export const generateSpeech = async (
  script: string,
  speakers: Speaker[]
): Promise<string | undefined> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const speakerVoiceConfigs = speakers.map((s) => ({
    speaker: s.name,
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: s.voice },
    },
  }));

  const speechConfig = speakers.length > 0 
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakerVoiceConfigs,
        },
      }
    : {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      };

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: script }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: speechConfig,
    },
  });

  return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
};

/**
 * Previews a specific voice with a short text.
 */
export const previewSpeakerVoice = async (voiceName: string, text?: string): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
};
