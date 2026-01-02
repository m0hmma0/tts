
import React, { useState, useEffect } from 'react';
import { DubbingChunk, AudioCacheItem, WordTiming } from '../types';
import { Play, RotateCcw, Check, Loader2, AlertCircle, Square, Save, Clock } from 'lucide-react';
import { formatTimeForScript, parseScriptTimestamp } from '../utils/srtUtils';

interface ChunkListProps {
  chunks: DubbingChunk[];
  chunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[] }>;
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
  
  // Local edit states
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
                Sync Manager
            </h3>
            <span className="text-xs text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">
                {Object.keys(chunkCache).length} / {chunks.length} Generated
            </span>
        </div>
        <div className="overflow-y-auto divide-y divide-slate-100 flex-1">
            {chunks.map((chunk, index) => {
                const cached = chunkCache[chunk.id];
                const targetDuration = chunk.endTime - chunk.startTime;
                const actualDuration = cached ? cached.buffer.duration : 0;
                
                // Diff logic
                const diff = actualDuration - targetDuration;
                const isOvershoot = diff > 0.1; // 100ms tolerance
                const isUndershoot = diff < -0.5; // Audio matches, but video has gap
                
                let borderColor = "border-transparent";
                let statusColor = "text-slate-400";
                
                if (cached) {
                    if (isOvershoot) {
                        borderColor = "border-red-500";
                        statusColor = "text-red-500";
                    } else if (isUndershoot) {
                        borderColor = "border-amber-400"; // Gap warning
                        statusColor = "text-amber-500";
                    } else {
                        borderColor = "border-emerald-400";
                        statusColor = "text-emerald-500";
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
                                            title="Regenerate this segment"
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
                                    <input 
                                        type="text" 
                                        value={editStart}
                                        onChange={(e) => setEditStart(e.target.value)}
                                        className="w-24 text-xs font-mono border border-slate-300 rounded px-1 py-0.5 focus:border-indigo-500 outline-none"
                                        placeholder="00:00:00.000"
                                    />
                                    <span className="text-slate-400">→</span>
                                    <input 
                                        type="text" 
                                        value={editEnd}
                                        onChange={(e) => setEditEnd(e.target.value)}
                                        className="w-24 text-xs font-mono border border-slate-300 rounded px-1 py-0.5 focus:border-indigo-500 outline-none"
                                        placeholder="00:00:00.000"
                                    />
                                    <button onClick={() => saveEditing(chunk.id)} className="text-emerald-600 hover:bg-emerald-50 p-1 rounded"><Check size={14} /></button>
                                    <button onClick={cancelEditing} className="text-red-500 hover:bg-red-50 p-1 rounded"><RotateCcw size={14} /></button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 group/time cursor-pointer" onClick={() => startEditing(chunk)} title="Click to edit timestamps">
                                    <span className="text-xs font-mono text-slate-600 bg-white border border-slate-200 px-1.5 py-0.5 rounded">
                                        {formatTimeForScript(chunk.startTime)}
                                    </span>
                                    <span className="text-slate-300">→</span>
                                    <span className="text-xs font-mono text-slate-600 bg-white border border-slate-200 px-1.5 py-0.5 rounded">
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
                                    <span className="text-[10px] text-slate-400 uppercase font-bold">Actual</span>
                                    <span className={`font-mono font-bold ${statusColor}`}>
                                        {actualDuration > 0 ? actualDuration.toFixed(2) + 's' : '--'}
                                    </span>
                                </div>

                                {cached && (
                                    <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                        isOvershoot ? 'bg-red-100 text-red-600' : 
                                        isUndershoot ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'
                                    }`}>
                                        {isOvershoot ? `+${diff.toFixed(2)}s Drift` : 
                                         isUndershoot ? `${diff.toFixed(2)}s Gap` : 'Sync OK'}
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
