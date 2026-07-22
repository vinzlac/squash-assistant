import { defineConfig } from "vitest/config";

/**
 * Tests d'intégration réels (appels LLM Anthropic facturés, non déterministes) —
 * séparés de `npm test` (vitest.config.ts) pour ne jamais tourner en CI par
 * défaut ni consommer de quota sans le vouloir. Nécessite ANTHROPIC_API_KEY.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
  },
});
