
export enum VoiceName {
  Alloy = 'alloy',
  Echo = 'echo',
  Fable = 'fable',
  Onyx = 'onyx',
  Nova = 'nova',
  Shimmer = 'shimmer'
}

export const ACCENTS = [
  'Neutral',
  'American',
  'British',
  'Australian',
  'Indian',
  'Southern US',
  'Irish',
  'Scottish',
  'French-accented English',
  'Spanish-accented English'
];

export interface Speaker {
  id: string;
  name: string;
  voice: VoiceName;
  accent?: string;
  speed?: string;
}

export interface GenerationState {
  isGenerating: boolean;
  error: string | null;
  audioBuffer: AudioBuffer | null;
}
