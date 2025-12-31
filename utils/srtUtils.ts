
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
    const times = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
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
 * Converts a string timestamp [HH:MM:SS.mmm] back to seconds
 */
export function parseScriptTimestamp(timestamp: string): number | null {
  const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return null;
  
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const s = parseInt(match[3]);
  const ms = parseInt(match[4]);
  
  return (h * 3600) + (m * 60) + s + (ms / 1000);
}
