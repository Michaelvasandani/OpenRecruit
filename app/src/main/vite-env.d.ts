// electron-vite injects these into the main/host bundles via `import.meta.env`
// (build-time). The main tsconfig uses `"types": ["node"]` (no vite/client), so
// declare the minimal surface we read here rather than pulling in vite/client.

interface ImportMetaEnv {
  /** True under `electron-vite dev`, false in a packaged build. */
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  /** PostHog project key, baked in at build time; absent → analytics no-op. */
  readonly MAIN_VITE_POSTHOG_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
