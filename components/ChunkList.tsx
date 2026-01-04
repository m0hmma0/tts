
import React, { useState, useEffect } from 'react';
import { DubbingChunk, AudioCacheItem, WordTiming } from '../types';
import { Play, RotateCcw, Check, Loader2, AlertCircle, Square, Save, Clock, Lock, Gauge, RefreshCw, X, ToggleLeft, ToggleRight } from 'lucide-react';
import { formatTimeForScript, parseScriptTimestamp } from '../utils/srtUtils';

interface ChunkListProps {
  chunks: DubbingChunk[];
  chunkCache: Record<string, { buffer: AudioBuffer, timings: WordTiming[], ratio?: number }>;
  isGenerating: boolean;
  onRegenerate: (chunk: DubbingChunk) => void;
  onPlay: (buffer: AudioBuffer) => void;
  onUpdateTiming: (chunkId: string, newStart: string, newEnd: string) => void;
  strictSync: boolean;
  setStrictSync: (enabled: boolean) => void;
}

export const ChunkList: React.FC<ChunkListProps> = ({ 
  chunks, 
  chunkCache, 
  isGenerating, 
  onRegenerate,
  onPlay,
  onUpdateTiming,
  strictSync,
  setStrictSync
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editSpeed, setEditSpeed] = useState<string>("1.00");

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
      
      const cached = chunkCache[chunk.id];
      if (cached && cached.ratio) {
          setEditSpeed(cached.ratio.toFixed(2));
      } else {
          setEditSpeed("1.00");
      }
  };

  const saveEditing = (chunkId: string) => {
      onUpdateTiming(chunkId, editStart, editEnd);
      setEditingId(null);
  };

  const cancelEditing = () => {
      setEditingId(null);
  };

  // Auto-calculate End Time when Speed changes
  const handleSpeedChange = (newSpeedStr: string, chunkId: string) => {
      setEditSpeed(newSpeedStr);
      
      const speed = parseFloat(newSpeedStr);
      const cached = chunkCache[chunkId];
      
      if (!isNaN(speed) && speed > 0 && cached) {
          const currentDuration = cached.buffer.duration;
          const currentRatio = cached.ratio || 1.0;
          const naturalDuration = currentDuration * currentRatio;
          
          const newTargetDuration = naturalDuration / speed;
          
          const startSecs = parseScriptTimestamp(editStart);
          if (startSecs !== null) {
              const newEndSecs = startSecs + newTargetDuration;
              setEditEnd(formatTimeForScript(newEndSecs));
          }
      }
  };

  if (chunks.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-[600px]">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center shrink-0">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Clock size={16} className="text-indigo-600" />
                Sync Manager
            </h3>
            
            <div className="flex items-center gap-4">
                <button 
                    onClick={() => setStrictSync(!strictSync)}
                    className={`flex items-center gap-2 text-xs font-medium px-2 py-1 rounded transition-colors ${strictSync ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}
                    title={strictSync ? "Disable to allow natural audio duration (ignores timestamp constraints)" : "Enable to force audio to fit strictly within start/end timestamps"}
                >
                    {strictSync ? <ToggleRight size={24} className="text-indigo-600" /> : <ToggleLeft size={24} className="text-slate-400" />}
                    {strictSync ? "Strict Sync ON" : "Strict Sync OFF"}
                </button>
                
                <span className="text-xs text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">
                    {Object.keys(chunkCache).length} / {chunks.length} Generated
                </span>
            </div>
        </div>
        <div className="overflow-y-auto divide-y divide-slate-100 flex-1">
            {chunks.map((chunk, index) => {
                const cached = chunkCache[chunk.id];
                const isEditing = editingId === chunk.id;
                
                // Calculate dynamic target duration for feedback
                let effectiveStartTime = chunk.startTime;
                let effectiveEndTime = chunk.endTime;
                
                if (isEditing) {
                    const parsedStart = parseScriptTimestamp(editStart);
                    const parsedEnd = parseScriptTimestamp(editEnd);
                    if (parsedStart !== null) effectiveStartTime = parsedStart;
                    if (parsedEnd !== null) effectiveEndTime = parsedEnd;
                }
                
                const targetDuration = Math.max(0, effectiveEndTime - effectiveStartTime);
                const ratio = cached?.ratio || 1.0;
                
                // Only warn about ratio if strict sync is active, otherwise visual styling is neutral
                const isStretched = strictSync && ratio < 0.95; 
                const isCompressed = strictSync && ratio > 1.05; 
                
                let borderColor = "border-transparent";
                
                if (cached) {
                    if (strictSync) {
                        if (isCompressed) {
                            borderColor = "border-amber-400"; // Warn about fast speech
                        } else if (isStretched) {
                            borderColor = "border-blue-400"; // Info about slowed speech
                        } else {
                            borderColor = "border-emerald-400";
                        }
                    } else {
                        borderColor = "border-slate-300"; // Neutral generated state
                    }
                }

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
                                            title={strictSync ? "Regenerate (Forces strict sync to Target Time)" : "Regenerate (Natural Duration)"}
                                        >
                                            <RotateCcw size={16} />
                                        </button>
                                    </>
                                ) : (
                                    // If not cached, verify if it's truly generating or just empty
                                    isGenerating ? (
                                        <div className="flex items-center gap-1 text-slate-400 text-xs italic">
                                            <Loader2 size={14} className="animate-spin" />
                                        </div>
                                    ) : (
                                        <button 
                                            onClick={() => onRegenerate(chunk)}
                                            className="p-2 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors flex items-center gap-2 text-xs font-semibold"
                                            title="Generate Audio"
                                        >
                                            <RefreshCw size={14} /> Generate
                                        </button>
                                    )
                                )}
                            </div>
                        </div>

                        {/* Timing Row */}
                        <div className="ml-9 flex flex-wrap items-center gap-4 bg-slate-100/50 p-2 rounded-lg">
                            {isEditing ? (
                                <div className="flex flex-wrap items-center gap-3 w-full">
                                    <div className="flex flex-col">
                                        <label className="text-[9px] uppercase text-slate-500 font-bold mb-0.5">Start</label>
                                        <input 
                                            type="text" 
                                            value={editStart}
                                            onChange={(e) => setEditStart(e.target.value)}
                                            className="w-24 text-xs font-mono border border-slate-300 rounded px-1 py-1 focus:border-indigo-500 outline-none"
                                        />
                                    </div>
                                    
                                    <span className="text-slate-400 mt-4">→</span>
                                    
                                    <div className="flex flex-col">
                                        <label className="text-[9px] uppercase text-slate-500 font-bold mb-0.5">End</label>
                                        <input 
                                            type="text" 
                                            value={editEnd}
                                            onChange={(e) => setEditEnd(e.target.value)}
                                            className="w-24 text-xs font-mono border border-slate-300 rounded px-1 py-1 focus:border-indigo-500 outline-none"
                                        />
                                    </div>

                                    {/* Speed Input (Only active if strict sync allows calculation context, but readable always) */}
                                    {cached && (
                                        <div className="flex flex-col ml-2 border-l pl-3 border-slate-200">
                                            <label className="text-[9px] uppercase text-slate-500 font-bold mb-0.5 text-indigo-600">Speed (x)</label>
                                            <input 
                                                type="number" 
                                                step="0.05"
                                                min="0.1"
                                                max="4.0"
                                                value={editSpeed}
                                                onChange={(e) => handleSpeedChange(e.target.value, chunk.id)}
                                                disabled={!strictSync}
                                                className={`w-16 text-xs font-mono border border-indigo-200 bg-indigo-50 text-indigo-700 rounded px-1 py-1 focus:border-indigo-500 outline-none font-bold ${!strictSync ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            />
                                        </div>
                                    )}

                                    <div className="flex items-center gap-1 ml-auto mt-4">
                                        <button onClick={() => saveEditing(chunk.id)} className="bg-emerald-500 hover:bg-emerald-600 text-white p-1.5 rounded transition-colors shadow-sm"><Check size={14} /></button>
                                        <button onClick={cancelEditing} className="bg-white border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-500 p-1.5 rounded transition-colors shadow-sm"><X size={14} /></button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 group/time cursor-pointer hover:bg-white/50 rounded px-1" onClick={() => startEditing(chunk)} title="Click to Edit Timing & Speed">
                                    <Lock size={10} className="text-slate-400 group-hover/time:text-indigo-500" />
                                    <span className="text-xs font-mono text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded bg-white group-hover/time:border-indigo-300 transition-colors">
                                        {formatTimeForScript(chunk.startTime)}
                                    </span>
                                    <span className="text-slate-300">→</span>
                                    <span className="text-xs font-mono text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded bg-white group-hover/time:border-indigo-300 transition-colors">
                                        {formatTimeForScript(chunk.endTime)}
                                    </span>
                                </div>
                            )}

                            {!isEditing && (
                                <>
                                    <div className="h-4 w-px bg-slate-300 hidden sm:block"></div>
                                    <div className="flex items-center gap-3 text-xs">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] text-slate-400 uppercase font-bold">Target</span>
                                            <span className="font-mono">{targetDuration.toFixed(2)}s</span>
                                        </div>
                                        
                                        {cached && (
                                            <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase flex items-center gap-1 ${
                                                !strictSync ? 'bg-slate-100 text-slate-500' : 
                                                isCompressed ? 'bg-amber-100 text-amber-700' : 
                                                isStretched ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-600'
                                            }`}>
                                                <Gauge size={10} />
                                                {strictSync ? `${ratio.toFixed(2)}x` : 'Natural'}
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    </div>
  );
};
