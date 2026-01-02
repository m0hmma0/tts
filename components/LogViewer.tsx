
import React, { useEffect, useRef } from 'react';
import { LogEntry } from '../types';
import { Terminal, XCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react';

interface LogViewerProps {
  logs: LogEntry[];
  onClear: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ logs, onClear }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getIcon = (level: string) => {
    switch (level) {
      case 'error': return <XCircle size={14} className="text-red-400 mt-0.5" />;
      case 'success': return <CheckCircle size={14} className="text-emerald-400 mt-0.5" />;
      case 'warn': return <AlertTriangle size={14} className="text-amber-400 mt-0.5" />;
      default: return <Info size={14} className="text-blue-400 mt-0.5" />;
    }
  };

  const getColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-300';
      case 'success': return 'text-emerald-300';
      case 'warn': return 'text-amber-300';
      default: return 'text-slate-300';
    }
  };

  return (
    <div className="flex flex-col bg-slate-900 rounded-xl border border-slate-800 shadow-lg overflow-hidden h-[300px]">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-slate-400" />
          <span className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider">Execution Logs</span>
        </div>
        <button 
          onClick={onClear}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          Clear Logs
        </button>
      </div>
      
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-2"
      >
        {logs.length === 0 && (
          <div className="text-slate-600 italic text-center mt-20">Waiting for events...</div>
        )}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-3 items-start animate-in fade-in slide-in-from-left-2 duration-300">
            <span className="text-slate-600 shrink-0 select-none">
              {log.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit', fractionDigits: 3 })}
            </span>
            <span className="shrink-0">{getIcon(log.level)}</span>
            <span className={`break-words ${getColor(log.level)}`}>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
