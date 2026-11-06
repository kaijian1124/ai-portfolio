import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/e2e/**", "**/.next/**"],
    coverage: {
      provider: "v8",
      include: [
        "app/admin/catalog-actions.ts",
        "app/api/**/route.ts",
        "lib/sse.ts",
        "lib/request-body.ts",
        "lib/backend.ts",
        "lib/public-data.ts",
        "lib/catalog.ts",
        "lib/catalog-schema.ts",
        "lib/backend-readiness.ts",
        "lib/portfolio.ts",
        "lib/public-links.ts",
        "lib/admin-session.ts",
        "lib/auth-config.ts",
        "lib/backend-admin.ts",
        "lib/supabase/server.ts",
        "proxy.ts",
        "app/admin/actions.ts",
        "lib/profile-schema.ts",
        "lib/admin-profile.ts",
        "app/admin/profile/actions.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
