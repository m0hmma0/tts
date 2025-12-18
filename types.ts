
export enum VoiceName {
  Kore = 'Kore',
  Puck = 'Puck',
  Charon = 'Charon',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr'
}

export type AccentType = 'Neutral' | 'Indian' | 'UK' | 'US' | 'Australian';

export interface Speaker {
  id: string;
  name: string;
  voice: VoiceName;
  accent: AccentType;
  speed: string;
  defaultEmotion: string;
}

export interface GenerationState {
  isGenerating: boolean;
  error: string | null;
  audioBuffer: AudioBuffer | null;
}
