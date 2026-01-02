
import React, { useState, useEffect } from 'react';
import { DubbingChunk, AudioCacheItem, WordTiming } from '../types';
import { Play, RotateCcw, Check, Loader2, AlertCircle, Square, Save, Clock, Lock, Gauge } from 'lucide-react';
import { formatTimeForScript, parseScriptTimestamp } from '../utils/srtUtils';

interface ChunkListProps {
  chunks: DubbingChunk[];
  chunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[], ratio?: number }>;
  isGenerating: boolean;
  onRegenerate: (chunk: DubbingChunk) => void;
  onPlay: (buffer: AudioBuffer) => void;
  onUpdateTiming: (chunkId: string, newStart: string, newEnd: string) => void;
}

export const ChunkList: React.FC<ChunkListProps> = ({ 
  chunks, 
  chunkCache, 
  isGenerating, 
  onRegenerate,
  onPlay,
  onUpdateTiming
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");

  const handlePlay = (chunkId: string, buffer: AudioBuffer) => {
    setPlayingId(chunkId);
    onPlay(buffer);
    setTimeout(() => {
        setPlayingId(prev => prev === chunkId ? null : prev);
    }, buffer.duration * 1000);
  };

  const startEditing = (chunk: DubbingChunk) => {
      setEditingId(chunk.id);
      setEditStart(formatTimeForScript(chunk.startTime));
      setEditEnd(formatTimeForScript(chunk.endTime));
  };

  const saveEditing = (chunkId: string) => {
      onUpdateTiming(chunkId, editStart, editEnd);
      setEditingId(null);
  };

  const cancelEditing = () => {
      setEditingId(null);
  };

  if (chunks.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-[600px]">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center shrink-0">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Clock size={16} className="text-indigo-600" />
                Sync Manager <span className="text-[10px] font-normal text-slate-400 ml-1">(Strict Sync: Enabled)</span>
            </h3>
            <span className="text-xs text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">
                {Object.keys(chunkCache).length} / {chunks.length} Generated
            </span>
        </div>
        <div className="overflow-y-auto divide-y divide-slate-100 flex-1">
            {chunks.map((chunk, index) => {
                const cached = chunkCache[chunk.id];
                const targetDuration = chunk.endTime - chunk.startTime;
                // For actual displayed duration, we match target because we force-fitted it, unless cache is missing
                const displayedDuration = cached ? cached.buffer.duration : 0;
                
                const ratio = cached?.ratio || 1.0;
                const isStretched = ratio < 0.95; // Slowed down
                const isCompressed = ratio > 1.05; // Speed up
                
                let borderColor = "border-transparent";
                
                if (cached) {
                    if (isCompressed) {
                        borderColor = "border-amber-400"; // Warn about fast speech
                    } else if (isStretched) {
                        borderColor = "border-blue-400"; // Info about slowed speech
                    } else {
                        borderColor = "border-emerald-400";
                    }
                }

                const isEditing = editingId === chunk.id;

                return (
                    <div key={chunk.id} className={`p-3 hover:bg-slate-50 transition-colors flex flex-col gap-2 border-l-4 ${borderColor}`}>
                        {/* Header Row: Speaker & Text */}
                        <div className="flex items-start gap-3">
                            <div className="w-6 text-center text-xs font-mono text-slate-300 mt-1">
                                {index + 1}
                            </div>
                            
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-bold text-slate-700 truncate max-w-[100px]" title={chunk.speakerName}>
                                        {chunk.speakerName}
                                    </span>
                                </div>
                                <p className="text-sm text-slate-700 leading-snug">
                                    {chunk.lines.map(l => l.spokenText).join(' ')}
                                </p>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                                {cached ? (
                                    <>
                                        <button 
                                            onClick={() => handlePlay(chunk.id, cached.buffer)}
                                            className={`p-2 rounded-lg transition-all ${playingId === chunk.id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'}`}
                                            title="Play Segment"
                                        >
                                            {playingId === chunk.id ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                                        </button>
                                        <button 
                                            onClick={() => onRegenerate(chunk)}
                                            disabled={isGenerating}
                                            className="p-2 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors disabled:opacity-30"
                                            title="Regenerate this segment (Forces strict sync to Target Time)"
                                        >
                                            <RotateCcw size={16} />
                                        </button>
                                    </>
                                ) : (
                                    <div className="flex items-center gap-1 text-slate-400 text-xs italic">
                                        <Loader2 size={14} className="animate-spin" />
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Timing Row */}
                        <div className="ml-9 flex flex-wrap items-center gap-4 bg-slate-100/50 p-2 rounded-lg">
                            {isEditing ? (
                                <div className="flex items-center gap-2">
                                    <div className="flex flex-col">
                                        <label className="text-[9px] uppercase text-slate-500 font-bold mb-0.5">Start</label>
                                        <input 
                                            type="text" 
                                            value={editStart}
                                            onChange={(e) => setEditStart(e.target.value)}
                                            className="w-24 text-xs font-mono border border-slate-300 rounded px-1 py-0.5 focus:border-indigo-500 outline-none"
                                        />
                                    </div>
                                    <span className="text-slate-400 mt-4">→</span>
                                    <div className="flex flex-col">
                                        <label className="text-[9px] uppercase text-slate-500 font-bold mb-0.5">End</label>
                                        <input 
                                            type="text" 
                                            value={editEnd}
                                            onChange={(e) => setEditEnd(e.target.value)}
                                            className="w-24 text-xs font-mono border border-slate-300 rounded px-1 py-0.5 focus:border-indigo-500 outline-none"
                                        />
                                    </div>
                                    <div className="flex items-center gap-1 mt-4">
                                        <button onClick={() => saveEditing(chunk.id)} className="text-emerald-600 hover:bg-emerald-50 p-1.5 rounded"><Check size={14} /></button>
                                        <button onClick={cancelEditing} className="text-red-500 hover:bg-red-50 p-1.5 rounded"><RotateCcw size={14} /></button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 group/time cursor-pointer" onClick={() => startEditing(chunk)} title="Edit Target Duration (Constraints)">
                                    <Lock size={10} className="text-slate-400" />
                                    <span className="text-xs font-mono text-slate-600 bg-white border border-slate-200 px-1.5 py-0.5 rounded group-hover/time:border-indigo-300 transition-colors">
                                        {formatTimeForScript(chunk.startTime)}
                                    </span>
                                    <span className="text-slate-300">→</span>
                                    <span className="text-xs font-mono text-slate-600 bg-white border border-slate-200 px-1.5 py-0.5 rounded group-hover/time:border-indigo-300 transition-colors">
                                        {formatTimeForScript(chunk.endTime)}
                                    </span>
                                </div>
                            )}

                            <div className="h-4 w-px bg-slate-300"></div>

                            <div className="flex items-center gap-3 text-xs">
                                <div className="flex flex-col">
                                    <span className="text-[10px] text-slate-400 uppercase font-bold">Target</span>
                                    <span className="font-mono">{targetDuration.toFixed(2)}s</span>
                                </div>
                                
                                <div className="flex flex-col">
                                    <span className="text-[10px] text-slate-400 uppercase font-bold">Generated</span>
                                    <span className={`font-mono font-bold text-slate-600`}>
                                        {displayedDuration > 0 ? displayedDuration.toFixed(2) + 's' : '--'}
                                    </span>
                                </div>

                                {cached && (
                                    <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase flex items-center gap-1 ${
                                        isCompressed ? 'bg-amber-100 text-amber-700' : 
                                        isStretched ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-600'
                                    }`}>
                                        <Gauge size={10} />
                                        {ratio.toFixed(2)}x Speed
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    </div>
  );
};
