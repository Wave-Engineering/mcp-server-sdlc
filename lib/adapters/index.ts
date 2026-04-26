/**
 * Public surface for handlers — the only adapter module handlers should
 * import from. Re-exports `getAdapter`, the `PlatformAdapter` interface, and
 * the `AdapterResult` discriminated union.
 *
 * Importing the per-method `<method>-<platform>.ts` files directly from
 * handlers is a code smell: handlers should remain platform-agnostic and
 * dispatch through `getAdapter()`.
 */

export { getAdapter } from './route.js';
export type {
  PlatformAdapter,
  AdapterResult,
  PlatformAdapterMethod,
} from './types.js';
export { PLATFORM_ADAPTER_METHODS } from './types.js';
