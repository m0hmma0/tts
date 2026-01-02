
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
  return buffer;
}

/**
 * Improved SOLA (Synchronized Overlap-Add) Time Stretching.
 * Uses ADAPTIVE grain sizes to handle both speeding up and slowing down naturally.
 * 
 * @param buffer Input AudioBuffer
 * @param speedRate 1.0 = Normal, 0.5 = Half Speed (2x duration), 2.0 = Double Speed (0.5x duration)
 */
function solaTimeStretch(buffer: AudioBuffer, speedRate: number, ctx: AudioContext): AudioBuffer {
  // Adaptive Parameters
  // When speeding up (>1), we need smaller grains to avoid skipping entire phonemes (stops pitch distortion/skipping artifacts).
  // When slowing down (<1), larger grains preserve low frequency pitch better.
  
  let GRAIN_SIZE_S;
  let OVERLAP_S;
  
  if (speedRate > 1.0) {
      // Compression (Speed Up)
      // Use smaller grains (e.g., 35-40ms)
      GRAIN_SIZE_S = 0.040; 
      OVERLAP_S = 0.010;
  } else {
      // Expansion (Slow Down)
      // Use larger grains (e.g., 80ms) for stability
      GRAIN_SIZE_S = 0.080;
      OVERLAP_S = 0.020;
  }

  const SEARCH_S = 0.015;     
  
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const inputLength = buffer.length;
  
  // Calculate sizes in samples
  const grainSize = Math.floor(GRAIN_SIZE_S * sampleRate);
  const overlapSize = Math.floor(OVERLAP_S * sampleRate);
  const searchSize = Math.floor(SEARCH_S * sampleRate);
  
  const outputStep = grainSize - overlapSize;
  const inputStep = Math.floor(outputStep * speedRate);
  const outputLength = Math.ceil(inputLength / speedRate);
  
  const outputBuffer = ctx.createBuffer(numChannels, outputLength + grainSize, sampleRate);
  
  for (let ch = 0; ch < numChannels; ch++) {
    const inputData = buffer.getChannelData(ch);
    const outputData = outputBuffer.getChannelData(ch);
    
    if (inputLength > grainSize) {
        outputData.set(inputData.subarray(0, grainSize), 0);
    }
    
    let outputOffset = outputStep;
    let inputOffset = inputStep; 
    
    while (outputOffset + grainSize < outputLength && inputOffset + grainSize + searchSize < inputLength) {
        let bestOffset = 0;
        let bestCorrelation = -Infinity;
        
        const searchLimit = (inputOffset + searchSize + grainSize < inputLength) ? searchSize : 0;
        
        // Coarse search first for performance if search is large, 
        // but here search is small so full search is fine.
        for (let i = 0; i < searchLimit; i++) {
            let correlation = 0;
            for (let j = 0; j < overlapSize; j += 4) { // Optimization: check every 4th sample
                const valOut = outputData[outputOffset + j]; 
                const valIn = inputData[inputOffset + i + j];
                correlation += valOut * valIn;
            }
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestOffset = i;
            }
        }
        
        const actualInputPos = inputOffset + bestOffset;
        
        // Overlap-Add with Hanning window
        for (let j = 0; j < overlapSize; j++) {
            const phase = j / overlapSize; 
            const weightNew = 0.5 * (1 - Math.cos(Math.PI * phase)); 
            const weightOld = 1 - weightNew; 
            
            const existingVal = outputData[outputOffset + j];
            const newVal = inputData[actualInputPos + j];
            
            outputData[outputOffset + j] = (existingVal * weightOld) + (newVal * weightNew);
        }
        
        const remainingSamples = grainSize - overlapSize;
        if (actualInputPos + overlapSize + remainingSamples < inputLength) {
             const startIn = actualInputPos + overlapSize;
             const startOut = outputOffset + overlapSize;
             outputData.set(inputData.subarray(startIn, startIn + remainingSamples), startOut);
        }
        
        outputOffset += outputStep;
        inputOffset += inputStep; 
    }
  }

  // Final Cleanup
  const finalBuffer = ctx.createBuffer(numChannels, outputLength, sampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
      const data = outputBuffer.getChannelData(ch).subarray(0, outputLength);
      finalBuffer.copyToChannel(data, ch);
  }
  
  return finalBuffer;
}

/**
 * Resamples an AudioBuffer to fit EXACTLY into a target duration using Time Stretching (SOLA).
 * Pitch is preserved.
 */
export async function fitAudioToTargetDuration(
  buffer: AudioBuffer,
  targetDuration: number,
  ctx: AudioContext
): Promise<{ buffer: AudioBuffer; ratio: number }> {
  // Tolerance to avoid unnecessary processing
  if (Math.abs(buffer.duration - targetDuration) < 0.05) {
      return { buffer, ratio: 1.0 };
  }

  const ratio = buffer.duration / targetDuration;

  // Run improved SOLA algorithm
  const stretchedBuffer = solaTimeStretch(buffer, ratio, ctx);

  return { buffer: stretchedBuffer, ratio };
}

/**
 * Renders multiple audio chunks onto a single timeline based on their absolute start times.
 * This handles overlapping audio segments correctly without extending the total duration unnecessarily.
 */
export function renderTimeline(
  chunks: { buffer: AudioBuffer; startTime: number }[],
  ctx: AudioContext
): AudioBuffer {
  if (chunks.length === 0) return ctx.createBuffer(1, 1, ctx.sampleRate);

  // 1. Calculate total duration based on the latest ending chunk
  let totalDuration = 0;
  chunks.forEach(c => {
    const end = c.startTime + c.buffer.duration;
    if (end > totalDuration) totalDuration = end;
  });

  // Ensure reasonable minimum
  totalDuration = Math.max(totalDuration, 0.1);

  // 2. Create output buffer
  const output = ctx.createBuffer(1, Math.ceil(totalDuration * ctx.sampleRate), ctx.sampleRate);
  const outputData = output.getChannelData(0);

  // 3. Mix
  chunks.forEach(c => {
    const startSample = Math.floor(c.startTime * ctx.sampleRate);
    const inputData = c.buffer.getChannelData(0);
    
    // Simple mixing (Addition)
    // In a sophisticated DAW we would normalize, but for TTS overlaps this works best to preserve volume.
    for (let i = 0; i < inputData.length; i++) {
      const idx = startSample + i;
      if (idx < outputData.length) {
        outputData[idx] += inputData[i];
        
        // Hard limiter to prevent digital clipping if overlap is loud
        if (outputData[idx] > 1.0) outputData[idx] = 1.0;
        if (outputData[idx] < -1.0) outputData[idx] = -1.0;
      }
    }
  });
  
  return output;
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
