
export enum VoiceName {
  Rachel = '21m00Tcm4labaLutmOOn',
  Adam = 'pNInz6obpgDQGcFmaJgB',
  Drew = '29vD33n1HhcqSba5nPLT',
  Clyde = '2EiwWnXFnvU5JabPnv8n',
  Paul = '5Q0t7uMcj7Zz8H7t1In9',
  Bella = 'EXAVITQu4vr4xnSDxMaL',
  Domi = 'AZnzlk1XhxPqc804G3Xz',
  Elli = 'MF3mGyEYCl7h37341t95',
  Josh = 'TxGEqnSAs9dnLUR6mB82',
  Arnold = 'VR6AewyWnaPajHUIn4qy',
  Harry = 'SOYf8f3X36lK5vVdfS43'
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
  'French',
  'Spanish',
  'Italian',
  'German'
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
