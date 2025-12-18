import React, { useState, useRef, useEffect } from 'react';
import { Speaker, VoiceName } from '../types';
import { Plus, Trash2, User, Play, Loader2, Square, Gauge } from 'lucide-react';
import { generateLineAudio } from '../services/openaiService';
import { decodeBase64, decodeAudioData } from '../utils/audioUtils';

interface SpeakerManagerProps {
  speakers: Speaker[];
  setSpeakers: React.Dispatch<React.SetStateAction<Speaker[]>>;
}

const SPEEDS = ['Very Slow', 'Slow', 'Normal', 'Fast', 'Very Fast'];

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
      speed: 'Normal'
    }]);
  };

  const removeSpeaker = (id: string) => {
    if (previewState?.id === id) {
      if (sourceRef.current) try { sourceRef.current.stop(); } catch (e) {}
      setPreviewState(null);
    }
    setSpeakers(speakers.filter((s) => s.id !== id));
  };

  const updateSpeaker = (id: string, field: keyof Speaker, value: string) => {
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
      const sampleText = `Hi, I'm ${speaker.name}. This is my OpenAI voice.`;
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
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2"><User size={20} className="text-blue-400" />Cast</h2>
        <button onClick={addSpeaker} className="flex items-center gap-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-full transition-colors">
          <Plus size={14} /> Add Speaker
        </button>
      </div>
      <div className="space-y-3">
        {speakers.map((speaker) => (
          <div key={speaker.id} className="flex flex-col gap-3 bg-slate-900/50 p-4 rounded-lg border border-slate-700/50">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
              <div className="flex-1 w-full"><label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Name</label>
                <input type="text" value={speaker.name} onChange={(e) => updateSpeaker(speaker.id, 'name', e.target.value)} className="w-full bg-slate-800 text-slate-200 text-sm px-3 py-2 rounded border border-slate-700" />
              </div>
              <div className="flex-1 w-full"><label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Voice</label>
                <div className="flex gap-2"><select value={speaker.voice} onChange={(e) => updateSpeaker(speaker.id, 'voice', e.target.value as VoiceName)} className="w-full bg-slate-800 text-slate-200 text-sm px-3 py-2 rounded border border-slate-700">
                  {Object.values(VoiceName).map((v) => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
                </select>
                <button onClick={() => handlePreview(speaker)} className={`shrink-0 w-[38px] flex items-center justify-center rounded border ${previewState?.id === speaker.id ? 'bg-blue-500/20 border-blue-500 text-blue-400' : 'bg-slate-800 border-slate-700'}`}>
                  {previewState?.id === speaker.id ? (previewState.status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} fill="currentColor" />) : <Play size={16} fill="currentColor" />}
                </button></div>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2 border-t border-slate-800/50">
               <div className="flex-1"><label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 flex items-center gap-1"><Gauge size={10} /> Speed</label>
                  <select value={speaker.speed || 'Normal'} onChange={(e) => updateSpeaker(speaker.id, 'speed', e.target.value)} className="w-full bg-slate-800 text-slate-300 text-xs px-2 py-1.5 rounded border border-slate-700">
                    {SPEEDS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
               </div>
               <button onClick={() => removeSpeaker(speaker.id)} className="p-1.5 mt-4 text-slate-500 hover:text-red-400 rounded"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};