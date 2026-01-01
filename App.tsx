
import React, { useState, useRef, useEffect } from 'react';
import { SpeakerManager } from './components/SpeakerManager';
import { ScriptEditor } from './components/ScriptEditor';
import { AudioPlayer } from './components/AudioPlayer';
import { previewSpeakerVoice, formatPromptWithSettings } from './services/geminiService';
import { 
  decodeBase64, 
  decodeAudioData, 
  concatenateAudioBuffers,
  audioBufferToBase64,
  estimateWordTimings,
  createSilentBuffer,
  fitAudioToMaxDuration
} from './utils/audioUtils';
import { parseSRT, formatTimeForScript, parseScriptTimestamp } from './utils/srtUtils';
import { Speaker, VoiceName, GenerationState, AudioCacheItem, WordTiming } from './types';
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen, XCircle, FileUp, Layers, Trash2 } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: The office, early morning]
[00:00:01.000 -> 00:00:05.000] Speaker: Hello! Import an SRT file to get started with synchronized dubbing.`;

// Default speaker set to Puck, single entry
const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Speaker', voice: VoiceName.Puck, accent: 'Neutral', speed: 'Normal', instructions: '' },
];

const BUILD_REV = "v2.2.0-immediate-stop"; 

// --- Batching Types ---
interface ScriptLine {
  originalText: string;
  speakerName: string;
  spokenText: string;
  startTime: number;
  endTime: number | null;
}

interface DubbingChunk {
  id: string; // Unique hash for caching
  speakerName: string;
  lines: ScriptLine[];
  startTime: number;
  endTime: number;
  textHash: string;
}

// Helper to generate a unique key for a chunk based on its content and timing target
const generateChunkHash = (chunk: Omit<DubbingChunk, 'id'>): string => {
    // We include text, speaker, and exact duration target. 
    // If user changes timing, we must regenerate to fit new duration.
    const content = chunk.speakerName + chunk.lines.map(l => l.spokenText).join('') + chunk.startTime.toFixed(3) + chunk.endTime.toFixed(3);
    // Simple hash function
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
  
  // Cache for single line previews
  const [audioCache, setAudioCache] = useState<Record<string, AudioCacheItem>>({});

  // Cache for batch generation chunks (Persists across errors)
  const [chunkCache, setChunkCache] = useState<Record<string, { buffer: AudioBuffer, timings: WordTiming[] }>>({});

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

  const handleAbort = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      // Explicitly set paused state here. 
      // The generation loop catch block will see the AbortError and should NOT overwrite this message.
      setGenerationState(prev => ({ ...prev, isGenerating: false, error: "Generation paused by user. Click Resume to continue." }));
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

    // Assign IDs
    return rawChunks.map(c => ({
        ...c,
        id: generateChunkHash(c)
    }));
  };

  const handleClearCache = () => {
    if (confirm("Are you sure? This will delete all generated chunks and you will have to regenerate everything from scratch.")) {
        setChunkCache({});
        setGenerationState(prev => ({ ...prev, audioBuffer: null, timings: null }));
    }
  };

  const handleGenerate = async () => {
    if (!script.trim()) {
      setGenerationState(prev => ({ ...prev, error: "Please enter a script." }));
      return;
    }

    setGenerationState(prev => ({ ...prev, isGenerating: true, error: null }));
    setProgressMsg("Preparing...");
    
    // Create a new controller for THIS generation run
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    let audioCtx: AudioContext | null = null;

    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      
      const parsedLines = parseScriptLines(script);
      if (parsedLines.length === 0) throw new Error("No valid dialogue lines found (check timestamps).");

      const chunks = createDubbingChunks(parsedLines);
      setTotalChunksCount(chunks.length);
      
      const orderedBuffers: AudioBuffer[] = [];
      const orderedTimings: WordTiming[] = [];
      
      let currentTimelineTime = 0;
      let newlyGeneratedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        // Critical: Check abort at start of loop iteration
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        
        const chunk = chunks[i];
        setCompletedChunksCount(i);
        
        // 1. Calculate Silence
        const silenceNeeded = chunk.startTime - currentTimelineTime;
        if (silenceNeeded > 0.05) {
          orderedBuffers.push(createSilentBuffer(audioCtx, silenceNeeded));
          currentTimelineTime += silenceNeeded;
        }

        // 2. Check Cache
        let finalChunkBuffer: AudioBuffer;
        let chunkTimings: WordTiming[];

        if (chunkCache[chunk.id]) {
            // CACHE HIT - Skip API
            setProgressMsg(`Using cached chunk ${i + 1}/${chunks.length}...`);
            finalChunkBuffer = chunkCache[chunk.id].buffer;
            const cachedT = chunkCache[chunk.id].timings;
            chunkTimings = cachedT;
            // Allow UI update
            await new Promise(r => setTimeout(r, 10)); 
        } else {
            // CACHE MISS - Call API
            const combinedText = chunk.lines.map(l => l.spokenText).join(" ");
            const speaker = speakers.find(s => s.name.toLowerCase() === chunk.speakerName.toLowerCase());
            const voice = speaker ? speaker.voice : VoiceName.Kore;

            const prompt = formatPromptWithSettings(combinedText, speaker);

            let base64Audio: string;
            try {
              // Pass signal and callback
              base64Audio = await previewSpeakerVoice(voice, prompt, (status) => {
                 setProgressMsg(`Chunk ${i+1}: ${status}`);
              }, signal);
            } catch (apiErr: any) {
               // If aborted inside service, it rethrows AbortError. Catch it here and rethrow to break loop.
               if (apiErr.name === "AbortError") throw apiErr;

               console.error("API Error on chunk", i, apiErr);
               throw new Error(`Failed to generate chunk ${i+1}: ${apiErr.message}`);
            }

            const audioBytes = decodeBase64(base64Audio);
            const chunkRawBuffer = await decodeAudioData(audioBytes, audioCtx, 24000);

            // Fit to Duration
            finalChunkBuffer = chunkRawBuffer;
            const targetDuration = chunk.endTime - chunk.startTime;
            if (chunkRawBuffer.duration > (targetDuration + 0.5)) {
               finalChunkBuffer = await fitAudioToMaxDuration(chunkRawBuffer, targetDuration, audioCtx);
            }

            // Estimate Timings
            chunkTimings = estimateWordTimings(combinedText, finalChunkBuffer.duration);

            // SAVE TO CACHE
            setChunkCache(prev => ({
                ...prev,
                [chunk.id]: { buffer: finalChunkBuffer, timings: chunkTimings }
            }));
            newlyGeneratedCount++;
        }

        // 3. Append to Timeline
        const offsetTimings = chunkTimings.map(t => ({
          word: t.word,
          start: t.start + currentTimelineTime,
          end: t.end + currentTimelineTime
        }));

        orderedBuffers.push(finalChunkBuffer);
        orderedTimings.push(...offsetTimings);
        
        currentTimelineTime += finalChunkBuffer.duration;
      }

      setCompletedChunksCount(chunks.length);
      setProgressMsg("Finalizing audio...");
      
      if (orderedBuffers.length === 0) throw new Error("No audio generated.");

      const finalBuffer = concatenateAudioBuffers(orderedBuffers, audioCtx);

      setGenerationState({
        isGenerating: false,
        error: null,
        audioBuffer: finalBuffer,
        timings: orderedTimings
      });
      setProgressMsg(newlyGeneratedCount === 0 ? "Loaded all from cache!" : "Generation Complete!");

    } catch (error: any) {
      if (error.name === "AbortError" || error.message === "AbortError") {
        console.log("Generation loop terminated via AbortSignal.");
        // We do NOT reset state here because handleAbort() sets the UI to "Paused".
        // We just exit cleanly.
      } else {
        console.error(error);
        setGenerationState(prev => ({
          ...prev,
          isGenerating: false,
          error: error.message || "Generation failed.",
        }));
      }
    } finally {
      if (audioCtx && audioCtx.state !== 'closed') {
        await audioCtx.close();
      }
      abortControllerRef.current = null;
      
      // Clean up success message
      setTimeout(() => { 
        if (!generationState.error) setProgressMsg(""); 
      }, 3000);
    }
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
    };
    reader.readAsText(file);
  };

  const handleSaveProject = () => {
    // Save both preview cache and chunk cache
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
      version: '2.2.0',
      timestamp: new Date().toISOString(),
      script,
      speakers,
      audioCache: serializedCache,
      chunkCache: serializedChunkCache,
      fullAudio: serializedFullAudio,
      fullTimings: generationState.timings
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
        } else {
            alert("Invalid project file structure.");
        }
      } catch (err) {
        console.error("Failed to load project", err);
        alert("Failed to load project file.");
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
            <p className="mt-2 text-slate-500">Generate realistic multi-speaker dialogue with stage directions.</p>
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
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-white px-3 py-2 rounded-lg border border-slate-200 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  gemini-2.5-flash
              </div>
              <div className="mt-2 text-xs font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 tracking-wide">
                BUILD: {BUILD_REV}
              </div>
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
          
          <div className="lg:col-span-1 space-y-6">
            <SpeakerManager speakers={speakers} setSpeakers={setSpeakers} />
            
            <div className="bg-white rounded-xl p-6 border border-slate-200 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">Actions</h3>
              
              <div className="space-y-3">
                <button
                  onClick={handleGenerate}
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

          <div className="lg:col-span-2 min-h-[500px]">
             <ScriptEditor 
               script={script} 
               setScript={setScript} 
               speakers={speakers}
               audioCache={audioCache}
               setAudioCache={setAudioCache}
             />
          </div>

        </main>

        <footer className="text-center text-slate-400 text-sm pt-8 pb-4">
          Powered by Google Gemini 2.5 Flash • Web Audio API • React • Build {BUILD_REV}
        </footer>
      </div>
    </div>
  );
}
