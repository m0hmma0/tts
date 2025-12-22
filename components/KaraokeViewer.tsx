import React, { useEffect, useRef } from 'react';
import { WordTiming } from '../types';
import { X, Mic } from 'lucide-react';

interface KaraokeViewerProps {
  timings: WordTiming[];
  currentTime: number;
  onClose: () => void;
}

export const KaraokeViewer: React.FC<KaraokeViewerProps> = ({ timings, currentTime, onClose }) => {
  const activeRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center'
      });
    }
  }, [currentTime]); // Scroll whenever time updates and active element might change

  // Find active word index
  // We use a lenient match: if time is between start and end.
  const activeIndex = timings.findIndex(t => currentTime >= t.start && currentTime < t.end);

  return (
    <div className="fixed inset-0 z-[100] bg-white/95 backdrop-blur-xl flex flex-col items-center justify-center p-4 md:p-8 animate-in fade-in duration-300">
      <button 
        onClick={onClose}
        className="absolute top-6 right-6 p-3 bg-white rounded-full text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors shadow-lg border border-slate-200"
      >
        <X size={24} />
      </button>
      
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 mb-4">
          <Mic size={16} />
          <span className="text-xs font-bold uppercase tracking-wider">Sync Test Mode</span>
        </div>
        <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Timing Verification</h2>
        <p className="text-slate-500 mt-2">Visualizing generated JSON timestamps in real-time</p>
      </div>

      <div className="relative w-full max-w-4xl h-[50vh] flex flex-col items-center">
        {/* Mask gradients for smooth scroll appearance */}
        <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-white to-transparent z-10 pointer-events-none"></div>
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white to-transparent z-10 pointer-events-none"></div>

        <div 
          ref={containerRef}
          className="w-full h-full overflow-y-auto px-4 py-20 text-center leading-relaxed scroll-smooth no-scrollbar"
        >
          <div className="flex flex-wrap justify-center content-center gap-x-3 gap-y-6">
            {timings.map((t, i) => {
              const isActive = i === activeIndex;
              const isPast = currentTime > t.end;
              
              return (
                <span 
                  key={i}
                  ref={isActive ? activeRef : null}
                  className={`text-2xl md:text-4xl font-semibold transition-all duration-200 px-2 py-1 rounded-lg ${
                    isActive 
                      ? 'text-white bg-indigo-600 scale-105 shadow-xl shadow-indigo-600/30 z-10 ring-2 ring-indigo-400/50' 
                      : isPast 
                        ? 'text-slate-300 blur-[0.5px] scale-95' 
                        : 'text-slate-400'
                  }`}
                >
                  {t.word}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      
      <div className="mt-12 flex flex-col items-center gap-2">
        <div className="text-4xl font-mono font-bold text-indigo-600 tabular-nums tracking-tighter">
          {currentTime.toFixed(3)}<span className="text-lg text-indigo-400 ml-1">s</span>
        </div>
        <div className="h-1.5 w-64 bg-slate-200 rounded-full overflow-hidden">
            {timings.length > 0 && (
                <div 
                    className="h-full bg-indigo-600 transition-all duration-75 ease-out"
                    style={{ width: `${Math.min((currentTime / timings[timings.length-1].end) * 100, 100)}%` }}
                ></div>
            )}
        </div>
      </div>
    </div>
  );
};