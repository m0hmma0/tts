import React, { useRef, useState, useEffect } from 'react';
import { FileText, Play, Loader2, Square, RefreshCcw, Download } from 'lucide-react';
import { Speaker, VoiceName } from '../types';
import { previewSpeakerVoice, formatPromptWithSettings } from '../services/geminiService';
import { decodeBase64, decodeAudioData, downloadAudioBufferAsWav } from '../utils/audioUtils';

interface ScriptEditorProps {
  script: string;
  setScript: (script: string) => void;
  speakers: Speaker[];
  audioCache: Record<string, AudioBuffer>;
  setAudioCache: React.Dispatch<React.SetStateAction<Record<string, AudioBuffer>>>;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({ 
  script, 
  setScript, 
  speakers,
  audioCache,
  setAudioCache
}) => {
  const backdropRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  
  // Playback state
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  // Track which specific line key is currently playing (for the inline buttons)
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  // Track which specific line key is regenerating
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    return () => {
      stopPlayback();
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const stopPlayback = () => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) {}
      sourceRef.current = null;
    }
    setPreviewStatus('idle');
    setPlayingKey(null);
  };

  const getAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000
      });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const playBuffer = async (buffer: AudioBuffer, key: string) => {
    stopPlayback();
    
    const ctx = await getAudioContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    sourceRef.current = source;

    setPlayingKey(key);
    setPreviewStatus('playing');

    source.onended = () => {
      setPlayingKey(null);
      setPreviewStatus('idle');
    };

    source.start();
  };

  const handleScroll = () => {
    if (textareaRef.current) {
      const { scrollTop, scrollLeft } = textareaRef.current;
      if (backdropRef.current) {
        backdropRef.current.scrollTop = scrollTop;
        backdropRef.current.scrollLeft = scrollLeft;
      }
      if (interactionRef.current) {
        interactionRef.current.scrollTop = scrollTop;
        interactionRef.current.scrollLeft = scrollLeft;
      }
    }
  };

  // Highlight logic for (...) and [...]
  const renderHighlightedText = (text: string) => {
    // Regex to match (...) or [...]
    const regex = /(\([^)]+\)|\[[^\]]+\])/g;
    const parts = text.split(regex);
    return parts.map((part, index) => {
      if (part.startsWith('(') && part.endsWith(')')) {
        // Stage Directions (Acting)
        return <span key={index} className="text-amber-400 italic font-medium">{part}</span>;
      }
      if (part.startsWith('[') && part.endsWith(']')) {
        // Comments (Ignored)
        return <span key={index} className="text-slate-500 italic">{part}</span>;
      }
      return <span key={index}>{part}</span>;
    });
  };

  const generatePreview = async (lineText: string) => {
    const key = lineText.trim();
    
    // Parse "Speaker: Text"
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) return null;

    const speakerName = key.slice(0, colonIdx).trim();
    const rawMessage = key.slice(colonIdx + 1).trim();
    
    // Strip comments [ ... ] for generation
    const message = rawMessage.replace(/\[.*?\]/g, '').trim();

    if (!message) return null;

    const speaker = speakers.find(s => s.name.toLowerCase() === speakerName.toLowerCase());
    const voice = speaker ? speaker.voice : VoiceName.Kore;

    // Apply Speaker Settings (Accent, Speed)
    const prompt = formatPromptWithSettings(message, speaker);

    try {
      const base64Audio = await previewSpeakerVoice(voice, prompt);
      const ctx = await getAudioContext();
      const audioBytes = decodeBase64(base64Audio);
      const buffer = await decodeAudioData(audioBytes, ctx, 24000);
      
      // Update cache
      setAudioCache(prev => ({ ...prev, [key]: buffer }));
      return buffer;
    } catch (err) {
      console.error("Generation failed", err);
      return null;
    }
  };

  const handlePreviewLine = async () => {
    if (!textareaRef.current) return;
    
    if (previewStatus !== 'idle' && !playingKey) {
      stopPlayback();
      return;
    }

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

    // Check cache first
    if (audioCache[key]) {
      playBuffer(audioCache[key], key);
      return;
    }

    // Generate if not cached
    const buffer = await generatePreview(line);
    if (buffer) {
      playBuffer(buffer, key);
    } else {
      setPreviewStatus('idle');
      // No alert here, silent fail or maybe toast in future
    }
  };

  const handleInlinePlay = (key: string) => {
    if (playingKey === key) {
      stopPlayback();
    } else {
      if (audioCache[key]) {
        playBuffer(audioCache[key], key);
      }
    }
  };

  const handleRegenerateLine = async (key: string) => {
     // Remove from cache
     const newCache = { ...audioCache };
     delete newCache[key];
     setAudioCache(newCache);
     
     setRegeneratingKey(key);
     await generatePreview(key); // This will re-add to cache
     setRegeneratingKey(null);
  };

  const handleDownloadLine = (key: string, index: number) => {
    if (audioCache[key]) {
        // Parse speaker for filename
        const colonIdx = key.indexOf(':');
        let speaker = "Speaker";
        if (colonIdx > -1) {
            speaker = key.substring(0, colonIdx).trim();
        }
        const safeSpeaker = speaker.replace(/[^a-z0-9]/gi, '_');
        const filename = `line_${index + 1}_${safeSpeaker}.wav`;
        downloadAudioBufferAsWav(audioCache[key], filename);
    }
  };

  const lines = script.split('\n');

  return (
    <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
          <FileText size={20} className="text-indigo-400" />
          Conversation Script
        </h2>
        
        <button 
          onClick={handlePreviewLine}
          disabled={previewStatus === 'loading'}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
            previewStatus !== 'idle' && !playingKey // Shows active state for the main button only if NOT playing from an inline button
              ? 'bg-indigo-500/20 border-indigo-500 text-indigo-400' 
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-indigo-900/30 hover:border-indigo-500/50 hover:text-white'
          }`}
          title="Preview the line currently under the cursor"
        >
          {previewStatus === 'loading' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : previewStatus === 'playing' && !playingKey ? (
            <Square size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
          {previewStatus === 'playing' && !playingKey ? 'Stop Preview' : 'Preview Line'}
        </button>
      </div>
      
      <div className="flex-grow relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900 group focus-within:border-indigo-500 transition-colors">
        
        {/* Common typography class for alignment */}
        <style>{`
          .script-typography {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 0.875rem; /* text-sm */
            line-height: 1.75; /* relaxed leading for breathing room */
          }
        `}</style>

        {/* LAYER 1: Backdrop for Syntax Highlighting */}
        <div 
          ref={backdropRef}
          className="absolute inset-0 p-4 pl-20 script-typography whitespace-pre-wrap break-words pointer-events-none text-slate-200 overflow-hidden"
          aria-hidden="true"
        >
          {renderHighlightedText(script)}
          {script.endsWith('\n') && <br />}
        </div>

        {/* LAYER 2: Textarea for Input */}
        <textarea
          ref={textareaRef}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          onScroll={handleScroll}
          spellCheck={false}
          className="absolute inset-0 w-full h-full bg-transparent text-transparent p-4 pl-20 script-typography whitespace-pre-wrap break-words resize-none focus:outline-none caret-white placeholder:text-slate-600 selection:bg-indigo-500/30 selection:text-transparent z-10"
          placeholder={`Write your dialogue here...
          
