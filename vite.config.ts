import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, (process as any).cwd(), '');

  // Aggregate all API keys into a pool
  // We look for API_KEY_1 through API_KEY_5, and the standard API_KEY
  const rawKeys = [
    env.API_KEY_1,
    env.API_KEY_2,
    env.API_KEY_3,
    env.API_KEY_4,
    env.API_KEY_5,
    env.API_KEY
  ];

  // Filter out undefined or empty strings and remove duplicates
  const uniqueKeys = [...new Set(rawKeys.filter(k => !!k && k.trim().length > 0))];

  return {
    plugins: [react()],
    define: {
      // Inject the array of keys as a JSON string so the frontend can parse it
      'process.env.API_KEY_POOL': JSON.stringify(uniqueKeys),
    },
  };
});