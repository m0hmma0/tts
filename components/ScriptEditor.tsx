
import React, { useRef, useState, useEffect } from 'react';
import { FileText, Play, Loader2, Square, Download, Trash2, Tag } from 'lucide-react';
import { Speaker, VoiceName } from '../types';
// Updated to use geminiService
import { generateLineAudio } from '../services/geminiService';
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
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [playingKey, setPlayingKey] = useState<string | null>(null);

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
    const messageRaw = key.slice(colonIdx + 1).trim();
    if (!messageRaw) return null;

    const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
    const voice = speaker ? speaker.voice : VoiceName.Kore;

    try {
      const base64Audio = await generateLineAudio(voice, messageRaw, speaker);
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

  const handleDownloadLine = (key: string) => {
    const buffer = audioCache[key];
    if (buffer) {
      downloadAudioBufferAsWav(buffer, `line_${key.slice(0, 15).replace(/\s/g, '_')}.wav`);
    }
  };

  const handleDeleteLine = (key: string) => {
    const newCache = { ...audioCache };
    delete newCache[key];
    setAudioCache(newCache);
    if (playingKey === key) stopPlayback();
  };

  // Helper to render script with highlighted emotion tags
  const renderLineWithHighlights = (line: string) => {
    if (!line.trim()) return <span>&nbsp;</span>;
    
    // Split by tags (emotion tags in parentheses or scene tags in brackets)
    // We want to highlight (emotion) and [scene]
    const parts = line.split(/(\(.*?\)|\[.*?\])/g);
    
    return parts.map((part, i) => {
      if (part.startsWith('(') && part.endsWith(')')) {
        return <span key={i} className="text-yellow-400 font-bold bg-yellow-400/10 px-0.5 rounded border border-yellow-400/20">{part}</span>;
      }
      if (part.startsWith('[') && part.endsWith(']')) {
        return <span key={i} className="text-indigo-400 font-bold bg-indigo-400/10 px-0.5 rounded border border-indigo-400/20 italic">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  const lines = script.split('\n');

  return (
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
          <FileText size={20} className="text-blue-400" />
          Script Editor
        </h2>
        <div className="flex gap-2">
           <button onClick={handlePreviewLine} disabled={previewStatus === 'loading'} className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border bg-slate-800 border-slate-700 hover:text-white transition-all active:scale-95 disabled:opacity-50">
            {previewStatus === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
            Preview Line
          </button>
        </div>
      </div>

      <div className="flex-grow relative overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-inner group">
        <style>{`.script-typography { font-family: ui-monospace, monospace; font-size: 0.9375rem; line-height: 1.8; }`}</style>
        
        {/* Backdrop for syntax highlighting */}
        <div ref={backdropRef} className="absolute inset-0 p-6 pl-20 script-typography whitespace-pre-wrap break-words pointer-events-none text-slate-300 selection:bg-transparent">
          {lines.map((l, i) => (
            <div key={i} className="min-h-[1.8em]">{renderLineWithHighlights(l)}</div>
          ))}
        </div>

        {/* The actual editable area */}
        <textarea 
          ref={textareaRef} 
          value={script} 
          onChange={(e) => setScript(e.target.value)} 
          spellCheck={false} 
          className="absolute inset-0 w-full h-full bg-transparent text-transparent p-6 pl-20 script-typography whitespace-pre-wrap break-words resize-none focus:outline-none caret-blue-400 z-10 selection:bg-blue-500/20" 
        />

        {/* Gutter / Interaction Layer */}
        <div className="absolute inset-0 p-6 pl-20 script-typography whitespace-pre-wrap break-words overflow-hidden pointer-events-none z-20">
          {lines.map((line, i) => {
             const key = line.trim();
             const isDialogue = key.includes(':'); 
             if (!isDialogue) return <div key={i} className="min-h-[1.8em]">&nbsp;</div>;
             
             const hasAudio = !!audioCache[key];
             const isPlayingThis = playingKey === key;

             return (
               <div key={i} className="relative w-full min-h-[1.8em]">
                  <span className="opacity-0 select-none">{line || ' '}</span>
                  <div className="absolute -left-16 top-0 flex items-center h-full gap-1.5 pointer-events-auto">
                    {!hasAudio ? (
                      <div className="w-12 h-6" />
                    ) : (
                      <div className="flex items-center gap-1 bg-slate-800/80 rounded-lg p-0.5 border border-slate-700/50 backdrop-blur-sm">
                        <button 
                          onClick={() => playBuffer(audioCache[key], key)} 
                          className={`p-1 rounded-md transition-colors ${isPlayingThis ? 'bg-blue-500 text-white' : 'text-blue-400 hover:bg-slate-700'}`}
                          title="Play line"
                        >
                          {isPlayingThis ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                        </button>
                        <button 
                          onClick={() => handleDownloadLine(key)} 
                          className="p-1 rounded-md text-emerald-400 hover:bg-slate-700 transition-colors"
                          title="Download line"
                        >
                          <Download size={10} />
                        </button>
                        <button 
                          onClick={() => handleDeleteLine(key)} 
                          className="p-1 rounded-md text-red-400 hover:bg-slate-700 transition-colors"
                          title="Delete audio cache for line"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    )}
                  </div>
               </div>
             );
          })}
        </div>
      </div>
      
      <div className="mt-3 flex items-center gap-4 text-[10px] text-slate-500 font-medium">
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-yellow-400"></div> Emotion Tag (parentheses)</div>
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-indigo-400"></div> Scene Tag [brackets]</div>
        <div className="ml-auto flex items-center gap-1"><Tag size={10} /> Speaker detected by ":" presence</div>
      </div>
    </div>
  );
};
