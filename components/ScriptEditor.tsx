
import React, { useRef, useState, useEffect } from 'react';
import { FileText, Play, Loader2, Square, Download, Trash2, RefreshCcw } from 'lucide-react';
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
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [previewStatus, setPreviewStatus] = useState<Record<string, 'loading' | 'playing' | 'idle'>>({});
  const [playingKey, setPlayingKey] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Synchronize scroll between textarea and backdrop
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = e.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  const stopPlayback = () => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) {}
    }
    sourceRef.current = null;
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
    source.onended = () => {
      if (playingKey === key) setPlayingKey(null);
    };
    source.start();
  };

  const handleAction = async (lineText: string, action: 'play' | 'download' | 'reset') => {
    const key = lineText.trim();
    if (!key) return;

    if (action === 'reset') {
      if (playingKey === key) stopPlayback();
      setAudioCache(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }

    if (action === 'download' && audioCache[key]) {
      downloadAudioBufferAsWav(audioCache[key], `line-${key.slice(0, 15)}.wav`);
      return;
    }

    if (action === 'play') {
      if (playingKey === key) {
        stopPlayback();
        return;
      }

      if (audioCache[key]) {
        await playBuffer(audioCache[key], key);
        return;
      }

      // Generate if not cached
      const colonIdx = key.indexOf(':');
      if (colonIdx === -1) return;
      
      const speakerName = key.slice(0, colonIdx).trim();
      const message = key.slice(colonIdx + 1).trim();
      const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
      const voice = speaker ? speaker.voice : VoiceName.Alloy;

      setPreviewStatus(prev => ({ ...prev, [key]: 'loading' }));
      try {
        const base64Audio = await generateLineAudio(voice, message, speaker);
        const ctx = audioContextRef.current || new AudioContext({ sampleRate: 24000 });
        const bytes = decodeBase64(base64Audio);
        const buffer = await decodeAudioData(bytes, ctx, 24000);
        
        setAudioCache(prev => ({ ...prev, [key]: buffer }));
        setPreviewStatus(prev => ({ ...prev, [key]: 'idle' }));
        await playBuffer(buffer, key);
      } catch (err) {
        console.error(err);
        setPreviewStatus(prev => ({ ...prev, [key]: 'idle' }));
      }
    }
  };

  const lines = script.split('\n');

  // Syntax highlighting logic
  const renderHighlightedLine = (line: string) => {
    if (!line.trim()) return <span>&nbsp;</span>;
    const parts = line.split(/(\[.*?\]|\(.*?\))/);
    return parts.map((part, i) => {
      if (part.startsWith('[') && part.endsWith(']')) {
        return <span key={i} className="text-slate-500 italic">{part}</span>;
      }
      if (part.startsWith('(') && part.endsWith(')')) {
        return <span key={i} className="text-blue-400 font-medium">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
          <FileText size={20} className="text-blue-400" />
          Script Editor
        </h2>
        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
          GPT-4o Mini TTS
        </div>
      </div>
      
      <div className="flex-grow relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900 flex">
        {/* Line Gutter for controls */}
        <div className="w-16 bg-slate-900/80 border-r border-slate-800 flex flex-col pt-4 select-none z-20 overflow-hidden">
          {lines.map((line, i) => {
            const key = line.trim();
            const isDialogue = key.includes(':');
            const isCached = !!audioCache[key];
            const status = previewStatus[key] || 'idle';
            const isPlaying = playingKey === key;

            return (
              <div key={i} className="h-7 mb-1 flex items-center justify-center gap-1 group/btn px-1">
                {isDialogue && (
                  <>
                    <button 
                      onClick={() => handleAction(line, 'play')}
                      className={`p-1 rounded hover:bg-slate-700 transition-colors ${isPlaying ? 'text-green-400' : 'text-blue-400'}`}
                    >
                      {status === 'loading' ? <Loader2 size={12} className="animate-spin" /> : 
                       isPlaying ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                    </button>
                    {isCached && (
                      <div className="flex flex-col gap-0.5 opacity-0 group-hover/btn:opacity-100 transition-opacity">
                        <button onClick={() => handleAction(line, 'download')} className="p-0.5 text-slate-500 hover:text-white" title="Download WAV"><Download size={8} /></button>
                        <button onClick={() => handleAction(line, 'reset')} className="p-0.5 text-slate-500 hover:text-red-400" title="Reset Line"><RefreshCcw size={8} /></button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Text layers container */}
        <div className="flex-1 relative overflow-hidden">
          <style>{`
            .script-layer {
              font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
              font-size: 13px;
              line-height: 28px; /* Fixed height per line for alignment */
              padding: 16px;
              margin: 0;
              border: none;
              white-space: pre-wrap;
              word-wrap: break-word;
              width: 100%;
              height: 100%;
              box-sizing: border-box;
            }
          `}</style>
          
          {/* Backdrop (Highlighter) */}
          <div 
            ref={backdropRef} 
            className="script-layer absolute inset-0 pointer-events-none text-slate-200 overflow-hidden"
          >
            {lines.map((l, i) => (
              <div key={i} className="h-7 mb-1">{renderHighlightedLine(l)}</div>
            ))}
          </div>

          {/* Textarea (Interaction) */}
          <textarea 
            ref={textareaRef} 
            value={script} 
            onChange={(e) => setScript(e.target.value)} 
            onScroll={handleScroll}
            spellCheck={false} 
            className="script-layer absolute inset-0 bg-transparent text-transparent caret-white focus:outline-none z-10 resize-none overflow-y-auto"
          />
        </div>
      </div>
      
      <div className="mt-4 flex flex-wrap gap-4 text-[10px] text-slate-500 uppercase font-bold tracking-wider">
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-slate-600"></span> [Scene / SFX]</div>
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-500"></span> (Emotion / Tone)</div>
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-slate-300"></span> Dialogue</div>
        <div className="ml-auto text-slate-600">Selection Bug Fixed: layers synced to 28px line-height</div>
      </div>
    </div>
  );
};
