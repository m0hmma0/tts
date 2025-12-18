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
import { Sparkles, AlertCircle, Loader2, Save, FolderOpen, Headphones } from 'lucide-react';

const INITIAL_SCRIPT = `[Scene: A high-stakes confrontation]
Joe: (angry) Where did you put the files, Jane?
Jane: (whisper) I don't know what you're talking about...
Joe: Don't lie to me! 
Jane: (excited) Wait! I remember now! They're in the safe!
[They both run towards the exit]`;

const INITIAL_SPEAKERS: Speaker[] = [
  { id: '1', name: 'Joe', voice: VoiceName.Onyx, accent: 'UK', speed: 'Normal', defaultEmotion: 'Neutral' },
  { id: '2', name: 'Jane', voice: VoiceName.Nova, accent: 'Australian', speed: 'Normal', defaultEmotion: 'Neutral' },
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
           const messageRaw = line.slice(colonIdx + 1).trim();
           if (!messageRaw) continue;

           const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
           const voice = speaker ? speaker.voice : VoiceName.Alloy;

           // generateLineAudio handles emotion tags within messageRaw internally via formatPromptWithSettings
           const base64Audio = await generateLineAudio(voice, messageRaw, speaker);
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
    link.download = `openai-tts-studio-pro-${new Date().toISOString().slice(0,10)}.json`;
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
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 font-sans selection:bg-indigo-500/30">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-8 border-b border-slate-800">
          <div className="space-y-1">
            <h1 className="text-4xl font-black text-white flex items-center gap-3 tracking-tight">
              <span className="p-2.5 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl shadow-2xl shadow-indigo-500/20">
                <Headphones className="text-white" size={32} />
              </span>
              VOICE STUDIO <span className="text-indigo-500">PRO</span>
            </h1>
            <p className="text-slate-400 font-medium">Advanced Multi-Speaker TTS with Emotion & Accent Control.</p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center bg-slate-900 p-1.5 rounded-xl border border-slate-800 shadow-inner">
              <button onClick={handleSaveProject} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all active:scale-95"><Save size={16} />Save Project</button>
              <div className="w-px h-6 bg-slate-800 mx-1"></div>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all active:scale-95"><FolderOpen size={16} />Load Project</button>
            </div>
            <input type="file" ref={fileInputRef} onChange={handleLoadProject} className="hidden" accept=".json" />
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-4 space-y-8 sticky top-8">
            <SpeakerManager speakers={speakers} setSpeakers={setSpeakers} />
            
            <div className="bg-slate-900/40 rounded-2xl p-6 border border-slate-800 backdrop-blur-sm space-y-4">
              <button
                onClick={handleGenerate}
                disabled={generationState.isGenerating}
                className={`w-full py-4 px-6 rounded-xl font-bold text-white shadow-xl transition-all flex items-center justify-center gap-3 text-lg ${generationState.isGenerating ? 'bg-slate-800 cursor-not-allowed text-slate-500' : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:shadow-indigo-500/20 hover:scale-[1.02] active:scale-98'}`}
              >
                {generationState.isGenerating ? <><Loader2 className="animate-spin" size={24} /> Generating Master Mix...</> : <><Sparkles size={24} /> Render Script</>}
              </button>
              
              {generationState.error && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 text-red-200 text-sm animate-in fade-in zoom-in duration-300">
                  <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-400" />
                  <p>{generationState.error}</p>
                </div>
              )}

              {generationState.audioBuffer && (
                <div className="animate-in fade-in slide-in-from-bottom-6 duration-700 delay-150">
                  <AudioPlayer audioBuffer={generationState.audioBuffer} />
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-8 min-h-[600px] h-[calc(100vh-250px)]">
             <ScriptEditor script={script} setScript={setScript} speakers={speakers} audioCache={audioCache} setAudioCache={setAudioCache} />
          </div>
        </main>
      </div>
    </div>
  );
}