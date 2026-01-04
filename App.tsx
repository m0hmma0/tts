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
  fitAudioToTargetDuration,
  renderTimeline
} from './utils/audioUtils';
import { parseSRT, formatTimeForScript, parseScriptTimestamp } from './utils/srtUtils';
import { Speaker, VoiceName, GenerationState, AudioCacheItem, WordTiming, TTSProvider, LogEntry, ScriptLine, DubbingChunk } from './types';
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen, XCircle, FileUp, Layers, Trash2 } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: The office, early morning]
[00:00:01.000 -> 00:00:05.000] Speaker: Hello! Import an SRT file to get started with synchronized dubbing.
Speaker: You can also write lines without timestamps and they will be auto-scheduled!`;

// Default speaker set to Puck, single entry
const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Speaker', voice: VoiceName.Puck, accent: 'Neutral', speed: 'Normal', instructions: '' },
];

const BUILD_REV = "v2.11.5-auto-timing"; 

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
  const [chunkCache, setChunkCache] = useState<Record<string, { buffer: AudioBuffer, timings: WordTiming[], ratio?: number }>>({});

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
   * Helper to parse raw script into structured lines.
   * Supports both timestamped "[00:00 -> 00:05] Speaker: Text" and 
   * untimestamped "Speaker: Text" (auto-sequenced) lines.
   */
  const parseScriptLines = (rawScript: string): ScriptLine[] => {
    const rawLines = rawScript.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const parsed: ScriptLine[] = [];

    // Relaxed regex to handle optional milliseconds or slight variations
    const rangeRegex = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*->\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.*)/;
    const simpleRegex = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.*)/;

    let cursorTime = 0; // Tracks the end of the last line to chain untimestamped lines

    for (const line of rawLines) {
      const rangeMatch = line.match(rangeRegex);
      const simpleMatch = line.match(simpleRegex);
      
      let startTime = cursorTime; 
      let endTime: number | null = null;
      let content = line;

      // Case 1: [Start -> End] Content
      if (rangeMatch) {
        startTime = parseScriptTimestamp(rangeMatch[1]) || 0;
        endTime = parseScriptTimestamp(rangeMatch[2]);
        content = rangeMatch[3];
      } 
      // Case 2: [Start] Content
      else if (simpleMatch) {
        startTime = parseScriptTimestamp(simpleMatch[1]) || 0;
        content = simpleMatch[2];
      } 
      // Case 3: Just Content (No timestamp) -> Uses cursorTime as startTime
      else {
        content = line;
      }

      // Check if it's a valid dialogue line (Speaker: Text)
      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) continue; // Skip non-dialogue lines (e.g. Scene directions without speaker)

      const speakerName = content.slice(0, colonIdx).trim();
      let spokenText = content.slice(colonIdx + 1).trim();
      spokenText = spokenText.replace(/\[.*?\]/g, '').trim(); 

      if (!spokenText) continue;

      // Estimate End Time if not provided
      if (endTime === null) {
          // Heuristic: ~0.4s per word, minimum 1.5s
          const wordCount = spokenText.split(/\s+/).length;
          const duration = Math.max(1.5, wordCount * 0.4);
          endTime = startTime + duration;
      }

      parsed.push({
        originalText: line,
        speakerName,
        spokenText,
        startTime,
        endTime
      });

      // Update cursor for next line
      if (endTime > cursorTime) {
          cursorTime = endTime;
      }
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

  // Sync plannedChunks with script automatically to prevent stale state
  useEffect(() => {
    const timer = setTimeout(() => {
      const parsedLines = parseScriptLines(script);
      const chunks = createDubbingChunks(parsedLines);
      setPlannedChunks(chunks);
      setTotalChunksCount(chunks.length);
    }, 500);
    return () => clearTimeout(timer);
  }, [script, provider]);

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

    addLog('info', `Generating [${chunk.speakerName}] (${(chunk.endTime - chunk.startTime).toFixed(1)}s target): "${combinedText.substring(0, 30)}..."`);

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

    return { 
        buffer: chunkRawBuffer, 
        timings: [], // Timings calculated after fitting
        wasCached: false
    };
  };

  // Re-stitch all chunks into the final timeline using absolute positioning
  // This solves the accumulation issue by mixing chunks at their specific start times
  const stitchAudio = (chunks: DubbingChunk[], currentChunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[] }>, audioCtx: AudioContext) => {
      const renderList: { buffer: AudioBuffer, startTime: number }[] = [];
      const orderedTimings: WordTiming[] = [];

      for (const chunk of chunks) {
          const cached = currentChunkCache[chunk.id];
          if (!cached) {
              continue; 
          }

          renderList.push({
            buffer: cached.buffer,
            startTime: chunk.startTime
          });

          // Offset timings by absolute start time
          const offsetTimings = cached.timings.map(t => ({
            word: t.word,
            start: t.start + chunk.startTime,
            end: t.end + chunk.startTime
          }));

          orderedTimings.push(...offsetTimings);
      }
      
      if (renderList.length === 0) return null;
      
      // Use mixing renderer instead of concatenation
      const finalBuffer = renderTimeline(renderList, audioCtx);
      return { finalBuffer, orderedTimings };
  };

  const normalizeTimestamp = (input: string): string => {
     // Ensure strict format HH:MM:SS.mmm for valid regex matching
     const secs = parseScriptTimestamp(input);
     if (secs !== null) {
        return formatTimeForScript(secs);
     }
     return input; // Fallback
  };

  const handleUpdateScriptTiming = (chunkId: string, newStart: string, newEnd: string) => {
      // Find the chunk in the planned array
      const chunk = plannedChunks.find(c => c.id === chunkId);
      if (!chunk) return;
      
      const safeStart = normalizeTimestamp(newStart);
      const safeEnd = normalizeTimestamp(newEnd);

      // We need to robustly find the line in the CURRENT script.
      // The chunk.lines[0].originalText might be stale if user edited text.
      // Strategy: Search for the line containing the speaker and spoken text.
      const currentLines = script.split('\n');
      
      // Use the first line of the chunk for identification
      const targetSpeaker = chunk.speakerName;
      const targetText = chunk.lines[0].spokenText;

      let foundIndex = -1;

      // Try to find the matching line index
      for (let i = 0; i < currentLines.length; i++) {
          const line = currentLines[i];
          // Simple heuristic: Does line contain Speaker AND Text?
          // We also ignore the timestamp part in the check to avoid circular failure
          if (line.includes(targetSpeaker) && line.includes(targetText)) {
              foundIndex = i;
              break;
          }
      }

      if (foundIndex !== -1) {
          const originalLine = currentLines[foundIndex];
          // Reconstruct the line with new timestamp
          // Format: [START -> END] Speaker: Text
          // We preserve the text part exactly as it is in the current script (after the timestamp bracket)
          const textMatch = originalLine.match(/^\[.*?\]\s*(.*)/);
          const contentPart = textMatch ? textMatch[1] : originalLine;
          
          const newLine = `[${safeStart} -> ${safeEnd}] ${contentPart}`;
          
          currentLines[foundIndex] = newLine;
          const newScript = currentLines.join('\n');
          
          setScript(newScript);
          addLog('info', `Updated timing: ${safeStart} -> ${safeEnd}`);
          
          // Optimistically update planned chunks to prevent UI flicker
          const parsedLines = parseScriptLines(newScript);
          const newChunks = createDubbingChunks(parsedLines);
          setPlannedChunks(newChunks);
      } else {
          addLog('error', 'Could not locate line in script to update timing. Try editing manually.');
      }
  };
  
  // Real implementation of handleGenerate with local cache tracking
  const runGenerationLoop = async () => {
     if (!script.trim()) return;
     
     setGenerationState(prev => ({ ...prev, isGenerating: true, error: null }));
     setLogs([]);
     
     const limitInfo = provider === 'google' 
         ? "Rate Limit: 15 RPM (Free) / 1000 RPM (Pay-as-you-go). Input: 1M tokens/min." 
         : "Rate Limit: Usage Tier Based (RPM/TPM).";
     addLog('info', `Provider: ${provider === 'google' ? 'Google Gemini 2.5' : 'OpenAI TTS'} | ${limitInfo}`);
     addLog('info', 'Starting Perfect Sync Generation...');
     
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
         let newlyGenerated = 0;

         for (let i = 0; i < chunks.length; i++) {
             if (signal.aborted) throw new DOMException("Aborted", "AbortError");
             
             const chunk = chunks[i];
             setCompletedChunksCount(i);
             
             if (!localCache[chunk.id]) {
                 // Rate Limit Wait
                 if (provider === 'openai' && newlyGenerated > 0) {
                     addLog('warn', 'Rate limit protection (7s wait)...');
                     await new Promise(r => setTimeout(r, 7000));
                 }
                 
                 setProgressMsg(`Generating ${i+1}/${chunks.length}`);
                 
                 // Generate raw
                 const result = await generateChunkAudio(chunk, audioCtx, signal, true);
                 
                 // PERFECT SYNC: STRETCH OR COMPRESS WITH PITCH PRESERVATION (SOLA)
                 const targetDuration = chunk.endTime - chunk.startTime;
                 const rawDuration = result.buffer.duration;
                 
                 // Apply fitting logic (internally uses SOLA)
                 const { buffer: finalBuffer, ratio } = await fitAudioToTargetDuration(result.buffer, targetDuration, audioCtx);
                 
                 if (ratio > 1.05) {
                     addLog('warn', `  ↳ Too long (${rawDuration.toFixed(2)}s). Time-stretching ${ratio.toFixed(2)}x faster (Pitch Locked).`);
                 } else if (ratio < 0.95) {
                     addLog('info', `  ↳ Too short (${rawDuration.toFixed(2)}s). Time-stretching ${ratio.toFixed(2)}x slower (Pitch Locked).`);
                 }
                 
                 const timings = estimateWordTimings(chunk.lines.map(l=>l.spokenText).join(" "), finalBuffer.duration);
                 
                 localCache[chunk.id] = { buffer: finalBuffer, timings, ratio };
                 addLog('success', `Chunk ${i+1} synced.`);
                 newlyGenerated++;
             } else {
                 addLog('info', `Chunk ${i+1} from cache.`);
             }
         }

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
             addLog('success', 'Final Audio Complete.');
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
      addLog('info', `Regenerating chunk: ${chunk.id}`);
      addLog('info', `Constraint: Force fit to ${formatTimeForScript(chunk.startTime)} -> ${formatTimeForScript(chunk.endTime)}`);
      
      const controller = new AbortController();
      const signal = controller.signal;
      let audioCtx: AudioContext | null = null;
      
      try {
          audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
          
          // Force generate
          const result = await generateChunkAudio(chunk, audioCtx, signal, true);
          
          // STRICT SYNC BIDIRECTIONAL WITH PITCH LOCK
          const targetDuration = chunk.endTime - chunk.startTime;
          const { buffer: finalBuffer, ratio } = await fitAudioToTargetDuration(result.buffer, targetDuration, audioCtx);

          addLog('success', `Applied ${ratio.toFixed(2)}x time-stretch (Pitch Locked) to fit window.`);
          
          const timings = estimateWordTimings(chunk.lines.map(l=>l.spokenText).join(" "), finalBuffer.duration);

          const newCache = { 
              ...chunkCache, 
              [chunk.id]: { buffer: finalBuffer, timings, ratio } 
          };
          setChunkCache(newCache);

          // Re-stitch full audio immediately using updated chunks list (plannedChunks)
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
        const item = val as { buffer: AudioBuffer, timings: WordTiming[], ratio?: number };
        serializedChunkCache[key] = {
            audio: audioBufferToBase64(item.buffer),
            timings: item.timings,
            ratio: item.ratio
        };
    }

    let serializedFullAudio = null;
    if (generationState.audioBuffer) {
      serializedFullAudio = audioBufferToBase64(generationState.audioBuffer);
    }

    const projectData = {
      version: '2.11.5',
      timestamp: new Date().toISOString(),
      script,
      speakers,
      provider, 
      audioCache: serializedCache,
      chunkCache: serializedChunkCache,
      fullAudio: serializedFullAudio,
      fullTimings: generationState.timings,
      plannedChunks,
      logs // Save Logs
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
    addLog('success', 'Project saved with logs.');
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

            // Restore Logs if available
            if (data.logs && Array.isArray(data.logs)) {
                // Rehydrate dates
                const restoredLogs = data.logs.map((l: any) => ({
                    ...l,
                    timestamp: new Date(l.timestamp)
                }));
                setLogs(restoredLogs);
            }

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
            const newChunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[], ratio?: number }> = {};
            if (data.chunkCache) {
                for (const [key, value] of Object.entries(data.chunkCache)) {
                    const v = value as { audio: string, timings: any[], ratio?: number };
                    const bytes = decodeBase64(v.audio);
                    const buffer = await decodeAudioData(bytes, ctx, 24000);
                    newChunkCache[key] = { buffer, timings: v.timings || [], ratio: v.ratio };
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
                     onUpdateTiming={handleUpdateScriptTiming}
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