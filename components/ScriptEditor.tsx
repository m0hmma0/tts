import React, { useRef, useState, useEffect } from 'react';
import { FileText, Play, Loader2, Square, RefreshCcw, Download } from 'lucide-react';
import { Speaker, VoiceName } from '../types';
import { generateLineAudio } from '../services/openaiService';
import { decodeBase64, decodeAudioData, downloadAudioBufferAsWav } from '../utils/audioUtils';

interface ScriptEditorProps {
  script: string;
  setScript: (script: string) => void;
  speakers: Speaker[];
  audioCache: Record<string, AudioBuffer>;
  setAudioCache: React.Dispatch<React.SetStateAction<Record<string, AudioBuffer>>>;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({ 
  script, setScript, speakers, audioCache, setAudioCache
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  const stopPlayback = () => {
    if (sourceRef.current) try { sourceRef.current.stop(); } catch (e) {}
    sourceRef.current = null;
    setPreviewStatus('idle');
    setPlayingKey(null);
  };

  const playBuffer = async (buffer: AudioBuffer, key: string) => {
    stopPlayback();
    if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    sourceRef.current = source;
    setPlayingKey(key);
    setPreviewStatus('playing');
    source.onended = () => { setPlayingKey(null); setPreviewStatus('idle'); };
    source.start();
  };

  const generatePreview = async (lineText: string) => {
    const key = lineText.trim();
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) return null;
    const speakerName = key.slice(0, colonIdx).trim();
    const message = key.slice(colonIdx + 1).replace(/\[.*?\]/g, '').trim();
    if (!message) return null;

    const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
    const voice = speaker ? speaker.voice : VoiceName.Alloy;

    try {
      const base64Audio = await generateLineAudio(voice, message, speaker);
      const ctx = audioContextRef.current || new AudioContext({ sampleRate: 24000 });
      const bytes = decodeBase64(base64Audio);
      const buffer = await decodeAudioData(bytes, ctx, 24000);
      setAudioCache(prev => ({ ...prev, [key]: buffer }));
      return buffer;
    } catch (err) { return null; }
  };

  const handlePreviewLine = async () => {
    if (!textareaRef.current) return;
    if (previewStatus !== 'idle' && !playingKey) { stopPlayback(); return; }

    const val = textareaRef.current.value;
    const cursor = textareaRef.current.selectionStart;
    let start = val.lastIndexOf('\n', cursor - 1);
    start = start === -1 ? 0 : start + 1;
    let end = val.indexOf('\n', cursor);
    end = end === -1 ? val.length : end;
    const line = val.slice(start, end);
    const key = line.trim();
    if (!key) return;

    setPreviewStatus('loading');
    if (audioCache[key]) { playBuffer(audioCache[key], key); return; }
    const buffer = await generatePreview(line);
    if (buffer) playBuffer(buffer, key);
    else setPreviewStatus('idle');
  };

  const lines = script.split('\n');

  return (
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2"><FileText size={20} className="text-blue-400" />Script</h2>
        <button onClick={handlePreviewLine} disabled={previewStatus === 'loading'} className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border bg-slate-800 border-slate-700 hover:text-white">
          {previewStatus === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
          Preview Current Line
        </button>
      </div>
      <div className="flex-grow relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900 group">
        <style>{`.script-typography { font-family: ui-monospace, monospace; font-size: 0.875rem; line-height: 1.75; }`}</style>
        <div ref={backdropRef} className="absolute inset-0 p-4 pl-16 script-typography whitespace-pre-wrap break-words pointer-events-none text-slate-200">
          {script.split('\n').map((l, i) => <div key={i}>{l || ' '}</div>)}
        </div>
        <textarea ref={textareaRef} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} className="absolute inset-0 w-full h-full bg-transparent text-transparent p-4 pl-16 script-typography whitespace-pre-wrap break-words resize-none focus:outline-none caret-white z-10" />
        <div ref={interactionRef} className="absolute inset-0 p-4 pl-16 script-typography whitespace-pre-wrap break-words overflow-hidden pointer-events-none z-20">
          {lines.map((line, i) => {
             const key = line.trim();
             const isDialogue = key.includes(':'); 
             if (!isDialogue) return <div key={i}>&nbsp;</div>;
             return (
               <div key={i} className="relative w-full">
                  <span className="opacity-0 select-none">{line || ' '}</span>
                  <div className="absolute -left-12 top-0 flex items-center h-6 gap-1">
                    {audioCache[key] && (
                      <button onClick={() => playBuffer(audioCache[key], key)} className="p-1 rounded-full pointer-events-auto text-blue-400 hover:bg-slate-800"><Play size={10} fill="currentColor" /></button>
                    )}
                  </div>
               </div>
             );
          })}
        </div>
      </div>
    </div>
  );
};