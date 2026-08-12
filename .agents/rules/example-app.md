# Example App Rules

1. The app is an Expo Router project under `example/` and application code lives
   under `example/src/`.
2. `example/package.json` must reference the repository package directly so a
   local build exercises the current checkout, not the published npm version.
3. Configure `buildCacheProvider` at the top Expo config level with plugin
   `eas-local-cache`.
4. Use HeroUI Native patterns only: `HeroUINativeProvider`, compound components,
   semantic variants, and `onPress` handlers.
5. Use Uniwind with Tailwind CSS v4. Import `global.css` from the root layout and
   keep `withUniwindConfig` as the outermost Metro wrapper.
6. Keep the screen deliberately small and make the terminal-driven miss-to-hit
   workflow explicit. Do not present runtime UI as live provider state.
7. Never commit generated native projects, `.expo/`, cache entries, or simulator
   artifacts.
8. Before considering a cache milestone complete, run static example checks and,
   when local tooling is available, two identical `expo run` commands to prove a
   miss/upload followed by a hit.
