// ESLint flat config. `npm run lint` checks the app source and build config.
//
// Severity policy:
// - react-hooks/rules-of-hooks is an error (a conditional hook is always a bug).
// - react-hooks/exhaustive-deps is a warning for now: existing effects in the
//   live-report/page-evidence hooks intentionally omit some dependencies and
//   are tracked for review. Do not add new warnings — `npm run lint:strict`
//   (--max-warnings 0) is the target once they are resolved.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "artifacts/**", "node_modules/**", "public/**", "scripts/**"]
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "warn"
    }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // TypeScript (noUnusedLocals/noUnusedParameters) already reports these.
      "@typescript-eslint/no-unused-vars": "off",
      // Style-only findings in existing code; keep visible without failing CI.
      "no-useless-escape": "warn",
      "prefer-const": "warn"
    }
  },
  {
    // The scroll engine is framework-agnostic vanilla JS that swallows
    // media/playback errors on purpose (`catch (e) {}`).
    files: ["src/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "none" }]
    }
  },
  {
    files: ["vite.config.ts", "eslint.config.js"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node
    }
  }
);
