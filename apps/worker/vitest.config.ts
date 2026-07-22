import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Les tests d'intégration LLM (appels Anthropic réels, facturés) vivent à
    // part — voir vitest.integration.config.ts / npm run test:llm.
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
  },
});