Example:
[Scene: Office, early morning]
Joe: How's it going today Jane?
Jane: [Sips coffee] Not too bad, how about you?
[Note: Jane should sound tired]
`}
        />

        {/* LAYER 3: Interaction Layer for Inline Buttons */}
        <div 
          ref={interactionRef}
          className="absolute inset-0 p-4 pl-20 script-typography whitespace-pre-wrap break-words overflow-hidden pointer-events-none z-20"
        >
          {lines.map((line, i) => {
             const key = line.trim();
             const hasAudio = !!audioCache[key];
             // Simple heuristic to check if line is valid dialogue to show controls
             const isDialogue = key.includes(':'); 
             const showControls = isDialogue && key.length > 5;
             
             return (
               <div key={i} className="relative w-full">
                  {/* We render the line content transparently to force the container to match the height of wrapped text */}
                  <span className="opacity-0 select-none">{line || ' '}</span>
                  
                  {/* Buttons positioned in the gutter to the left */}
                  {showControls && (
                    <div className="absolute -left-[4.5rem] top-0 flex items-center h-6 gap-1">
                      {hasAudio ? (
                        <>
                          <button
                            onClick={() => handleInlinePlay(key)}
                            className={`p-1 rounded-full pointer-events-auto transition-all ${
                              playingKey === key 
                                ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/50' 
                                : 'text-indigo-400 hover:bg-indigo-900/50 hover:text-indigo-300'
                            }`}
                            title="Play cached preview"
                          >
                            {playingKey === key ? (
                              <Square size={10} fill="currentColor" />
                            ) : (
                              <Play size={10} fill="currentColor" />
                            )}
                          </button>
                          
                          <button
                            onClick={() => handleRegenerateLine(key)}
                            disabled={regeneratingKey === key}
                            className={`p-1 rounded-full pointer-events-auto transition-all text-slate-500 hover:text-indigo-400 hover:bg-slate-800`}
                            title="Regenerate this line with current speaker settings"
                          >
                             {regeneratingKey === key ? (
                               <Loader2 size={10} className="animate-spin" />
                             ) : (
                               <RefreshCcw size={10} />
                             )}
                          </button>

                          <button
                            onClick={() => handleDownloadLine(key, i)}
                            className={`p-1 rounded-full pointer-events-auto transition-all text-slate-500 hover:text-emerald-400 hover:bg-slate-800`}
                            title="Download this line as WAV"
                          >
                             <Download size={10} />
                          </button>
                        </>
                      ) : (
                         /* No buttons if no cache */
                         null
                      )}
                    </div>
                  )}
               </div>
             );
          })}
        </div>
        
        <div className="absolute bottom-2 right-4 text-[10px] text-slate-500 pointer-events-none select-none bg-slate-900/90 px-2 py-1 rounded backdrop-blur-sm border border-slate-800/50 z-30 flex gap-3">
          <span><span className="text-amber-400 italic">(...)</span> Stage Directions</span>
          <span><span className="text-slate-500 italic">[...]</span> Comments (Ignored)</span>
        </div>
      </div>
    </div>
  );
};