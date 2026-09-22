import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The simulated events count from config.yaml's default start block (test/helpers.ts), so a later
    // ENVIO_START_BLOCK_10143 in a hosted-like .env must not filter them out.
    env: { ENVIO_START_BLOCK_10143: "69452198" },
  },
});
