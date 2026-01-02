
import { WordTiming } from '../types';

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
 * Decodes raw PCM data into an AudioBuffer.
 * Gemini Flash TTS typically returns raw PCM 24kHz mono audio.
 */
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      // Convert 16-bit PCM to float [-1.0, 1.0]
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

/**
 * Decodes compressed audio data (MP3, AAC, etc.) using the browser's native decoder.
 * Used for OpenAI TTS responses.
 */
export async function decodeCompressedAudioData(
  data: Uint8Array,
  ctx: AudioContext
): Promise<AudioBuffer> {
  // decodeAudioData detaches the buffer, so we slice a copy to be safe
  const bufferCopy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return await ctx.decodeAudioData(bufferCopy);
}

/**
 * Creates a silent audio buffer of the specified duration.
 */
export function createSilentBuffer(ctx: AudioContext, duration: number): AudioBuffer {
  // Minimum duration to avoid glitching
  const safeDuration = Math.max(0.001, duration);
  const sampleRate = ctx.sampleRate;
  const length = Math.ceil(safeDuration * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  // Data is already zeros by default
  return buffer;
}

/**
 * Resamples an AudioBuffer to fit EXACTLY into a target duration.
 * 
 * Logic:
 * - If current < target: Slows down audio (playbackRate < 1.0)
 * - If current > target: Speeds up audio (playbackRate > 1.0)
 * 
 * Note: This uses simple resampling which affects pitch. 
 * For moderate changes (0.8x - 1.2x) this is usually acceptable for speech.
 */
export async function fitAudioToTargetDuration(
  buffer: AudioBuffer,
  targetDuration: number,
  ctx: AudioContext
): Promise<{ buffer: AudioBuffer; ratio: number }> {
  // Tolerance to avoid unnecessary processing for sub-millisecond differences
  if (Math.abs(buffer.duration - targetDuration) < 0.05) {
      return { buffer, ratio: 1.0 };
  }

  // Calculate ratio. 
  // e.g. Buffer = 10s, Target = 5s. Ratio = 2.0 (Play twice as fast)
  // e.g. Buffer = 5s, Target = 10s. Ratio = 0.5 (Play half speed)
  const ratio = buffer.duration / targetDuration;
  
  // Use OfflineAudioContext to render the retimed audio
  const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
    buffer.numberOfChannels,
    Math.ceil(targetDuration * ctx.sampleRate),
    ctx.sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = ratio;
  source.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  return { buffer: renderedBuffer, ratio };
}

/**
 * Encodes an AudioBuffer to a base64 string (16-bit PCM).
 */
export function audioBufferToBase64(buffer: AudioBuffer): string {
  const data = buffer.getChannelData(0); 
  const len = data.length;
  const pcm16 = new Int16Array(len);

  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const bytes = new Uint8Array(pcm16.buffer);
  
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  
  return btoa(binary);
}

/**
 * Downloads an AudioBuffer as a .wav file.
 */
export function downloadAudioBufferAsWav(buffer: AudioBuffer, filename: string) {
  const wavBytes = encodeWav(buffer);
  const blob = new Blob([wavBytes], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let i;
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

  for (i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < buffer.length) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][pos]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(44 + offset, sample, true); 
      offset += 2;
    }
    pos++;
  }
  return bufferArray;
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
      outputData.set(buffer.getChannelData(0), offset);
      offset += buffer.length;
    }
  }
  return output;
}

/**
 * Estimates word timestamps based on text length distribution over audio duration.
 * This is a heuristic method to avoid STT API calls.
 */
export function estimateWordTimings(text: string, duration: number): WordTiming[] {
  // Clean text of basic punctuation for word splitting
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return [];

  // Calculate "character density weight"
  const totalChars = words.reduce((acc, w) => acc + w.length, 0);
  
  let currentTime = 0;
  return words.map(word => {
    // Distribute duration proportionally
    const weight = word.length / totalChars;
    const wordDuration = duration * weight;
    
    const start = parseFloat(currentTime.toFixed(3));
    const end = parseFloat((currentTime + wordDuration).toFixed(3));
    
    currentTime += wordDuration;
    
    return { word, start, end };
  });
}
