
import React, { useState, useRef } from 'react';
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
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen, XCircle, FileUp } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: The office, early morning]
[00:00:01.000 -> 00:00:05.000] Speaker: Hello! Import an SRT file to get started with synchronized dubbing.`;

// Default speaker set to Puck, single entry
const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Speaker', voice: VoiceName.Puck, accent: 'Neutral', speed: 'Normal', instructions: '' },
];

const BUILD_REV = "v2.0.0-batched-sync"; 

// --- Batching Types ---
interface ScriptLine {
  originalText: string;
  speakerName: string;
  spokenText: string;
  startTime: number;
  endTime: number | null;
}

interface DubbingChunk {
  speakerName: string;
  lines: ScriptLine[];
  startTime: number;
  endTime: number; // Approximate based on last line
}

export default function App() {
  const [speakers, setSpeakers] = useState<Speaker[]>(INITIAL_SPEAKERS);
  const [script, setScript] = useState(INITIAL_SCRIPT);
  
  const [audioCache, setAudioCache] = useState<Record<string, AudioCacheItem>>({});

  const [generationState, setGenerationState] = useState<GenerationState>({
    isGenerating: false,
    error: null,
    audioBuffer: null,
    timings: null
  });

  const [progressMsg, setProgressMsg] = useState<string>("");

  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  const handleAbort = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setGenerationState(prev => ({ ...prev, isGenerating: false, error: "Generation aborted by user." }));
      setProgressMsg("");
    }
  };

  /**
   * Helper to parse raw script into structured lines
   */
  const parseScriptLines = (rawScript: string): ScriptLine[] => {
    const rawLines = rawScript.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const parsed: ScriptLine[] = [];

    for (const line of rawLines) {
      // Matches: [Start -> End] Speaker: Text  OR [Start] Speaker: Text
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
        // Skip stage directions or lines without timestamps
        continue;
      }

      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) continue;

      const speakerName = content.slice(0, colonIdx).trim();
      let spokenText = content.slice(colonIdx + 1).trim();
      spokenText = spokenText.replace(/\[.*?\]/g, '').trim(); // Remove inline directions from text

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
   * Rules: Same speaker, gap < 600ms, total chunk duration < 15s
   */
  const createDubbingChunks = (lines: ScriptLine[]): DubbingChunk[] => {
    if (lines.length === 0) return [];

    const chunks: DubbingChunk[] = [];
    let currentChunk: DubbingChunk | null = null;

    for (const line of lines) {
      if (!currentChunk) {
        currentChunk = {
          speakerName: line.speakerName,
          lines: [line],
          startTime: line.startTime,
          endTime: line.endTime || (line.startTime + 3) // Fallback if no end time
        };
        continue;
      }

      const prevLine = currentChunk.lines[currentChunk.lines.length - 1];
      const gap = line.startTime - (prevLine.endTime || prevLine.startTime);
      const chunkDuration = (line.endTime || line.startTime) - currentChunk.startTime;

      // Merge criteria
      const isSameSpeaker = line.speakerName === currentChunk.speakerName;
      const isTightGap = gap < 0.6; // 600ms
      const isShortEnough = chunkDuration < 15.0; // Don't let chunks get too massive

      if (isSameSpeaker && isTightGap && isShortEnough) {
        currentChunk.lines.push(line);
        currentChunk.endTime = line.endTime || (line.startTime + 3);
      } else {
        // Push current and start new
        chunks.push(currentChunk);
        currentChunk = {
          speakerName: line.speakerName,
          lines: [line],
          startTime: line.startTime,
          endTime: line.endTime || (line.startTime + 3)
        };
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    return chunks;
  };

  const handleGenerate = async () => {
    if (!script.trim()) {
      setGenerationState(prev => ({ ...prev, error: "Please enter a script." }));
      return;
    }

    setGenerationState({ isGenerating: true, error: null, audioBuffer: null, timings: null });
    setProgressMsg("Parsing script...");
    
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    let audioCtx: AudioContext | null = null;

    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      
      const parsedLines = parseScriptLines(script);
      if (parsedLines.length === 0) throw new Error("No valid dialogue lines found (check timestamps).");

      const chunks = createDubbingChunks(parsedLines);
      const buffers: AudioBuffer[] = [];
      const allTimings: WordTiming[] = [];
      
      let currentTimelineTime = 0;

      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) throw new Error("AbortError");
        
        const chunk = chunks[i];
        setProgressMsg(`Generating chunk ${i + 1} of ${chunks.length}...`);

        // 1. Calculate timing relative to timeline
        const silenceNeeded = chunk.startTime - currentTimelineTime;
        if (silenceNeeded > 0.05) {
          buffers.push(createSilentBuffer(audioCtx, silenceNeeded));
          currentTimelineTime += silenceNeeded;
        }

        // 2. Prepare Prompt
        // Combine text naturally. Remove repeated names/directions for smoother reading.
        const combinedText = chunk.lines.map(l => l.spokenText).join(" ");
        const speaker = speakers.find(s => s.name.toLowerCase() === chunk.speakerName.toLowerCase());
        const voice = speaker ? speaker.voice : VoiceName.Kore;

        // Use formatted prompt but applied to the *Batch*
        const prompt = formatPromptWithSettings(combinedText, speaker);

        // 3. Call API (Rate Limited Internally)
        const base64Audio = await previewSpeakerVoice(voice, prompt);
        const audioBytes = decodeBase64(base64Audio);
        const chunkRawBuffer = await decodeAudioData(audioBytes, audioCtx, 24000);

        // 4. Fit to Duration (Dubbing Sync)
        // Allowed duration is determined by the SRT bounds of the chunk
        let finalChunkBuffer = chunkRawBuffer;
        
        // Duration window defined by SRT
        const targetDuration = chunk.endTime - chunk.startTime;

        // If generated audio is significantly longer than the slot, compress it
        // We give a little leeway (0.2s) before compressing to keep it natural
        if (chunkRawBuffer.duration > (targetDuration + 0.2)) {
           finalChunkBuffer = await fitAudioToMaxDuration(chunkRawBuffer, targetDuration, audioCtx);
        }

        // 5. Generate Timings (Estimate)
        // We distribute timings across the *combined* text
        const chunkTimings = estimateWordTimings(combinedText, finalChunkBuffer.duration);
        const offsetTimings = chunkTimings.map(t => ({
          word: t.word,
          start: t.start + currentTimelineTime,
          end: t.end + currentTimelineTime
        }));

        buffers.push(finalChunkBuffer);
        allTimings.push(...offsetTimings);
        
        currentTimelineTime += finalChunkBuffer.duration;
      }

      if (buffers.length === 0) throw new Error("No audio generated.");

      setProgressMsg("Finalizing audio...");
      const finalBuffer = concatenateAudioBuffers(buffers, audioCtx);

      setGenerationState({
        isGenerating: false,
        error: null,
        audioBuffer: finalBuffer,
        timings: allTimings
      });
      setProgressMsg("");

    } catch (error: any) {
      if (error.message === "AbortError") {
        console.log("Generation aborted.");
      } else {
        console.error(error);
        setGenerationState({
          isGenerating: false,
          error: error.message || "Generation failed.",
          audioBuffer: null,
          timings: null
        });
      }
    } finally {
      if (audioCtx && audioCtx.state !== 'closed') {
        await audioCtx.close();
      }
      abortControllerRef.current = null;
      setProgressMsg("");
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
          alert("Could not parse SRT file or file is empty.");
          return;
       }

       const defaultSpeaker = speakers[0]?.name || "Speaker";
       
       const scriptLines = srtBlocks.map(block => {
          const startTime = formatTimeForScript(block.startSeconds);
          const endTime = formatTimeForScript(block.endSeconds);
          let text = block.text;
          
          const hasSpeaker = /^[A-Za-z0-9_ ]+:/.test(text);
          
          if (!hasSpeaker) {
             text = `${defaultSpeaker}: ${text}`;
          }
          
          // Import with Start -> End format for strict timing
          return `[${startTime} -> ${endTime}] ${text}`;
       });

       setScript(scriptLines.join('\n'));
    };
    reader.readAsText(file);
  };

  const handleSaveProject = () => {
    const serializedCache: Record<string, any> = {};
    for (const [key, val] of Object.entries(audioCache)) {
      const item = val as AudioCacheItem;
      serializedCache[key] = {
        audio: audioBufferToBase64(item.buffer),
        timings: item.timings // Save timings to JSON
      };
    }

    let serializedFullAudio = null;
    if (generationState.audioBuffer) {
      serializedFullAudio = audioBufferToBase64(generationState.audioBuffer);
    }

    const projectData = {
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      script,
      speakers,
      audioCache: serializedCache,
      fullAudio: serializedFullAudio,
      fullTimings: generationState.timings // Save full timings
    };
    
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gemini-tts-project-${new Date().toISOString().slice(0,10)}.json`;
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
            
            const newCache: Record<string, AudioCacheItem> = {};
            if (data.audioCache) {
              for (const [key, value] of Object.entries(data.audioCache)) {
                // Backward compatibility check
                if (typeof value === 'string') {
                   // Old format (just base64)
                   const bytes = decodeBase64(value);
                   const buffer = await decodeAudioData(bytes, ctx, 24000);
                   newCache[key] = { buffer, timings: [] };
                } else {
                   // New format { audio, timings }
                   const v = value as { audio: string, timings: any[] };
                   const bytes = decodeBase64(v.audio);
                   const buffer = await decodeAudioData(bytes, ctx, 24000);
                   newCache[key] = { buffer, timings: v.timings || [] };
                }
              }
            }
            setAudioCache(newCache);

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
              <button 
                onClick={() => srtInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors border-r border-slate-200 pr-4 mr-1"
                title="Import SRT Subtitles"
              >
                <FileUp size={14} />
                Import SRT
              </button>
              <input 
                 type="file" 
                 ref={srtInputRef} 
                 onChange={handleImportSRT} 
                 className="hidden" 
                 accept=".srt" 
              />

              <button 
                onClick={handleSaveProject}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
                title="Save Project to JSON"
              >
                <Save size={14} />
                Save Project
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1"></div>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
                title="Open Project JSON"
              >
                <FolderOpen size={14} />
                Open
              </button>
            </div>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleLoadProject} 
              className="hidden" 
              accept=".json" 
            />

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
                      Assembling...
                    </>
                  ) : (
                    <>
                      <Sparkles size={20} />
                      Generate Full Audio
                    </>
                  )}
                </button>
                
                {progressMsg && (
                    <div className="text-center text-xs text-slate-500 animate-pulse">
                        {progressMsg}
                    </div>
                )}

                {generationState.isGenerating && (
                  <button
                    onClick={handleAbort}
                    className="w-full py-2 px-4 rounded-lg font-medium text-red-600 bg-red-50 border border-red-100 hover:bg-red-100 transition-all flex items-center justify-center gap-2"
                  >
                    <XCircle size={18} />
                    Stop Generation
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
