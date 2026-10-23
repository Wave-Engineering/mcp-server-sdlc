/**
 * Public surface for handlers — the only adapter module handlers should
 * import from. Re-exports `getAdapter`, the `PlatformAdapter` interface, and
 * the `AdapterResult` discriminated union.
 *
 * Importing the per-method `<method>-<platform>.ts` files directly from
 * handlers is a code smell: handlers should remain platform-agnostic and
 * dispatch through `getAdapter()`. A handler that needs the platform name as
 * well resolves it once with `platformFor()` and gets the matching adapter
 * from `adapterFor()`, never from `detectPlatform()` (#603).
 */

export { getAdapter, platformFor, adapterFor } from './route.js';
export type {
  PlatformAdapter,
  AdapterResult,
  PlatformAdapterMethod,
} from './types.js';
export { PLATFORM_ADAPTER_METHODS } from './types.js';
