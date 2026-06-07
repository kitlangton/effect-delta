import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "effect-delta": new URL("./src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["test/**/*.test.ts"]
  }
})
