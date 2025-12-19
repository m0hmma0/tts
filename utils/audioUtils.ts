
/**
 * Decodes a base64 string into a Uint8Array.
 */
export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes audio data (MP3, WAV, etc.) into an AudioBuffer.
 * Uses the native AudioContext.decodeAudioData for broad format support.
 */
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 44100 // ElevenLabs often uses 44.1kHz
): Promise<AudioBuffer> {
  // We use the browser's built-in decoder which handles MP3/WAV headers
  return await ctx.decodeAudioData(data.buffer.slice(0));
}

/**
 * Encodes an AudioBuffer to a base64 string (WAV format).
 */
export function audioBufferToBase64(buffer: AudioBuffer): string {
  // Simplified for project saving; we'll save the raw bytes if possible, 
  // but since we need a string, we generate a WAV blob first.
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let sample;
  let offset = 0;
  let pos = 0;

  const setUint16 = (data: any) => { view.setUint16(pos, data, true); pos += 2; };
  const setUint32 = (data: any) => { view.setUint32(pos, data, true); pos += 4; };

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8);
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt "
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  let sampleIdx = 0;
  while (sampleIdx < buffer.length) {
    for (let i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][sampleIdx]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(44 + offset, sample, true);
      offset += 2;
    }
    sampleIdx++;
  }

  const bytes = new Uint8Array(bufferArray);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export function downloadAudioBufferAsWav(buffer: AudioBuffer, filename: string) {
  const b64 = audioBufferToBase64(buffer);
  const bytes = decodeBase64(b64);
  const blob = new Blob([bytes], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function concatenateAudioBuffers(
  buffers: AudioBuffer[],
  ctx: AudioContext
): AudioBuffer | null {
  if (buffers.length === 0) return null;
  let totalLength = 0;
  for (const buffer of buffers) totalLength += buffer.length;
  const output = ctx.createBuffer(buffers[0].numberOfChannels, totalLength, buffers[0].sampleRate);
  for (let channel = 0; channel < output.numberOfChannels; channel++) {
    const outputData = output.getChannelData(channel);
    let offset = 0;
    for (const buffer of buffers) {
      outputData.set(buffer.getChannelData(channel), offset);
      offset += buffer.length;
    }
  }
  return output;
}
