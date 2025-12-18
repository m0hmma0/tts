
import React, { useState, useRef } from 'react';
import { SpeakerManager } from './components/SpeakerManager';
import { ScriptEditor } from './components/ScriptEditor';
import { AudioPlayer } from './components/AudioPlayer';
import { generateLineAudio, formatPromptWithSettings } from './services/openaiService';
import { 
  decodeBase64, 
  decodeAudioData, 
  concatenateAudioBuffers,
  audioBufferToBase64
} from './utils/audioUtils';
import { Speaker, VoiceName, GenerationState } from './types';
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: The office, early morning]
Joe: (cheerfully) How's it going today Jane?
Jane: [Sips coffee] (sleepily) Not too bad, how about you?
[They clink mugs]
Joe: (excitedly) Can't complain. Just testing out this new studio powered by gpt-4o-mini-tts.
Jane: (impressed) It sounds incredible!`;

const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Joe', voice: VoiceName.Onyx, accent: 'Neutral', speed: 'Normal' },
  { id: '2', name: 'Jane', voice: VoiceName.Nova, accent: 'Neutral', speed: 'Normal' },
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
    let audioCtx: AudioContext | null = null;

    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
      const lines = script.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const buffers: AudioBuffer[] = [];
      
      for (let i = 0; i < lines.length; i++) {
         const line = lines[i];
         if (line.startsWith('[')) continue; 

         const colonIdx = line.indexOf(':');
         if (colonIdx === -1) continue;

         const key = line;
         let speechBuffer: AudioBuffer | null = null;
         
         if (audioCache[key]) {
           speechBuffer = audioCache[key];
         } else {
           const speakerName = line.slice(0, colonIdx).trim();
           // In this implementation, the OpenAI service will handle context hints within the text
           const message = line.slice(colonIdx + 1).replace(/\[.*?\]/g, '').trim();
           if (!message) continue;

           const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
           const voice = speaker ? speaker.voice : VoiceName.Alloy;

           const base64Audio = await generateLineAudio(voice, message, speaker);
           const audioBytes = decodeBase64(base64Audio);
           speechBuffer = await decodeAudioData(audioBytes, audioCtx, 24000);
           
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
      if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close();
    }
  };

  const handleSaveProject = () => {
    const serializedCache: Record<string, string> = {};
    for (const [key, buffer] of Object.entries(audioCache)) {
      serializedCache[key] = audioBufferToBase64(buffer as AudioBuffer);
    }
    const projectData = {
      version: '1.2',
      script,
      speakers,
      audioCache: serializedCache
    };
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `openai-tts-project-${new Date().toISOString().slice(0,10)}.json`;
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
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
            const newCache: Record<string, AudioBuffer> = {};
            if (data.audioCache) {
              for (const [key, b64] of Object.entries(data.audioCache)) {
                const bytes = decodeBase64(b64 as string);
                newCache[key] = await decodeAudioData(bytes, ctx, 24000);
              }
            }
            setAudioCache(newCache);
            ctx.close();
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
              <span className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-900/50">
                <Sparkles className="text-white" size={24} />
              </span>
              OpenAI Speech Studio
            </h1>
            <p className="mt-2 text-slate-400">Multi-speaker dialogue powered by GPT-4o Mini TTS.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800">
              <button onClick={handleSaveProject} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"><Save size={14} />Save</button>
              <div className="w-px h-4 bg-slate-800 mx-1"></div>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"><FolderOpen size={14} />Open</button>
            </div>
            <input type="file" ref={fileInputRef} onChange={handleLoadProject} className="hidden" accept=".json" />
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 bg-slate-900 px-3 py-2 rounded-lg border border-slate-800">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
                gpt-4o-mini-tts
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
                className={`w-full py-3 px-4 rounded-lg font-semibold text-white shadow-lg transition-all flex items-center justify-center gap-2 ${generationState.isGenerating ? 'bg-slate-700' : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:scale-[1.02]'}`}
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
