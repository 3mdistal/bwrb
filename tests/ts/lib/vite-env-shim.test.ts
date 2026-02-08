import { describe, expect, it } from 'vitest';
import {
  createVitestViteEnvShimPlugin,
  VITE_ENV_SHIM_ID,
} from '../support/vite-env-shim.js';

describe('vite-env-shim', () => {
  it('uses a stable virtual id', () => {
    expect(VITE_ENV_SHIM_ID).toBe('\0bwrb:vitest-vite-env');
  });

  it('resolves vite env IDs to the shim', () => {
    const plugin = createVitestViteEnvShimPlugin();

    expect(plugin.resolveId('/@vite/env')).toBe(VITE_ENV_SHIM_ID);
    expect(plugin.resolveId('/@vite/env?import')).toBe(VITE_ENV_SHIM_ID);
    expect(plugin.resolveId('/@fs/x/node_modules/vite/dist/client/env.mjs')).toBe(VITE_ENV_SHIM_ID);
  });

  it('returns a no-op ESM module for the shim id', async () => {
    const plugin = createVitestViteEnvShimPlugin();

    expect(await plugin.load(VITE_ENV_SHIM_ID)).toBe('export {};\n');
    expect(await plugin.load('\0bwrb:other')).toBeNull();
  });
});
