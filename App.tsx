
import React, { useState, useRef, useEffect } from 'react';
import { SpeakerManager } from './components/SpeakerManager';
import { ScriptEditor } from './components/ScriptEditor';
import { AudioPlayer } from './components/AudioPlayer';
import { LogViewer } from './components/LogViewer';
import { ChunkList } from './components/ChunkList';
import { previewSpeakerVoice, formatPromptWithSettings } from './services/geminiService';
import { generateOpenAISpeech } from './services/openaiService';
import { 
  decodeBase64, 
  decodeAudioData, 
  decodeCompressedAudioData,
  concatenateAudioBuffers,
  audioBufferToBase64,
  estimateWordTimings,
  createSilentBuffer,
  fitAudioToMaxDuration
} from './utils/audioUtils';
import { parseSRT, formatTimeForScript, parseScriptTimestamp } from './utils/srtUtils';
import { Speaker, VoiceName, GenerationState, AudioCacheItem, WordTiming, TTSProvider, LogEntry, ScriptLine, DubbingChunk } from './types';
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen, XCircle, FileUp, Layers, Trash2 } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: The office, early morning]
[00:00:01.000 -> 00:00:05.000] Speaker: Hello! Import an SRT file to get started with synchronized dubbing.`;

// Default speaker set to Puck, single entry
const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Speaker', voice: VoiceName.Puck, accent: 'Neutral', speed: 'Normal', instructions: '' },
];

const BUILD_REV = "v2.5.0-logs-chunks"; 

// Helper to generate a unique key for a chunk based on its content and timing target
const generateChunkHash = (chunk: Omit<DubbingChunk, 'id'>, provider: string): string => {
    // We include provider, text, speaker, and exact duration target. 
    const content = provider + chunk.speakerName + chunk.lines.map(l => l.spokenText).join('') + chunk.startTime.toFixed(3) + chunk.endTime.toFixed(3);
    let hash = 0, i, chr;
    if (content.length === 0) return hash.toString();
    for (i = 0; i < content.length; i++) {
      chr = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; 
    }
    return "chk_" + hash.toString();
};

export default function App() {
  const [speakers, setSpeakers] = useState<Speaker[]>(INITIAL_SPEAKERS);
  const [script, setScript] = useState(INITIAL_SCRIPT);
  
  // TTS Provider State
  const [provider, setProvider] = useState<TTSProvider>('google');
  const [openAiKey, setOpenAiKey] = useState<string>('');

  // Cache for single line previews
  const [audioCache, setAudioCache] = useState<Record<string, AudioCacheItem>>({});

  // Cache for batch generation chunks (Persists across errors)
  const [chunkCache, setChunkCache] = useState<Record<string, { buffer: AudioBuffer, timings: WordTiming[] }>>({});

  // The actual list of chunks derived from the script
  const [plannedChunks, setPlannedChunks] = useState<DubbingChunk[]>([]);

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [generationState, setGenerationState] = useState<GenerationState>({
    isGenerating: false,
    error: null,
    audioBuffer: null,
    timings: null
  });

  const [progressMsg, setProgressMsg] = useState<string>("");
  const [completedChunksCount, setCompletedChunksCount] = useState<number>(0);
  const [totalChunksCount, setTotalChunksCount] = useState<number>(0);

  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  // Playback ref for ChunkList
  const previewContextRef = useRef<AudioContext | null>(null);

  const addLog = (level: LogEntry['level'], message: string) => {
    setLogs(prev => [...prev, {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      level,
      message
    }]);
  };

  const handleAbort = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setGenerationState(prev => ({ ...prev, isGenerating: false, error: "Generation paused by user." }));
      addLog('warn', 'Generation paused by user.');
      setProgressMsg("Paused");
    }
  };

  /**
   * Helper to parse raw script into structured lines
   */
  const parseScriptLines = (rawScript: string): ScriptLine[] => {
    const rawLines = rawScript.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const parsed: ScriptLine[] = [];

    for (const line of rawLines) {
      const rangeMatch = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)/);
      const simpleMatch = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)/);
      
      let startTime = 0;
      let endTime: number | null = null;
      let content = line;

      if (rangeMatch) {
        startTime = parseScriptTimestamp(rangeMatch[1]) || 0;
        endTime = parseScriptTimestamp(rangeMatch[2]);
        content = rangeMatch[3];
      } else if (simpleMatch) {
        startTime = parseScriptTimestamp(simpleMatch[1]) || 0;
        content = simpleMatch[2];
      } else {
        continue;
      }

      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) continue;

      const speakerName = content.slice(0, colonIdx).trim();
      let spokenText = content.slice(colonIdx + 1).trim();
      spokenText = spokenText.replace(/\[.*?\]/g, '').trim(); 

      if (!spokenText) continue;

      parsed.push({
        originalText: line,
        speakerName,
        spokenText,
        startTime,
        endTime
      });
    }
    return parsed;
  };

  /**
   * Batch lines into natural "Dubbing Chunks"
   */
  const createDubbingChunks = (lines: ScriptLine[]): DubbingChunk[] => {
    if (lines.length === 0) return [];

    const rawChunks: Omit<DubbingChunk, 'id'>[] = [];
    let currentChunk: Omit<DubbingChunk, 'id'> | null = null;

    for (const line of lines) {
      if (!currentChunk) {
        currentChunk = {
          speakerName: line.speakerName,
          lines: [line],
          startTime: line.startTime,
          endTime: line.endTime || (line.startTime + 3),
          textHash: ""
        };
        continue;
      }

      const prevLine = currentChunk.lines[currentChunk.lines.length - 1];
      const prevEndTime = prevLine.endTime || (prevLine.startTime + 2.0);
      const gap = line.startTime - prevEndTime;
      const chunkDuration = (line.endTime || line.startTime) - currentChunk.startTime;

      const isSameSpeaker = line.speakerName === currentChunk.speakerName;
      // Allow slightly tighter gap tolerance for overlapping SRTs
      const isTightGap = gap < 0.6; 
      const isShortEnough = chunkDuration < 15.0; 

      if (isSameSpeaker && isTightGap && isShortEnough) {
        currentChunk.lines.push(line);
        currentChunk.endTime = line.endTime || (line.startTime + 3);
      } else {
        rawChunks.push(currentChunk);
        currentChunk = {
          speakerName: line.speakerName,
          lines: [line],
          startTime: line.startTime,
          endTime: line.endTime || (line.startTime + 3),
          textHash: ""
        };
      }
    }
    if (currentChunk) rawChunks.push(currentChunk);

    // Assign IDs with Provider awareness
    return rawChunks.map(c => ({
        ...c,
        id: generateChunkHash(c, provider)
    }));
  };

  const handleClearCache = () => {
    if (confirm("Are you sure? This will delete all generated chunks.")) {
        setChunkCache({});
        setGenerationState(prev => ({ ...prev, audioBuffer: null, timings: null }));
        addLog('info', 'Cache cleared by user.');
    }
  };

  // Shared function to generate audio for a single chunk
  // Returns true if audio was generated, false if retrieved from cache (or error thrown)
  const generateChunkAudio = async (
    chunk: DubbingChunk, 
    audioCtx: AudioContext, 
    signal: AbortSignal,
    forceRegen: boolean = false
  ): Promise<{ buffer: AudioBuffer, timings: WordTiming[], wasCached: boolean }> => {
    
    // Check Cache
    if (!forceRegen && chunkCache[chunk.id]) {
        return { 
            buffer: chunkCache[chunk.id].buffer, 
            timings: chunkCache[chunk.id].timings,
            wasCached: true
        };
    }

    const combinedText = chunk.lines.map(l => l.spokenText).join(" ");
    const speaker = speakers.find(s => s.name.toLowerCase() === chunk.speakerName.toLowerCase());
    
    // Get Voice based on provider
    let voice: VoiceName;
    if (provider === 'google') {
        voice = speaker ? speaker.voice : VoiceName.Kore;
    } else {
        voice = speaker ? speaker.voice : VoiceName.Alloy;
    }

    addLog('info', `Generating audio for [${chunk.speakerName}]: "${combinedText.substring(0, 30)}..." (${provider})`);

    let base64Audio: string;
    
    if (provider === 'google') {
        // GOOGLE GEMINI PATH
        const prompt = formatPromptWithSettings(combinedText, speaker);
        try {
          base64Audio = await previewSpeakerVoice(voice, prompt, undefined, signal);
        } catch (apiErr: any) {
           throw apiErr;
        }
    } else {
        // OPENAI PATH
        try {
            base64Audio = await generateOpenAISpeech(combinedText, voice, openAiKey, signal);
        } catch (apiErr: any) {
            throw apiErr;
        }
    }

    const audioBytes = decodeBase64(base64Audio);
    
    // Decode Logic based on provider
    let chunkRawBuffer: AudioBuffer;
    if (provider === 'openai') {
        chunkRawBuffer = await decodeCompressedAudioData(audioBytes, audioCtx);
    } else {
        chunkRawBuffer = await decodeAudioData(audioBytes, audioCtx, 24000);
    }

    // Fit to Duration with Drift Compensation
    let finalChunkBuffer = chunkRawBuffer;
    const nominalDuration = chunk.endTime - chunk.startTime;
    
    // For single chunk regeneration, we assume 0 drift from previous since we don't have that context easily,
    // or we could recalculate if we are in loop.
    // The loop calculates drift. Here we just strictly fit to nominal if needed.
    
    if (chunkRawBuffer.duration > (nominalDuration + 0.1)) {
        addLog('info', `Compressing audio: ${chunkRawBuffer.duration.toFixed(2)}s -> ${nominalDuration.toFixed(2)}s`);
        finalChunkBuffer = await fitAudioToMaxDuration(chunkRawBuffer, nominalDuration, audioCtx);
    }

    // Estimate Timings
    const chunkTimings = estimateWordTimings(combinedText, finalChunkBuffer.duration);

    return { 
        buffer: finalChunkBuffer, 
        timings: chunkTimings,
        wasCached: false
    };
  };

  // Re-stitch all chunks into the final timeline
  const stitchAudio = (chunks: DubbingChunk[], currentChunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[] }>, audioCtx: AudioContext) => {
      const orderedBuffers: AudioBuffer[] = [];
      const orderedTimings: WordTiming[] = [];
      let currentTimelineTime = 0;

      for (const chunk of chunks) {
          const cached = currentChunkCache[chunk.id];
          if (!cached) {
              // Missing chunk (e.g. failed generation), skip or fill silence?
              // Let's fill nominal silence to keep timing if possible, or just skip.
              // If we skip, subsequent timings drift.
              // Safer to skip for now to avoid crashes.
              continue; 
          }

          const silenceNeeded = chunk.startTime - currentTimelineTime;
          if (silenceNeeded > 0.05) {
            orderedBuffers.push(createSilentBuffer(audioCtx, silenceNeeded));
            currentTimelineTime += silenceNeeded;
          }

          const offsetTimings = cached.timings.map(t => ({
            word: t.word,
            start: t.start + currentTimelineTime,
            end: t.end + currentTimelineTime
          }));

          orderedBuffers.push(cached.buffer);
          orderedTimings.push(...offsetTimings);
          currentTimelineTime += cached.buffer.duration;
      }
      
      if (orderedBuffers.length === 0) return null;
      
      const finalBuffer = concatenateAudioBuffers(orderedBuffers, audioCtx);
      return { finalBuffer, orderedTimings };
  };

  const handleGenerate = async () => {
    if (!script.trim()) {
      setGenerationState(prev => ({ ...prev, error: "Please enter a script." }));
      addLog('error', 'Script is empty.');
      return;
    }

    if (provider === 'openai' && !openAiKey.trim()) {
       setGenerationState(prev => ({ ...prev, error: "OpenAI API Key is required." }));
       addLog('error', 'OpenAI API Key missing.');
       return;
    }

    setGenerationState(prev => ({ ...prev, isGenerating: true, error: null }));
    setLogs([]); // Clear previous logs on fresh start
    addLog('info', 'Starting generation...');
    setProgressMsg("Preparing...");
    
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    let audioCtx: AudioContext | null = null;

    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      
      const parsedLines = parseScriptLines(script);
      if (parsedLines.length === 0) throw new Error("No valid dialogue lines found.");
      addLog('info', `Parsed ${parsedLines.length} lines from script.`);

      const chunks = createDubbingChunks(parsedLines);
      setPlannedChunks(chunks);
      setTotalChunksCount(chunks.length);
      addLog('info', `Grouped into ${chunks.length} dubbing chunks.`);
      
      let currentTimelineTime = 0;
      let newlyGeneratedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        
        const chunk = chunks[i];
        setCompletedChunksCount(i);
        
        // Drift Calculation
        const silenceNeeded = chunk.startTime - currentTimelineTime;
        const drift = Math.max(0, -silenceNeeded);
        
        // We pass the drift context implicitly by adjusting how we handle the result?
        // Actually, the generateChunkAudio is generic.
        // We need to handle compression with drift awareness HERE in the loop, or pass target duration.
        // Let's modify generateChunkAudio slightly or handle compression outside.
        // To reuse logic, let's keep generateChunkAudio simple and do advanced compression here?
        // Actually, let's just stick to the previous loop logic but call the helper.
        // BUT the helper needs to update the cache.
        
        // Let's inline the logic partially to keep the drift logic intact, or just do cache check then generate.

        if (chunkCache[chunk.id]) {
            addLog('success', `Chunk ${i+1}/${chunks.length} retrieved from cache.`);
            const cached = chunkCache[chunk.id];
            
            // Advance timeline
            if (silenceNeeded > 0.05) currentTimelineTime += silenceNeeded;
            currentTimelineTime += cached.buffer.duration;
            
            await new Promise(r => setTimeout(r, 10)); // Yield UI
        } else {
            // Rate Limiting for OpenAI
            if (provider === 'openai' && newlyGeneratedCount > 0) {
                 const waitTime = 7000;
                 addLog('warn', `Rate limit: Waiting ${waitTime/1000}s...`);
                 setProgressMsg("Rate limit cooldown...");
                 const waitEnd = Date.now() + waitTime;
                 while(Date.now() < waitEnd) {
                     if (signal.aborted) throw new DOMException("Aborted", "AbortError");
                     await new Promise(r => setTimeout(r, 200));
                 }
            }

            setProgressMsg(`Generating ${i + 1}/${chunks.length}...`);
            
            // Generate
            const result = await generateChunkAudio(chunk, audioCtx, signal, true); // Force regen since we know it's missing
            
            // Apply drift compensation to the result if needed
            let finalBuffer = result.buffer;
            
            const nominalDuration = chunk.endTime - chunk.startTime;
            const compensatedTarget = Math.max(nominalDuration * 0.5, nominalDuration - drift);

            if (result.buffer.duration > (compensatedTarget + 0.1)) {
                addLog('info', `Drift compensation: Compressing ${result.buffer.duration.toFixed(2)}s to ${compensatedTarget.toFixed(2)}s`);
                finalBuffer = await fitAudioToMaxDuration(result.buffer, compensatedTarget, audioCtx);
            }

            // Estimate timings again on final buffer
            const finalTimings = estimateWordTimings(
                chunk.lines.map(l => l.spokenText).join(" "), 
                finalBuffer.duration
            );

            // Update Cache
            setChunkCache(prev => ({
                ...prev,
                [chunk.id]: { buffer: finalBuffer, timings: finalTimings }
            }));

            addLog('success', `Chunk ${i+1}/${chunks.length} generated.`);
            newlyGeneratedCount++;

            // Update timeline
            if (silenceNeeded > 0.05) currentTimelineTime += silenceNeeded;
            currentTimelineTime += finalBuffer.duration;
        }
      }

      setCompletedChunksCount(chunks.length);
      setProgressMsg("Stitching audio...");
      addLog('info', 'Stitching final audio...');

      // Final Stitch
      // We need to re-read from state/cache. Note: setState is async, but we mutated the object in the loop logic conceptually?
      // No, setChunkCache is async. We can't read from state immediately.
      // We need to maintain a local `currentChunkCache` for the loop to work if we were passing it, 
      // but here we just rely on `chunkCache` state being updated? 
      // ACTUALLY, React state updates won't reflect instantly in the loop. 
      // We must build a local cache object.
      
      // FIX: Use a local accumulator for the stitching phase.
      const localCacheAccumulator = { ...chunkCache }; // Start with existing
      // Re-run the loop logic just to populate localCacheAccumulator?
      // No, we should just update `localCacheAccumulator` inside the loop.
      
      // Let's refactor the loop slightly to update `localCacheAccumulator`
    } catch (error: any) {
        // ... error handling
        if (error.name !== "AbortError") {
             addLog('error', `Generation failed: ${error.message}`);
             setGenerationState(prev => ({ ...prev, isGenerating: false, error: error.message }));
        }
    } finally {
        // Since we can't easily refactor the whole loop safely in one go without breaking the existing complex logic (drift etc),
        // let's just re-trigger a "stitch only" pass using the component state if successful, 
        // OR better: Just rely on the user clicking "Generate" again which will hit cache.
        // Actually, for a good UX, we want it to finish.
        // Let's just create a `reconstitute` function that runs after the state updates settle?
        // No, we'll use a `useEffect` on `chunkCache`? No, that triggers too often.
        
        // Simplest fix: The `handleGenerate` above was flawed in my description regarding state updates.
        // I will implement a proper local accumulator in the actual code block below.
        
        if (audioCtx && audioCtx.state !== 'closed') {
           await audioCtx.close();
        }
        abortControllerRef.current = null;
        setTimeout(() => { 
           if (!generationState.error) setProgressMsg(""); 
        }, 3000);
    }
  };
  
  // Real implementation of handleGenerate with local cache tracking
  const runGenerationLoop = async () => {
     if (!script.trim()) return;
     
     setGenerationState(prev => ({ ...prev, isGenerating: true, error: null }));
     setLogs([]);
     addLog('info', 'Starting generation process...');
     
     const controller = new AbortController();
     abortControllerRef.current = controller;
     const signal = controller.signal;
     let audioCtx: AudioContext | null = null;

     try {
         audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
         const parsedLines = parseScriptLines(script);
         if (parsedLines.length === 0) throw new Error("No lines found.");
         
         const chunks = createDubbingChunks(parsedLines);
         setPlannedChunks(chunks);
         setTotalChunksCount(chunks.length);
         addLog('info', `Plan: ${chunks.length} chunks.`);

         let localCache = { ...chunkCache };
         let currentTimelineTime = 0;
         let newlyGenerated = 0;

         for (let i = 0; i < chunks.length; i++) {
             if (signal.aborted) throw new DOMException("Aborted", "AbortError");
             
             const chunk = chunks[i];
             setCompletedChunksCount(i);
             
             const silenceNeeded = chunk.startTime - currentTimelineTime;
             const drift = Math.max(0, -silenceNeeded);
             
             if (!localCache[chunk.id]) {
                 // Generate
                 if (provider === 'openai' && newlyGenerated > 0) {
                     addLog('warn', 'Rate limit waiting...');
                     await new Promise(r => setTimeout(r, 7000));
                 }
                 
                 setProgressMsg(`Generating ${i+1}/${chunks.length}`);
                 
                 // Generate raw
                 const result = await generateChunkAudio(chunk, audioCtx, signal, true);
                 
                 // Compress/Drift Fix
                 let finalBuffer = result.buffer;
                 const nominal = chunk.endTime - chunk.startTime;
                 const target = Math.max(nominal * 0.5, nominal - drift);
                 
                 if (finalBuffer.duration > target + 0.1) {
                     finalBuffer = await fitAudioToMaxDuration(finalBuffer, target, audioCtx);
                 }
                 
                 const timings = estimateWordTimings(chunk.lines.map(l=>l.spokenText).join(" "), finalBuffer.duration);
                 
                 localCache[chunk.id] = { buffer: finalBuffer, timings };
                 addLog('success', `Generated chunk ${i+1}.`);
                 newlyGenerated++;
             } else {
                 addLog('info', `Chunk ${i+1} used from cache.`);
             }

             // Update timeline tracking
             const item = localCache[chunk.id];
             if (silenceNeeded > 0.05) currentTimelineTime += silenceNeeded;
             currentTimelineTime += item.buffer.duration;
         }

         // Done loop, update React state once
         setChunkCache(localCache);
         
         // Stitch
         const stitchResult = stitchAudio(chunks, localCache, audioCtx);
         if (stitchResult) {
             setGenerationState({
                 isGenerating: false,
                 error: null,
                 audioBuffer: stitchResult.finalBuffer,
                 timings: stitchResult.orderedTimings
             });
             addLog('success', 'Audio stitching complete.');
             setProgressMsg("Done!");
         } else {
             throw new Error("Stitching produced no audio.");
         }

     } catch (e: any) {
         if (e.name !== "AbortError") {
             addLog('error', e.message);
             setGenerationState(prev => ({ ...prev, isGenerating: false, error: e.message }));
         }
     } finally {
         if (audioCtx) audioCtx.close();
         abortControllerRef.current = null;
     }
  };

  const handleRegenerateChunk = async (chunk: DubbingChunk) => {
      addLog('info', `Regenerating single chunk: ${chunk.id}`);
      
      const controller = new AbortController();
      const signal = controller.signal;
      let audioCtx: AudioContext | null = null;
      
      try {
          audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
          
          // Force generate
          const result = await generateChunkAudio(chunk, audioCtx, signal, true);
          
          // Update cache with new buffer (we don't apply complex drift compensation here 
          // because we don't have the full timeline context easily, 
          // we just fit to nominal duration to be safe)
          let finalBuffer = result.buffer;
          const nominal = chunk.endTime - chunk.startTime;
          if (finalBuffer.duration > nominal + 0.1) {
              finalBuffer = await fitAudioToMaxDuration(finalBuffer, nominal, audioCtx);
          }
           const timings = estimateWordTimings(chunk.lines.map(l=>l.spokenText).join(" "), finalBuffer.duration);

          const newCache = { 
              ...chunkCache, 
              [chunk.id]: { buffer: finalBuffer, timings } 
          };
          setChunkCache(newCache);
          addLog('success', `Chunk ${chunk.id} regenerated.`);

          // Re-stitch full audio immediately
          const stitchResult = stitchAudio(plannedChunks, newCache, audioCtx);
          if (stitchResult) {
               setGenerationState(prev => ({
                   ...prev,
                   audioBuffer: stitchResult.finalBuffer,
                   timings: stitchResult.orderedTimings
               }));
               addLog('success', 'Timeline updated.');
          }

      } catch (e: any) {
          addLog('error', `Regen failed: ${e.message}`);
          alert(`Failed to regenerate: ${e.message}`);
      } finally {
          if (audioCtx) audioCtx.close();
      }
  };

  const handlePlayChunk = async (buffer: AudioBuffer) => {
      // Simple one-off player for chunks
      if (!previewContextRef.current) {
          previewContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      }
      if (previewContextRef.current.state === 'suspended') {
          await previewContextRef.current.resume();
      }
      
      const source = previewContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(previewContextRef.current.destination);
      source.start();
  };

  const handleImportSRT = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = (e) => {
       const content = e.target?.result as string;
       const srtBlocks = parseSRT(content);
       if (srtBlocks.length === 0) {
          alert("Could not parse SRT.");
          return;
       }
       const defaultSpeaker = speakers[0]?.name || "Speaker";
       const scriptLines = srtBlocks.map(block => {
          const startTime = formatTimeForScript(block.startSeconds);
          const endTime = formatTimeForScript(block.endSeconds);
          let text = block.text;
          const hasSpeaker = /^[A-Za-z0-9_ ]+:/.test(text);
          if (!hasSpeaker) text = `${defaultSpeaker}: ${text}`;
          return `[${startTime} -> ${endTime}] ${text}`;
       });
       setScript(scriptLines.join('\n'));
       addLog('info', `Imported SRT with ${srtBlocks.length} blocks.`);
    };
    reader.readAsText(file);
  };

  const handleSaveProject = () => {
    const serializedCache: Record<string, any> = {};
    for (const [key, val] of Object.entries(audioCache)) {
      const item = val as AudioCacheItem;
      serializedCache[key] = {
        audio: audioBufferToBase64(item.buffer),
        timings: item.timings
      };
    }

    const serializedChunkCache: Record<string, any> = {};
    for (const [key, val] of Object.entries(chunkCache)) {
        const item = val as { buffer: AudioBuffer, timings: WordTiming[] };
        serializedChunkCache[key] = {
            audio: audioBufferToBase64(item.buffer),
            timings: item.timings
        };
    }

    let serializedFullAudio = null;
    if (generationState.audioBuffer) {
      serializedFullAudio = audioBufferToBase64(generationState.audioBuffer);
    }

    const projectData = {
      version: '2.5.0',
      timestamp: new Date().toISOString(),
      script,
      speakers,
      provider, // Save provider selection
      audioCache: serializedCache,
      chunkCache: serializedChunkCache,
      fullAudio: serializedFullAudio,
      fullTimings: generationState.timings,
      plannedChunks // Save the chunk breakdown too so we can restore the list
    };
    
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gemini-tts-project.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addLog('success', 'Project saved.');
  };

  const handleLoadProject = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        
        if (data.script && Array.isArray(data.speakers)) {
            setScript(data.script);
            setSpeakers(data.speakers);
            
            if (data.provider) setProvider(data.provider);
            if (data.plannedChunks) setPlannedChunks(data.plannedChunks);

            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
            
            // Load Preview Cache
            const newCache: Record<string, AudioCacheItem> = {};
            if (data.audioCache) {
              for (const [key, value] of Object.entries(data.audioCache)) {
                 const v = value as { audio: string, timings: any[] };
                 const bytes = decodeBase64(v.audio);
                 const buffer = await decodeAudioData(bytes, ctx, 24000);
                 newCache[key] = { buffer, timings: v.timings || [] };
              }
            }
            setAudioCache(newCache);

            // Load Chunk Cache
            const newChunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[] }> = {};
            if (data.chunkCache) {
                for (const [key, value] of Object.entries(data.chunkCache)) {
                    const v = value as { audio: string, timings: any[] };
                    const bytes = decodeBase64(v.audio);
                    const buffer = await decodeAudioData(bytes, ctx, 24000);
                    newChunkCache[key] = { buffer, timings: v.timings || [] };
                 }
            }
            setChunkCache(newChunkCache);

            let fullBuffer = null;
            if (data.fullAudio && typeof data.fullAudio === 'string') {
              const bytes = decodeBase64(data.fullAudio);
              fullBuffer = await decodeAudioData(bytes, ctx, 24000);
            }

            setGenerationState({
                isGenerating: false,
                error: null,
                audioBuffer: fullBuffer,
                timings: data.fullTimings || null
            });
            
            ctx.close();
            addLog('success', 'Project loaded.');
        } else {
            alert("Invalid project file structure.");
        }
      } catch (err: any) {
        console.error("Failed to load project", err);
        alert("Failed to load project file.");
        addLog('error', `Load failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const hasCache = Object.keys(chunkCache).length > 0;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-4 md:p-8 font-sans transition-colors duration-300">
      <div className="max-w-6xl mx-auto space-y-8">
        
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3">
              <span className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-500/30">
                <Sparkles className="text-white" size={24} />
              </span>
              Gemini TTS Studio
            </h1>
            <p className="mt-2 text-slate-500">Generate realistic multi-speaker dialogue.</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
             <div className="flex items-center bg-white p-1 rounded-lg border border-slate-200 shadow-sm">
              <button onClick={() => srtInputRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors border-r border-slate-200 pr-4 mr-1">
                <FileUp size={14} /> Import SRT
              </button>
              <input type="file" ref={srtInputRef} onChange={handleImportSRT} className="hidden" accept=".srt" />

              <button onClick={handleSaveProject} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors">
                <Save size={14} /> Save Project
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1"></div>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors">
                <FolderOpen size={14} /> Open
              </button>
            </div>
            <input type="file" ref={fileInputRef} onChange={handleLoadProject} className="hidden" accept=".json" />

            <div className="flex flex-col items-end">
              <div className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg border shadow-sm ${provider === 'google' ? 'text-slate-600 bg-white border-slate-200' : 'text-white bg-indigo-600 border-indigo-500'}`}>
                  <span className={`w-2 h-2 rounded-full animate-pulse ${provider === 'google' ? 'bg-emerald-500' : 'bg-white'}`}></span>
                  {provider === 'google' ? 'Gemini Flash' : 'OpenAI TTS'}
              </div>
              <div className="mt-2 text-xs font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 tracking-wide">
                BUILD: {BUILD_REV}
              </div>
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
          
          <div className="lg:col-span-1 space-y-6">
            <SpeakerManager 
                speakers={speakers} 
                setSpeakers={setSpeakers} 
                provider={provider}
                setProvider={setProvider}
                openAiKey={openAiKey}
                setOpenAiKey={setOpenAiKey}
            />
            
            <div className="bg-white rounded-xl p-6 border border-slate-200 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Actions</h3>
              
              <div className="space-y-3">
                <button
                  onClick={runGenerationLoop}
                  disabled={generationState.isGenerating}
                  className={`w-full py-3 px-4 rounded-lg font-semibold text-white shadow-lg transition-all flex items-center justify-center gap-2
                    ${generationState.isGenerating 
                      ? 'bg-slate-300 text-slate-500 cursor-wait' 
                      : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 hover:scale-[1.02] shadow-indigo-500/20'
                    }`}
                >
                  {generationState.isGenerating ? (
                    <>
                      <Loader2 className="animate-spin" size={20} />
                      {hasCache ? "Resuming..." : "Processing..."}
                    </>
                  ) : (
                    <>
                      <Layers size={20} />
                      {hasCache ? "Resume Generation" : "Generate Batch Audio"}
                    </>
                  )}
                </button>
                
                {hasCache && !generationState.isGenerating && (
                    <button 
                        onClick={handleClearCache}
                        className="w-full py-2 px-4 rounded-lg font-medium text-slate-500 hover:text-red-600 hover:bg-red-50 transition-all flex items-center justify-center gap-2 text-xs border border-transparent hover:border-red-100"
                    >
                        <Trash2 size={14} /> Clear Cached Chunks
                    </button>
                )}

                {(progressMsg || completedChunksCount > 0) && (
                    <div className="text-center space-y-2">
                        <div className="flex justify-between text-xs text-slate-500 font-medium">
                            <span>Progress</span>
                            <span>{completedChunksCount} / {totalChunksCount}</span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                             <div 
                                className="h-full bg-indigo-500 transition-all duration-300"
                                style={{ width: `${totalChunksCount > 0 ? (completedChunksCount / totalChunksCount) * 100 : 0}%` }}
                             ></div>
                        </div>
                        <div className="text-xs text-slate-500 font-mono h-4">
                            {progressMsg}
                        </div>
                    </div>
                )}

                {generationState.isGenerating && (
                  <button
                    onClick={handleAbort}
                    className="w-full py-2 px-4 rounded-lg font-medium text-red-600 bg-red-50 border border-red-100 hover:bg-red-100 transition-all flex items-center justify-center gap-2"
                  >
                    <XCircle size={18} />
                    Pause Generation
                  </button>
                )}
              </div>

              {generationState.error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg flex items-start gap-2 text-red-600 text-sm">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <p>{generationState.error}</p>
                </div>
              )}
            </div>

             {generationState.audioBuffer && (
               <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                 <AudioPlayer 
                   audioBuffer={generationState.audioBuffer} 
                   timings={generationState.timings}
                 />
               </div>
             )}
          </div>

          <div className="lg:col-span-2 min-h-[500px] flex flex-col gap-6">
             <ScriptEditor 
               script={script} 
               setScript={setScript} 
               speakers={speakers}
               audioCache={audioCache}
               setAudioCache={setAudioCache}
             />
             
             {/* Chunk List Manager - Visible when we have chunks planned or cached */}
             {(plannedChunks.length > 0) && (
                 <ChunkList 
                     chunks={plannedChunks} 
                     chunkCache={chunkCache}
                     isGenerating={generationState.isGenerating}
                     onRegenerate={handleRegenerateChunk}
                     onPlay={handlePlayChunk}
                 />
             )}
             
             <LogViewer logs={logs} onClear={() => setLogs([])} />
          </div>

        </main>

        <footer className="text-center text-slate-400 text-sm pt-8 pb-4">
          Powered by {provider === 'google' ? 'Google Gemini 2.5 Flash' : 'OpenAI TTS'} • Web Audio API • React • Build {BUILD_REV}
        </footer>
      </div>
    </div>
  );
}
