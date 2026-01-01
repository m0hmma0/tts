
export type TTSProvider = 'google' | 'openai';

export enum VoiceName {
  // Google Gemini Voices
  Puck = 'Puck',
  Charon = 'Charon',
  Kore = 'Kore',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr',
  Aoede = 'Aoede',
  
  // OpenAI Voices
  Alloy = 'alloy',
  Echo = 'echo',
  Fable = 'fable',
  Onyx = 'onyx',
  Nova = 'nova',
  Shimmer = 'shimmer'
}

export interface Speaker {
  id: string;
  name: string;
  voice: VoiceName;
  accent?: string;
  speed?: string;
  instructions?: string; 
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface AudioCacheItem {
  buffer: AudioBuffer;
  timings: WordTiming[];
}

export interface GenerationState {
  isGenerating: boolean;
  error: string | null;
  audioBuffer: AudioBuffer | null;
  timings: WordTiming[] | null;
}
