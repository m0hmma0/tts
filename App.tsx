import React, { useState, useRef } from 'react';
import { SpeakerManager } from './components/SpeakerManager';
import { ScriptEditor } from './components/ScriptEditor';
import { AudioPlayer } from './components/AudioPlayer';
import { previewSpeakerVoice, formatPromptWithSettings } from './services/geminiService';
import { 
  decodeBase64, 
  decodeAudioData, 
  concatenateAudioBuffers,
  audioBufferToBase64
} from './utils/audioUtils';
import { Speaker, VoiceName, GenerationState } from './types';
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: The office, early morning]
Joe: How's it going today Jane?
Jane: (Cheerfully) Not too bad, how about you?
[They clink mugs]
Joe: Can't complain. Just testing out this new speech studio.
Jane: (Whispering) It sounds incredible! [She looks amazed]`;

const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Joe', voice: VoiceName.Kore, accent: 'Neutral', speed: 'Normal' },
  { id: '2', name: 'Jane', voice: VoiceName.Puck, accent: 'Neutral', speed: 'Normal' },
];

export default function App() {
  const [speakers, setSpeakers] = useState<Speaker[]>(INITIAL_SPEAKERS);
  const [script, setScript] = useState(INITIAL_SCRIPT);
  
  // Shared cache for audio lines (speech only)
  const [audioCache, setAudioCache] = useState<Record<string, AudioBuffer>>({});

  const [generationState, setGenerationState] = useState<GenerationState>({
    isGenerating: false,
    error: null,
    audioBuffer: null,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleGenerate = async () => {
    if (!script.trim()) {
      setGenerationState(prev => ({ ...prev, error: "Please enter a script." }));
      return;
    }

    setGenerationState({ isGenerating: true, error: null, audioBuffer: null });

    let audioCtx: AudioContext | null = null;

    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      
      const lines = script.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const buffers: AudioBuffer[] = [];
      
      // Iterate and Collect Audio
      for (let i = 0; i < lines.length; i++) {
         const line = lines[i];

         // IGNORE bracketed lines completely (Comments)
         if (line.startsWith('[')) {
           continue; 
         }

         // Handle Dialogue
         const colonIdx = line.indexOf(':');
         if (colonIdx === -1) continue;

         const key = line;
         let speechBuffer: AudioBuffer | null = null;
         
         if (audioCache[key]) {
           speechBuffer = audioCache[key];
         } else {
           // Add a substantial delay between requests to avoid hitting rate limits (RPM)
           // Gemini Free Tier is approx 15 RPM (1 request every 4 seconds).
           // We'll set a 2-second delay which, combined with execution time, should be safe for moderate bursts.
           if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
           }

           const speakerName = line.slice(0, colonIdx).trim();
           // Strip comments [ ... ] from the message sent to the API
           const rawMessage = line.slice(colonIdx + 1).trim();
           const message = rawMessage.replace(/\[.*?\]/g, '').trim();

           if (!message) continue;

           const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
           const voice = speaker ? speaker.voice : VoiceName.Kore;

           // Apply Speaker Settings (Accent, Speed)
           const prompt = formatPromptWithSettings(message, speaker);

           const base64Audio = await previewSpeakerVoice(voice, prompt);
           const audioBytes = decodeBase64(base64Audio);
           speechBuffer = await decodeAudioData(audioBytes, audioCtx, 24000) as AudioBuffer;
           
           const bufferToCache = speechBuffer;
           setAudioCache(prev => ({ ...prev, [key]: bufferToCache }));
         }

         if (speechBuffer) {
           buffers.push(speechBuffer);
         }
      }

      if (buffers.length === 0) {
        throw new Error("No dialogue lines found to generate.");
      }

      // Explicitly cast to AudioBuffer | null to resolve potential type inference issues
      const finalBuffer = concatenateAudioBuffers(buffers, audioCtx) as AudioBuffer | null;

      setGenerationState({
        isGenerating: false,
        error: null,
        audioBuffer: finalBuffer,
      });

    } catch (error: any) {
      console.error(error);
      setGenerationState({
        isGenerating: false,
        error: error.message || "Something went wrong generating the audio.",
        audioBuffer: null,
      });
    } finally {
      // CRITICAL: Close the context to free up hardware resources.
      // Browsers limit the number of active AudioContexts (often to 6).
      if (audioCtx && audioCtx.state !== 'closed') {
        await audioCtx.close();
      }
    }
  };

  const handleSaveProject = () => {
    // Serialize audio cache (AudioBuffer -> Base64)
    const serializedCache: Record<string, string> = {};
    for (const [key, buffer] of Object.entries(audioCache)) {
      serializedCache[key] = audioBufferToBase64(buffer as AudioBuffer);
    }

    // Serialize full audio result if it exists
    let serializedFullAudio = null;
    if (generationState.audioBuffer) {
      serializedFullAudio = audioBufferToBase64(generationState.audioBuffer);
    }

    const projectData = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      script,
      speakers,
      audioCache: serializedCache,
      fullAudio: serializedFullAudio
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

    // Reset value to ensure the same file triggers change again if selected
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        
        if (data.script && Array.isArray(data.speakers)) {
            setScript(data.script);
            setSpeakers(data.speakers);
            
            // Rehydrate Audio Cache and Playback
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
            
            const newCache: Record<string, AudioBuffer> = {};
            if (data.audioCache) {
              for (const [key, b64] of Object.entries(data.audioCache)) {
                if (typeof b64 === 'string') {
                  const bytes = decodeBase64(b64);
                  // Decoding is async
                  newCache[key] = await decodeAudioData(bytes, ctx, 24000);
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
                audioBuffer: fullBuffer
            });
            
            // Clean up temporary context
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
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <span className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-900/50">
                <Sparkles className="text-white" size={24} />
              </span>
              Gemini TTS Studio
            </h1>
            <p className="mt-2 text-slate-400">Generate realistic multi-speaker dialogue with stage directions.</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            {/* Project Controls */}
            <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800">
              <button 
                onClick={handleSaveProject}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
                title="Save Project to JSON (Including Audio)"
              >
                <Save size={14} />
                Save
              </button>
              <div className="w-px h-4 bg-slate-800 mx-1"></div>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
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

            {/* Model Badge */}
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 bg-slate-900 px-3 py-2 rounded-lg border border-slate-800">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                gemini-2.5-flash
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
          
          {/* Left Column: Configuration */}
          <div className="lg:col-span-1 space-y-6">
            <SpeakerManager speakers={speakers} setSpeakers={setSpeakers} />
            
            {/* Action Area */}
            <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Actions</h3>
              
              <button
                onClick={handleGenerate}
                disabled={generationState.isGenerating}
                className={`w-full py-3 px-4 rounded-lg font-semibold text-white shadow-lg transition-all flex items-center justify-center gap-2
                  ${generationState.isGenerating 
                    ? 'bg-slate-700 cursor-wait' 
                    : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 hover:scale-[1.02]'
                  }`}
              >
                {generationState.isGenerating ? (
                  <>
                    <Loader2 className="animate-spin" size={20} />
                    Assembling Audio...
                  </>
                ) : (
                  <>
                    <Sparkles size={20} />
                    Generate Full Audio
                  </>
                )}
              </button>

              {generationState.error && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 text-red-200 text-sm">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <p>{generationState.error}</p>
                </div>
              )}
            </div>

             {/* Audio Player (Shows only when buffer exists) */}
             {generationState.audioBuffer && (
               <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                 <AudioPlayer audioBuffer={generationState.audioBuffer} />
               </div>
             )}

          </div>

          {/* Right Column: Script Editor */}
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

        <footer className="text-center text-slate-600 text-sm pt-8 pb-4">
          Powered by Google Gemini 2.5 Flash • Web Audio API • React
        </footer>
      </div>
    </div>
  );
}