
import React, { useState, useRef } from 'react';
import { SpeakerManager } from './components/SpeakerManager';
import { ScriptEditor } from './components/ScriptEditor';
import { AudioPlayer } from './components/AudioPlayer';
import { generateLineAudio } from './services/elevenLabsService';
import { 
  decodeBase64, 
  decodeAudioData, 
  concatenateAudioBuffers,
  audioBufferToBase64
} from './utils/audioUtils';
import { Speaker, VoiceName, GenerationState } from './types';
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen, Mic2 } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: A dark room]
Antoni: (whispering) Did you hear that?
Bella: [Looks around nervously] (panicked) Hear what? I didn't hear anything!
Antoni: (intensely) It sounded like... ElevenLabs is actually working.
Bella: (relieved) Oh, thank goodness. I thought it was a ghost.`;

const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Antoni', voice: VoiceName.Antoni, accent: 'Neutral', speed: 'Normal' },
  { id: '2', name: 'Bella', voice: VoiceName.Bella, accent: 'Neutral', speed: 'Normal' },
];

export default function App() {
  const [speakers, setSpeakers] = useState<Speaker[]>(INITIAL_SPEAKERS);
  const [script, setScript] = useState(INITIAL_SCRIPT);
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
    const audioCtx = new AudioContext();

    try {
      const lines = script.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const buffers: AudioBuffer[] = [];
      
      for (const line of lines) {
         if (line.startsWith('[')) continue; 
         const colonIdx = line.indexOf(':');
         if (colonIdx === -1) continue;

         const key = line;
         let speechBuffer: AudioBuffer | null = null;
         
         if (audioCache[key]) {
           speechBuffer = audioCache[key];
         } else {
           const speakerName = line.slice(0, colonIdx).trim();
           const message = line.slice(colonIdx + 1).trim();
           if (!message) continue;

           const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
           const voice = speaker ? speaker.voice : VoiceName.Rachel;

           const base64Audio = await generateLineAudio(voice, message, speaker);
           const audioBytes = decodeBase64(base64Audio);
           speechBuffer = await decodeAudioData(audioBytes, audioCtx);
           
           setAudioCache(prev => ({ ...prev, [key]: speechBuffer! }));
         }

         if (speechBuffer) buffers.push(speechBuffer);
      }

      if (buffers.length === 0) throw new Error("No dialogue lines found.");
      const finalBuffer = concatenateAudioBuffers(buffers, audioCtx);
      setGenerationState({ isGenerating: false, error: null, audioBuffer: finalBuffer });

    } catch (error: any) {
      setGenerationState({
        isGenerating: false,
        error: error.message || "Something went wrong generating the audio.",
        audioBuffer: null,
      });
    } finally {
      // AudioContext is needed by AudioPlayer later, but we used a temporary one for decoding
    }
  };

  const handleSaveProject = () => {
    const serializedCache: Record<string, string> = {};
    for (const [key, buffer] of Object.entries(audioCache)) {
      serializedCache[key] = audioBufferToBase64(buffer as AudioBuffer);
    }
    const projectData = { version: '1.4-eleven', script, speakers, audioCache: serializedCache };
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `eleven-labs-project-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadProject = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.script && Array.isArray(data.speakers)) {
            setScript(data.script);
            setSpeakers(data.speakers);
            const ctx = new AudioContext();
            const newCache: Record<string, AudioBuffer> = {};
            if (data.audioCache) {
              for (const [key, b64] of Object.entries(data.audioCache)) {
                const bytes = decodeBase64(b64 as string);
                newCache[key] = await decodeAudioData(bytes, ctx);
              }
            }
            setAudioCache(newCache);
        }
      } catch (err) { alert("Failed to load project file."); }
    };
    reader.readAsText(file);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <span className="p-2 bg-pink-600 rounded-lg shadow-lg shadow-pink-900/50">
                <Mic2 className="text-white" size={24} />
              </span>
              ElevenLabs Studio
            </h1>
            <p className="mt-2 text-slate-400">Cinematic multi-speaker dialogue with v2 Multilingual.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800">
              <button onClick={handleSaveProject} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"><Save size={14} />Save</button>
              <div className="w-px h-4 bg-slate-800 mx-1"></div>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"><FolderOpen size={14} />Open</button>
            </div>
            <input type="file" ref={fileInputRef} onChange={handleLoadProject} className="hidden" accept=".json" />
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 bg-slate-900 px-3 py-2 rounded-lg border border-slate-800">
                <span className="w-2 h-2 rounded-full bg-pink-500 animate-pulse"></span>
                v2 Multilingual
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
          <div className="lg:col-span-1 space-y-6">
            <SpeakerManager speakers={speakers} setSpeakers={setSpeakers} />
            <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
              <button
                onClick={handleGenerate}
                disabled={generationState.isGenerating}
                className={`w-full py-3 px-4 rounded-lg font-semibold text-white shadow-lg transition-all flex items-center justify-center gap-2 ${generationState.isGenerating ? 'bg-slate-700' : 'bg-gradient-to-r from-pink-600 to-rose-600 hover:scale-[1.02]'}`}
              >
                {generationState.isGenerating ? <><Loader2 className="animate-spin" size={20} /> Generating...</> : <><Sparkles size={20} /> Generate Full Audio</>}
              </button>
              {generationState.error && <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 text-red-200 text-sm"><AlertCircle size={16} className="mt-0.5 shrink-0" /><p>{generationState.error}</p></div>}
            </div>
             {generationState.audioBuffer && <div className="animate-in fade-in slide-in-from-bottom-4 duration-500"><AudioPlayer audioBuffer={generationState.audioBuffer} /></div>}
          </div>
          <div className="lg:col-span-2 min-h-[500px]">
             <ScriptEditor script={script} setScript={setScript} speakers={speakers} audioCache={audioCache} setAudioCache={setAudioCache} />
          </div>
        </main>
      </div>
    </div>
  );
}
