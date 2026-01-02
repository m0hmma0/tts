
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
 * SOLA (Synchronized Overlap-Add) Time Stretching Implementation.
 * This changes the duration of the audio WITHOUT changing the pitch.
 * 
 * @param buffer Input AudioBuffer
 * @param speedRate 1.0 = Normal, 0.5 = Half Speed (2x duration), 2.0 = Double Speed (0.5x duration)
 */
function solaTimeStretch(buffer: AudioBuffer, speedRate: number, ctx: AudioContext): AudioBuffer {
  // Constants for SOLA
  const SEQUENCE_MS = 20;   // Length of the main processing window
  const SEEK_MS = 10;       // Length of the search window for phase alignment
  const OVERLAP_MS = 8;     // Overlap duration

  const sampleRate = buffer.sampleRate;
  const sequenceSize = Math.floor((SEQUENCE_MS / 1000) * sampleRate);
  const seekSize = Math.floor((SEEK_MS / 1000) * sampleRate);
  const overlapSize = Math.floor((OVERLAP_MS / 1000) * sampleRate);

  const numChannels = buffer.numberOfChannels;
  const inputLength = buffer.length;
  // Estimated output length
  const outputLength = Math.floor(inputLength / speedRate);
  
  const outputBuffer = ctx.createBuffer(numChannels, outputLength + sequenceSize * 2, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const inputData = buffer.getChannelData(ch);
    const outputData = outputBuffer.getChannelData(ch);

    let inputOffset = 0;
    let outputOffset = 0;

    // Pre-fill first sequence
    if (inputLength > sequenceSize) {
       for (let i = 0; i < sequenceSize; i++) {
           outputData[i] = inputData[i];
       }
       inputOffset = sequenceSize;
       outputOffset = sequenceSize;
    }

    while (inputOffset + sequenceSize + seekSize < inputLength && outputOffset + sequenceSize < outputLength) {
      // 1. Determine the nominal position in the input buffer based on speed
      // If speed is 2.0, we skip ahead twice as fast in input.
      // If speed is 0.5, we move slower in input.
      // Note: SOLA moves output by fixed steps and finds best input match, OR moves input fixed and finds best output match.
      // Here we implement a standard OLA step:
      
      const analysisHop = Math.floor(sequenceSize * speedRate); 
      
      // We want to add a new grain at 'outputOffset'.
      // We look at the 'tail' of the existing output (last 'overlapSize' samples).
      // We look at the 'head' of the input candidates roughly at 'inputOffset + analysisHop'.
      
      // Simplified SOLA:
      // We advance input by analysisHop.
      // We search local area for best cross-correlation to align phases.
      
      let bestOffset = 0;
      let maxCorrelation = -1;

      // The region in Input we want to grab roughly
      const nominalInputStart = Math.floor(inputOffset + analysisHop); 
      if (nominalInputStart + overlapSize + seekSize >= inputLength) break;

      // Compare the tail of the output (already written) with the head of the input candidate
      // Tail of output starts at: outputOffset - overlapSize
      
      for (let i = 0; i < seekSize; i++) {
        let correlation = 0;
        // Calculate cross-correlation for this lag 'i'
        for (let j = 0; j < overlapSize; j++) {
           const valOut = outputData[outputOffset - overlapSize + j];
           const valIn = inputData[nominalInputStart + i + j];
           correlation += valOut * valIn;
        }
        if (correlation > maxCorrelation) {
          maxCorrelation = correlation;
          bestOffset = i;
        }
      }

      // 2. Mix (Overlap-Add) with the best phase alignment
      const actualInputStart = nominalInputStart + bestOffset;
      
      // Crossfade the overlap region
      for (let j = 0; j < overlapSize; j++) {
        const fadeOut = (overlapSize - j) / overlapSize;
        const fadeIn = j / overlapSize;
        
        const existingVal = outputData[outputOffset - overlapSize + j];
        const newVal = inputData[actualInputStart + j];
        
        outputData[outputOffset - overlapSize + j] = (existingVal * fadeOut) + (newVal * fadeIn);
      }

      // Copy the rest of the sequence
      for (let j = overlapSize; j < sequenceSize; j++) {
        if (actualInputStart + j < inputLength) {
            outputData[outputOffset - overlapSize + j] = inputData[actualInputStart + j];
        }
      }

      // Advance
      outputOffset += (sequenceSize - overlapSize);
      inputOffset = actualInputStart; // Update true input position
    }
  }

  // Trim to exact expected length to clean up tails
  const trimmed = ctx.createBuffer(numChannels, outputLength, sampleRate);
  for (let ch = 0; ch < numChannels; ch++) {
     trimmed.copyToChannel(outputBuffer.getChannelData(ch).subarray(0, outputLength), ch);
  }

  return trimmed;
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

  // Calculate speed ratio.
  // Example: Buffer=10s, Target=5s. We need to play 2x faster. Speed = 2.0.
  // Example: Buffer=5s, Target=10s. We need to play 0.5x speed. Speed = 0.5.
  const ratio = buffer.duration / targetDuration;

  // Run SOLA algorithm
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
