import React, { useState, useRef, useEffect } from 'react';
import { Speaker, VoiceName } from '../types';
import { Plus, Trash2, User, Play, Loader2, Square, Globe, Gauge } from 'lucide-react';
import { previewSpeakerVoice, formatPromptWithSettings } from '../services/geminiService';
import { decodeBase64, decodeAudioData } from '../utils/audioUtils';

interface SpeakerManagerProps {
  speakers: Speaker[];
  setSpeakers: React.Dispatch<React.SetStateAction<Speaker[]>>;
}

const ACCENTS = ['Neutral', 'British', 'American', 'Australian', 'Indian', 'Southern US', 'French', 'German'];
const SPEEDS = ['Very Slow', 'Slow', 'Normal', 'Fast', 'Very Fast'];

export const SpeakerManager: React.FC<SpeakerManagerProps> = ({ speakers, setSpeakers }) => {
  const [previewState, setPreviewState] = useState<{ id: string; status: 'loading' | 'playing' } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch (e) {}
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const addSpeaker = () => {
    const newSpeaker: Speaker = {
      id: crypto.randomUUID(),
      name: `Speaker ${speakers.length + 1}`,
      voice: VoiceName.Kore,
      accent: 'Neutral',
      speed: 'Normal'
    };
    setSpeakers([...speakers, newSpeaker]);
  };

  const removeSpeaker = (id: string) => {
    // If removing the currently previewing speaker, stop audio
    if (previewState?.id === id) {
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch (e) {}
      }
      setPreviewState(null);
    }
    setSpeakers(speakers.filter((s) => s.id !== id));
  };

  const updateSpeaker = (id: string, field: keyof Speaker, value: string) => {
    setSpeakers(
      speakers.map((s) => (s.id === id ? { ...s, [field]: value } : s))
    );
  };

  const handlePreview = async (speaker: Speaker) => {
    // If currently playing this one, stop it
    if (previewState?.id === speaker.id) {
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch (e) {}
      }
      setPreviewState(null);
      return;
    }

    // Stop any other playing audio
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) {}
    }

    setPreviewState({ id: speaker.id, status: 'loading' });

    try {
      // 1. Fetch audio with applied settings
      // We create a sample text that demonstrates the settings
      const sampleText = `Hello! I am ${speaker.name}, speaking with a ${speaker.accent || 'neutral'} accent.`;
      const prompt = formatPromptWithSettings(sampleText, speaker);
      
      const base64Audio = await previewSpeakerVoice(speaker.voice, prompt);
      
      // 2. Prepare Context
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: 24000
        });
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      // 3. Decode
      const audioBytes = decodeBase64(base64Audio);
      const buffer = await decodeAudioData(audioBytes, audioContextRef.current, 24000);

      // 4. Play
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      sourceRef.current = source;

      source.onended = () => {
        setPreviewState(null);
      };

      source.start();
      setPreviewState({ id: speaker.id, status: 'playing' });

    } catch (error) {
      console.error("Preview failed", error);
      setPreviewState(null);
    }
  };

  return (
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
          <User size={20} className="text-indigo-400" />
          Cast & Voices
        </h2>
        <button
          onClick={addSpeaker}
          className="flex items-center gap-1 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-full transition-colors"
        >
          <Plus size={14} />
          Add Speaker
        </button>
      </div>

      <div className="space-y-3">
        {speakers.length === 0 && (
          <div className="text-slate-500 text-sm italic text-center py-4">
            No speakers defined. Add a speaker to assign voices.
          </div>
        )}
        
        {speakers.map((speaker) => (
          <div
            key={speaker.id}
            className="flex flex-col gap-3 bg-slate-900/50 p-4 rounded-lg border border-slate-700/50 group"
          >
            {/* Row 1: Name and Voice */}
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
              <div className="flex-1 w-full sm:w-auto">
                <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Name in Script</label>
                <input
                  type="text"
                  value={speaker.name}
                  onChange={(e) => updateSpeaker(speaker.id, 'name', e.target.value)}
                  className="w-full bg-slate-800 text-slate-200 text-sm px-3 py-2 rounded border border-slate-700 focus:border-indigo-500 focus:outline-none transition-colors placeholder-slate-600"
                  placeholder="e.g. Joe"
                />
              </div>
              
              <div className="flex-1 w-full sm:w-auto">
                <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Voice Persona</label>
                <div className="flex gap-2">
                  <div className="relative flex-grow">
                    <select
                      value={speaker.voice}
                      onChange={(e) => updateSpeaker(speaker.id, 'voice', e.target.value as VoiceName)}
                      className="w-full appearance-none bg-slate-800 text-slate-200 text-sm px-3 py-2 rounded border border-slate-700 focus:border-indigo-500 focus:outline-none transition-colors cursor-pointer"
                    >
                      {Object.values(VoiceName).map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                      <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                    </div>
                  </div>
                  
                  <button
                    onClick={() => handlePreview(speaker)}
                    className={`shrink-0 w-[38px] flex items-center justify-center rounded border transition-all ${
                      previewState?.id === speaker.id
                        ? 'bg-indigo-500/20 border-indigo-500 text-indigo-400'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-indigo-400 hover:border-indigo-500/50'
                    }`}
                    title="Preview Voice"
                    disabled={previewState !== null && previewState.id !== speaker.id && previewState.status === 'loading'}
                  >
                    {previewState?.id === speaker.id ? (
                      previewState.status === 'loading' ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Square size={16} fill="currentColor" />
                      )
                    ) : (
                      <Play size={16} fill="currentColor" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Row 2: Accent and Speed */}
            <div className="flex flex-col sm:flex-row gap-3 items-end pt-2 border-t border-slate-800/50">
               <div className="flex-1 w-full">
                <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 flex items-center gap-1">
                  <Globe size={10} /> Accent
                </label>
                <div className="relative">
                  <select
                    value={speaker.accent || 'Neutral'}
                    onChange={(e) => updateSpeaker(speaker.id, 'accent', e.target.value)}
                    className="w-full appearance-none bg-slate-800 text-slate-300 text-xs px-2 py-1.5 rounded border border-slate-700 focus:border-indigo-500 focus:outline-none transition-colors cursor-pointer"
                  >
                    {ACCENTS.map((acc) => (
                      <option key={acc} value={acc}>{acc}</option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                     <svg className="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
               </div>

               <div className="flex-1 w-full">
                <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1 flex items-center gap-1">
                  <Gauge size={10} /> Speed
                </label>
                <div className="relative">
                  <select
                    value={speaker.speed || 'Normal'}
                    onChange={(e) => updateSpeaker(speaker.id, 'speed', e.target.value)}
                    className="w-full appearance-none bg-slate-800 text-slate-300 text-xs px-2 py-1.5 rounded border border-slate-700 focus:border-indigo-500 focus:outline-none transition-colors cursor-pointer"
                  >
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                     <svg className="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                  </div>
                </div>
               </div>

               <button
                onClick={() => removeSpeaker(speaker.id)}
                className="w-full sm:w-auto p-1.5 mt-2 sm:mt-0 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-all flex justify-center items-center"
                aria-label="Remove speaker"
                title="Remove Speaker"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};