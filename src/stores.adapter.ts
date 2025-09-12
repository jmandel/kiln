import type { Stores } from './types';
import { createIndexedDbStores } from './stores.indexeddb';

/**
 * Factory that uses IndexedDB stores
 */
export async function createStores(): Promise<Stores> {
  const s = await createIndexedDbStores();
  return s;
}

