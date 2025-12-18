export enum VoiceName {
  Alloy = 'alloy',
  Echo = 'echo',
  Fable = 'fable',
  Onyx = 'onyx',
  Nova = 'nova',
  Shimmer = 'shimmer'
}

export type AccentType = 'Neutral' | 'Indian' | 'UK' | 'US' | 'Australian';

export interface Speaker {
  id: string;
  name: string;
  voice: VoiceName;
  accent: AccentType;
  speed: string;
  defaultEmotion?: string;
}

export interface GenerationState {
  isGenerating: boolean;
  error: string | null;
  audioBuffer: AudioBuffer | null;
}