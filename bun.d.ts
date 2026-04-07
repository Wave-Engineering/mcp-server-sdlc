// Bun bundler globals — import.meta.glob is resolved at bun build time.
// See: https://bun.sh/docs/bundler/macros
interface ImportMeta {
  glob(pattern: string, options?: { eager?: boolean }): Record<string, unknown>;
}
