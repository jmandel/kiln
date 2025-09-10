import type { Stores } from './types';
import { createIndexedDbStores } from './stores.indexeddb';
import { createLocalStores } from './stores';

/**
 * Factory that prefers IndexedDB stores and falls back to LocalStorage stores.
 */
export async function createStores(): Promise<Stores> {
  try {
    // Try IndexedDB first
    const s = await createIndexedDbStores();
    return s;
  } catch {
    // Fallback to LocalStorage stores
    return createLocalStores();
  }
}

