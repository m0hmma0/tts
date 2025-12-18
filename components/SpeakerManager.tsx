import React, { useState, useRef, useEffect } from 'react';
import { Speaker, VoiceName, AccentType } from '../types';
import { Plus, Trash2, User, Play, Loader2, Square, Gauge, Globe, Smile } from 'lucide-react';
import { generateLineAudio } from '../services/openaiService';
import { decodeBase64, decodeAudioData } from '../utils/audioUtils';

interface SpeakerManagerProps {
  speakers: Speaker[];
  setSpeakers: React.Dispatch<React.SetStateAction<Speaker[]>>;
}

const SPEEDS = ['Very Slow', 'Slow', 'Normal', 'Fast', 'Very Fast'];
const ACCENTS: AccentType[] = ['Neutral', 'Indian', 'UK', 'US', 'Australian'];
const EMOTIONS = ['Neutral', 'Angry', 'Happy', 'Sad', 'Excited', 'Serious', 'Whisper'];

export const SpeakerManager: React.FC<SpeakerManagerProps> = ({ speakers, setSpeakers }) => {
  const [previewState, setPreviewState] = useState<{ id: string; status: 'loading' | 'playing' } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    return () => {
      if (sourceRef.current) try { sourceRef.current.stop(); } catch (e) {}
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, []);

  const addSpeaker = () => {
    setSpeakers([...speakers, {
      id: crypto.randomUUID(),
      name: `Speaker ${speakers.length + 1}`,
      voice: VoiceName.Alloy,
      accent: 'Neutral',
      speed: 'Normal',
      defaultEmotion: 'Neutral'
    }]);
  };

  const removeSpeaker = (id: string) => {
    if (previewState?.id === id) {
      if (sourceRef.current) try { sourceRef.current.stop(); } catch (e) {}
      setPreviewState(null);
    }
    setSpeakers(speakers.filter((s) => s.id !== id));
  };

  const updateSpeaker = (id: string, field: keyof Speaker, value: any) => {
    setSpeakers(speakers.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };

  const handlePreview = async (speaker: Speaker) => {
    if (previewState?.id === speaker.id) {
      if (sourceRef.current) try { sourceRef.current.stop(); } catch (e) {}
      setPreviewState(null);
      return;
    }
    if (sourceRef.current) try { sourceRef.current.stop(); } catch (e) {}
    setPreviewState({ id: speaker.id, status: 'loading' });

    try {
      const sampleText = `Hi, I'm ${speaker.name}. I am using a ${speaker.accent} style with a ${speaker.defaultEmotion} tone.`;
      const base64Audio = await generateLineAudio(speaker.voice, sampleText, speaker);
      
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const audioBytes = decodeBase64(base64Audio);
      const buffer = await decodeAudioData(audioBytes, audioContextRef.current, 24000);

      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      sourceRef.current = source;
      source.onended = () => setPreviewState(null);
      source.start();
      setPreviewState({ id: speaker.id, status: 'playing' });
    } catch (error) {
      console.error(error);
      setPreviewState(null);
    }
  };

  return (
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700 max-h-[70vh] overflow-y-auto">
      <div className="flex justify-between items-center mb-4 sticky top-0 bg-slate-900/10 backdrop-blur-md z-10 pb-2">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2"><User size={20} className="text-blue-400" />Cast</h2>
        <button onClick={addSpeaker} className="flex items-center gap-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-full transition-colors shadow-lg shadow-blue-900/20">
          <Plus size={14} /> Add Speaker
        </button>
      </div>
      <div className="space-y-4">
        {speakers.map((speaker) => (
          <div key={speaker.id} className="flex flex-col gap-3 bg-slate-900/80 p-4 rounded-xl border border-slate-700/50 shadow-inner group">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
              <div className="flex-1 w-full">
                <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 tracking-wider">Name</label>
                <input type="text" value={speaker.name} onChange={(e) => updateSpeaker(speaker.id, 'name', e.target.value)} className="w-full bg-slate-800 text-slate-200 text-sm px-3 py-2 rounded-lg border border-slate-700 focus:border-blue-500 transition-colors outline-none" />
              </div>
              <div className="flex-1 w-full">
                <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 tracking-wider">Base Voice</label>
                <div className="flex gap-2">
                  <select value={speaker.voice} onChange={(e) => updateSpeaker(speaker.id, 'voice', e.target.value as VoiceName)} className="w-full bg-slate-800 text-slate-200 text-sm px-3 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none">
                    {Object.values(VoiceName).map((v) => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
                  </select>
                  <button onClick={() => handlePreview(speaker)} className={`shrink-0 w-[40px] h-[38px] flex items-center justify-center rounded-lg border transition-all ${previewState?.id === speaker.id ? 'bg-blue-500/20 border-blue-500 text-blue-400' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'}`}>
                    {previewState?.id === speaker.id ? (previewState.status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} fill="currentColor" />) : <Play size={16} fill="currentColor" />}
                  </button>
                </div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-800/50">
               <div>
                  <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 flex items-center gap-1"><Globe size={10} /> Accent</label>
                  <select value={speaker.accent || 'Neutral'} onChange={(e) => updateSpeaker(speaker.id, 'accent', e.target.value)} className="w-full bg-slate-800 text-slate-300 text-xs px-2 py-2 rounded-lg border border-slate-700 outline-none focus:border-blue-500">
                    {ACCENTS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
               </div>
               <div>
                  <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 flex items-center gap-1"><Smile size={10} /> Emotion</label>
                  <select value={speaker.defaultEmotion || 'Neutral'} onChange={(e) => updateSpeaker(speaker.id, 'defaultEmotion', e.target.value)} className="w-full bg-slate-800 text-slate-300 text-xs px-2 py-2 rounded-lg border border-slate-700 outline-none focus:border-blue-500">
                    {EMOTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
               </div>
               <div className="col-span-2 sm:col-span-1 flex items-end justify-between sm:justify-start gap-2">
                  <div className="flex-1">
                    <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 flex items-center gap-1"><Gauge size={10} /> Speed</label>
                    <select value={speaker.speed || 'Normal'} onChange={(e) => updateSpeaker(speaker.id, 'speed', e.target.value)} className="w-full bg-slate-800 text-slate-300 text-xs px-2 py-2 rounded-lg border border-slate-700 outline-none focus:border-blue-500">
                      {SPEEDS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <button onClick={() => removeSpeaker(speaker.id)} className="p-2 text-slate-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"><Trash2 size={16} /></button>
               </div>
            </div>
          </div>
        ))}
        {speakers.length === 0 && (
          <div className="py-12 text-center border-2 border-dashed border-slate-800 rounded-xl">
            <p className="text-slate-500 text-sm">No speakers added. Click "Add Speaker" to begin.</p>
          </div>
        )}
      </div>
    </div>
  );
};