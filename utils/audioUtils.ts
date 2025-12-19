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
 * Encodes an AudioBuffer to a base64 string (16-bit PCM).
 * Useful for saving generated audio to a file.
 */
export function audioBufferToBase64(buffer: AudioBuffer): string {
  const data = buffer.getChannelData(0); // Assuming mono for Gemini TTS
  const len = data.length;
  const pcm16 = new Int16Array(len);

  // Convert Float32 to Int16
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const bytes = new Uint8Array(pcm16.buffer);
  
  // Convert to binary string using chunks to avoid stack overflow
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  
  return btoa(binary);
}

/**
 * Downloads an AudioBuffer as a .wav file in the browser.
 */
export function downloadAudioBufferAsWav(buffer: AudioBuffer, filename: string) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // write WAVE header
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this example)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < buffer.length) {
    for (i = 0; i < numOfChan; i++) {
      // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(44 + offset, sample, true); // write 16-bit sample
      offset += 2;
    }
    pos++;
  }

  // create Blob
  const blob = new Blob([bufferArray], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  
  // Clean up
  URL.revokeObjectURL(url);

  function setUint16(data: any) {
    view.setUint16(pos, data, true);
    pos += 2;
  }
  function setUint32(data: any) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

/**
 * Concatenates multiple AudioBuffers into a single AudioBuffer.
 * Useful for stitching individual line generations into a full script.
 */
export function concatenateAudioBuffers(
  buffers: AudioBuffer[],
  ctx: AudioContext
): AudioBuffer | null {
  if (buffers.length === 0) return null;

  // Calculate total length
  let totalLength = 0;
  for (const buffer of buffers) {
    totalLength += buffer.length;
  }

  const output = ctx.createBuffer(
    buffers[0].numberOfChannels,
    totalLength,
    buffers[0].sampleRate
  );

  for (let channel = 0; channel < output.numberOfChannels; channel++) {
    const outputData = output.getChannelData(channel);
    let offset = 0;
    for (const buffer of buffers) {
      // Handle channel mismatch if necessary (copy mono to stereo or just ch 0)
      const inputData = buffer.getChannelData(0); 
      outputData.set(inputData, offset);
      offset += buffer.length;
    }
  }

  return output;
}

/**
 * Mixes two buffers together.
 * @param baseBuffer The main audio (e.g., speech).
 * @param overlayBuffer The audio to mix on top (e.g., ambience).
 * @param overlayVolume Volume of the overlay (0.0 to 1.0).
 */
export function mixBuffers(
  baseBuffer: AudioBuffer,
  overlayBuffer: AudioBuffer,
  overlayVolume: number,
  ctx: AudioContext
): AudioBuffer {
  // Output matches base buffer duration
  const output = ctx.createBuffer(
    baseBuffer.numberOfChannels,
    baseBuffer.length,
    baseBuffer.sampleRate
  );

  const baseData = baseBuffer.getChannelData(0);
  const overlayData = overlayBuffer.getChannelData(0);
  const outputData = output.getChannelData(0);

  for (let i = 0; i < baseBuffer.length; i++) {
    // Loop the overlay if it's shorter than base, or just clamp
    const overlaySample = overlayData[i % overlayBuffer.length] || 0;
    outputData[i] = baseData[i] + (overlaySample * overlayVolume);
  }

  return output;
}

/**
 * Generates a noise buffer (Pink, White, Brown) for ambience.
 */
export function createNoiseBuffer(
  ctx: AudioContext,
  duration: number,
  type: 'white' | 'pink' | 'brown' = 'white'
): AudioBuffer {
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  if (type === 'white') {
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  } else if (type === 'pink') {
    let b0, b1, b2, b3, b4, b5, b6;
    b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168981;
      data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      data[i] *= 0.11; // (roughly) compensate for gain
      b6 = white * 0.115926;
    }
  } else if (type === 'brown') {
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = data[i];
      data[i] *= 3.5; // (roughly) compensate for gain
    }
  }

  return buffer;
}

/**
 * Generates a simple tone/beep buffer for SFX.
 */
export function generateTone(
  ctx: AudioContext, 
  freq: number, 
  duration: number,
  type: 'sine' | 'square' | 'sawtooth' | 'triangle' = 'sine'
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * duration;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Simple oscillator math
    if (type === 'sine') {
      data[i] = Math.sin(2 * Math.PI * freq * t);
    } else if (type === 'sawtooth') {
      data[i] = 2 * (t * freq - Math.floor(t * freq + 0.5));
    } else {
       // fallback sine
       data[i] = Math.sin(2 * Math.PI * freq * t);
    }
    
    // Simple envelope (fade out)
    if (i > length - 1000) {
      data[i] *= (length - i) / 1000;
    }
  }
  
  return buffer;
}