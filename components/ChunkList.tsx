
import React, { useRef, useState } from 'react';
import { DubbingChunk, AudioCacheItem, WordTiming } from '../types';
import { Play, RotateCcw, Check, Loader2, AlertCircle, Volume2, Square } from 'lucide-react';

interface ChunkListProps {
  chunks: DubbingChunk[];
  chunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[] }>;
  isGenerating: boolean;
  onRegenerate: (chunk: DubbingChunk) => void;
  onPlay: (buffer: AudioBuffer) => void;
}

export const ChunkList: React.FC<ChunkListProps> = ({ 
  chunks, 
  chunkCache, 
  isGenerating, 
  onRegenerate,
  onPlay 
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);
  // We use a simple local ref to track if we are locally playing for UI state, 
  // though the actual playback is delegated to parent or handled simply here.
  // Ideally, we just pass buffer to parent. 
  
  const handlePlay = (chunkId: string, buffer: AudioBuffer) => {
    setPlayingId(chunkId);
    onPlay(buffer);
    // Reset icon after duration (approximate UI feedback)
    setTimeout(() => {
        setPlayingId(prev => prev === chunkId ? null : prev);
    }, buffer.duration * 1000);
  };

  if (chunks.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Layers size={16} className="text-indigo-600" />
                Generated Segments
            </h3>
            <span className="text-xs text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">
                {Object.keys(chunkCache).length} / {chunks.length} Cached
            </span>
        </div>
        <div className="max-h-[300px] overflow-y-auto divide-y divide-slate-100">
            {chunks.map((chunk, index) => {
                const cached = chunkCache[chunk.id];
                const duration = chunk.endTime - chunk.startTime;
                
                return (
                    <div key={chunk.id} className="p-3 hover:bg-slate-50 transition-colors flex items-center gap-3 group">
                        <div className="w-8 text-center text-xs font-mono text-slate-400">
                            #{index + 1}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-bold text-slate-700 truncate max-w-[100px]" title={chunk.speakerName}>
                                    {chunk.speakerName}
                                </span>
                                <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 rounded">
                                    {chunk.startTime.toFixed(2)}s - {chunk.endTime.toFixed(2)}s
                                </span>
                            </div>
                            <p className="text-xs text-slate-600 truncate opacity-80" title={chunk.lines.map(l => l.spokenText).join(' ')}>
                                {chunk.lines.map(l => l.spokenText).join(' ')}
                            </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            {cached ? (
                                <>
                                    <button 
                                        onClick={() => handlePlay(chunk.id, cached.buffer)}
                                        className={`p-1.5 rounded-full transition-all ${playingId === chunk.id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'}`}
                                        title="Play Segment"
                                    >
                                        {playingId === chunk.id ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                                    </button>
                                    <button 
                                        onClick={() => onRegenerate(chunk)}
                                        disabled={isGenerating}
                                        className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-full transition-colors disabled:opacity-30"
                                        title="Regenerate this segment"
                                    >
                                        <RotateCcw size={14} />
                                    </button>
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1" title="Cached"></div>
                                </>
                            ) : (
                                <div className="flex items-center gap-1 text-slate-400 text-xs italic">
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                                    Pending
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    </div>
  );
};

import { Layers } from 'lucide-react';
