
export interface SrtBlock {
  id: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Parses SRT file content into structured blocks.
 */
export function parseSRT(data: string): SrtBlock[] {
  // Remove BOM if present and normalize newlines
  const text = data.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.trim().split(/\n\n+/);
  
  return blocks.map(block => {
    const lines = block.split('\n');
    if (lines.length < 2) return null;

    // Find the timing line (contains "-->")
    const timingIndex = lines.findIndex(l => l.includes('-->'));
    if (timingIndex === -1) return null;

    const timeLine = lines[timingIndex];
    // SRT format: 00:00:00,000 --> 00:00:00,000
    // Relaxed regex to handle dots or commas
    const times = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!times) return null;
    
    const startSeconds = parseSrtTime(times[1]);
    const endSeconds = parseSrtTime(times[2]);
    
    // Join remaining lines as text (skip ID and timing)
    // Strip HTML tags like <i>, <b>, <font>
    const textContent = lines.slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '') 
      .replace(/\s+/g, ' ')
      .trim();
    
    return {
      id: parseInt(lines[0]) || 0,
      startSeconds,
      endSeconds,
      text: textContent
    };
  }).filter(b => b !== null && b.text.length > 0) as SrtBlock[];
}

function parseSrtTime(timeStr: string): number {
  const [h, m, s] = timeStr.replace(',', '.').split(':');
  return (parseInt(h) * 3600) + (parseInt(m) * 60) + parseFloat(s);
}

/**
 * Formats seconds into HH:MM:SS.mmm timestamp for the script editor
 */
export function formatTimeForScript(seconds: number): string {
  const date = new Date(seconds * 1000);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Converts a string timestamp [HH:MM:SS.mmm] back to seconds.
 * Supports optional milliseconds.
 */
export function parseScriptTimestamp(timestamp: string): number | null {
  // Relaxed regex to match 1 or 2 digit hours, optional milliseconds (1-3 digits)
  const match = timestamp.match(/(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return null;
  
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const s = parseInt(match[3]);
  // If milliseconds exist, pad right with zeros to make it proper fraction? 
  // No, parseInt("1") where .1 means 100ms. 
  // Actually usually .1 in timestamp string means 1ms if strict, but if user types .5 it means 500ms? 
  // Let's assume standard float parsing logic for the second part.
  
  let seconds = (h * 3600) + (m * 60) + s;
  
  if (match[4]) {
      // If string is .5, it is 500ms. .05 is 50ms. 
      // match[4] contains digits after dot.
      // "5" -> 0.5? No, "00:00:00.5" usually means 500ms? 
      // Standard SRT is 00:00:00,500. 
      // If user types .5, we treat as 500ms.
      const msStr = match[4].padEnd(3, '0'); 
      seconds += parseInt(msStr) / 1000;
  }
  
  return seconds;
}
