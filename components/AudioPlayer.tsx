
import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Download, Volume2, FileJson } from 'lucide-react';
import { downloadAudioBufferAsWav } from '../utils/audioUtils';
import { WordTiming } from '../types';

interface AudioPlayerProps {
  audioBuffer: AudioBuffer | null;
  timings?: WordTiming[] | null;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioBuffer, timings }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const pauseTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);
  
  const [playbackOffset, setPlaybackOffset] = useState(0);

  useEffect(() => {
    // Reset state when buffer changes
    stop();
    setPlaybackOffset(0);
    setProgress(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBuffer]);

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000 // Match the Gemini output rate
      });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const play = () => {
    if (!audioBuffer) return;

    const ctx = initAudioContext();
    
    // Create a new source node
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    sourceRef.current = source;
    
    // Calculate start time
    const currentCtxTime = ctx.currentTime;
    startTimeRef.current = currentCtxTime - playbackOffset;
    
    // Start playback
    source.start(0, playbackOffset);
    setIsPlaying(true);

    source.onended = () => {
      // This triggers when playback finishes naturally
      const duration = audioBuffer.duration;
      const elapsed = ctx.currentTime - startTimeRef.current;
      if (elapsed >= duration) {
        setIsPlaying(false);
        setPlaybackOffset(0);
        setProgress(0);
        cancelAnimationFrame(animationFrameRef.current);
      }
    };

    // Start animation loop
    const animate = () => {
      const elapsed = ctx.currentTime - startTimeRef.current;
      const duration = audioBuffer.duration;
      const newProgress = Math.min((elapsed / duration) * 100, 100);
      setProgress(newProgress);
      
      if (elapsed < duration && isPlaying) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };
    animationFrameRef.current = requestAnimationFrame(animate);
  };

  const pause = () => {
    if (sourceRef.current && audioContextRef.current) {
      sourceRef.current.stop();
      sourceRef.current.disconnect();
      sourceRef.current = null;
      
      // Calculate where we stopped
      const elapsed = audioContextRef.current.currentTime - startTimeRef.current;
      setPlaybackOffset(elapsed);
      setIsPlaying(false);
      cancelAnimationFrame(animationFrameRef.current);
    }
  };

  const stop = () => {
    if (sourceRef.current) {
        try {
            sourceRef.current.stop();
        } catch (e) {
            // ignore if already stopped
        }
        sourceRef.current.disconnect();
        sourceRef.current = null;
    }
    setIsPlaying(false);
    setPlaybackOffset(0);
    setProgress(0);
    cancelAnimationFrame(animationFrameRef.current);
  };

  const handleTogglePlay = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const handleDownload = () => {
    if (audioBuffer) {
      downloadAudioBufferAsWav(audioBuffer, "gemini_studio_full_generation.wav");
    }
  };

  const handleDownloadJSON = () => {
    if (!timings) return;
    const blob = new Blob([JSON.stringify(timings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = "gemini_studio_full_timings.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!audioBuffer) return null;

  return (
    <div className="w-full bg-indigo-900/30 border border-indigo-500/30 rounded-xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/20 rounded-full">
            <Volume2 className="text-indigo-400" size={20} />
          </div>
          <div>
            <div className="text-sm font-medium text-white">Generated Audio</div>
            <div className="text-xs text-indigo-300">{audioBuffer.duration.toFixed(1)}s • 24kHz Mono</div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
            {timings && (
              <button 
                onClick={handleDownloadJSON}
                className="text-xs flex items-center gap-1 text-amber-300 hover:text-white hover:bg-amber-500/30 px-2 py-1 rounded transition-colors"
                title="Download JSON Timings"
              >
                <FileJson size={14} />
                JSON
              </button>
            )}
            <button 
              onClick={handleDownload}
              className="text-xs flex items-center gap-1 text-indigo-300 hover:text-white hover:bg-indigo-500/30 px-2 py-1 rounded transition-colors"
              title="Download WAV Audio"
            >
              <Download size={14} />
              WAV
            </button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden relative cursor-pointer" onClick={(e) => {
          // Placeholder for seek functionality
      }}>
        <div 
          className="h-full bg-indigo-500 transition-all duration-100 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex justify-center gap-4">
        <button 
          onClick={stop}
          className="p-3 text-slate-400 hover:text-white hover:bg-slate-700 rounded-full transition-all"
          title="Stop & Reset"
        >
          <RotateCcw size={20} />
        </button>
        
        <button 
          onClick={handleTogglePlay}
          className="p-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full shadow-lg shadow-indigo-900/50 transition-all hover:scale-105 active:scale-95"
        >
          {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" className="ml-1" />}
        </button>
      </div>
    </div>
  );
};
