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
}

export interface GenerationState {
  isGenerating: boolean;
  error: string | null;
  audioBuffer: AudioBuffer | null;
}