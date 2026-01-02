
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
 * Uses larger grain sizes and windowing to reduce robotic artifacts in speech.
 * 
 * @param buffer Input AudioBuffer
 * @param speedRate 1.0 = Normal, 0.5 = Half Speed (2x duration), 2.0 = Double Speed (0.5x duration)
 */
function solaTimeStretch(buffer: AudioBuffer, speedRate: number, ctx: AudioContext): AudioBuffer {
  // Tuned parameters for speech (High Quality)
  // Larger windows (60ms) capture pitch periods of low voices better than 20ms
  const GRAIN_SIZE_S = 0.060; 
  const OVERLAP_S = 0.015;    
  const SEARCH_S = 0.015;     
  
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const inputLength = buffer.length;
  
  // Calculate sizes in samples
  const grainSize = Math.floor(GRAIN_SIZE_S * sampleRate);
  const overlapSize = Math.floor(OVERLAP_S * sampleRate);
  const searchSize = Math.floor(SEARCH_S * sampleRate);
  
  // The step size for the OUTPUT buffer
  // We place grains at fixed intervals in the output
  const outputStep = grainSize - overlapSize;
  
  // The step size for the INPUT buffer (nominal)
  // If speed > 1, we step through input faster
  const inputStep = Math.floor(outputStep * speedRate);
  
  // Estimated output length
  const outputLength = Math.ceil(inputLength / speedRate);
  
  // Create output buffer (with some padding for processing)
  const outputBuffer = ctx.createBuffer(numChannels, outputLength + grainSize, sampleRate);
  
  // We process each channel. 
  for (let ch = 0; ch < numChannels; ch++) {
    const inputData = buffer.getChannelData(ch);
    const outputData = outputBuffer.getChannelData(ch);
    
    // Copy first grain directly
    if (inputLength > grainSize) {
        outputData.set(inputData.subarray(0, grainSize), 0);
    }
    
    let outputOffset = outputStep;
    let inputOffset = inputStep; // Nominal position in input
    
    while (outputOffset + grainSize < outputLength && inputOffset + grainSize + searchSize < inputLength) {
        // 1. Find Best Overlap
        // We look for the best match for the "Overlap Region"
        // The tail of the output buffer vs the head of the candidate input grains
        
        let bestOffset = 0;
        let bestCorrelation = -Infinity;
        
        // We search around the nominal inputOffset
        // Limit search to avoid going out of bounds
        const searchLimit = (inputOffset + searchSize + grainSize < inputLength) ? searchSize : 0;
        
        for (let i = 0; i < searchLimit; i++) {
            let correlation = 0;
            // Calculate cross-correlation for alignment
            // Optimization: check every 2nd sample for speed if needed, but full is better for quality
            for (let j = 0; j < overlapSize; j += 2) {
                const valOut = outputData[outputOffset + j]; // This data comes from the TAIL of the previous grain
                const valIn = inputData[inputOffset + i + j];
                correlation += valOut * valIn;
            }
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestOffset = i;
            }
        }
        
        const actualInputPos = inputOffset + bestOffset;
        
        // 2. Overlap-Add (Cross-fade)
        // We blend the existing tail of output with the head of the new input grain
        for (let j = 0; j < overlapSize; j++) {
            // Hanning-like window for smoother transition
            // 0 to 1
            const phase = j / overlapSize; 
            const weightNew = 0.5 * (1 - Math.cos(Math.PI * phase)); // Ease in
            const weightOld = 1 - weightNew; // Ease out
            
            const existingVal = outputData[outputOffset + j];
            const newVal = inputData[actualInputPos + j];
            
            outputData[outputOffset + j] = (existingVal * weightOld) + (newVal * weightNew);
        }
        
        // 3. Copy the rest of the grain
        // The part after the overlap
        const remainingSamples = grainSize - overlapSize;
        if (actualInputPos + overlapSize + remainingSamples < inputLength) {
             const startIn = actualInputPos + overlapSize;
             const startOut = outputOffset + overlapSize;
             // Use set for speed
             outputData.set(inputData.subarray(startIn, startIn + remainingSamples), startOut);
        }
        
        // Advance
        outputOffset += outputStep;
        inputOffset += inputStep; 
    }
  }

  // Final Cleanup: Trim to exact target length
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
 * 
 * Logic:
 * - If current < target: Slows down audio (Stretch)
 * - If current > target: Speeds up audio (Compress)
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
