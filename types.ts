
export enum VoiceName {
  Puck = 'Puck',
  Charon = 'Charon',
  Kore = 'Kore',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr',
  Aoede = 'Aoede'
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
