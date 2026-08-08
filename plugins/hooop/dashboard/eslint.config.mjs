import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// Flat config (ESLint 9 / Next 16). Replaces the legacy `.eslintrc.json`
// that extended `next/core-web-vitals`. `next lint` was removed in Next 16;
// lint via the ESLint CLI (`npm run lint`).
const config = [
  {
    ignores: ["node_modules/", ".next/", "e2e/**"],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      "react/no-unescaped-entities": "off",
      // eslint-plugin-react-hooks@7 (pulled in by eslint-config-next 16) adds
      // the React Compiler ruleset. `refs` and `set-state-in-effect` flag ~50
      // pre-existing call sites that were valid under the Next 14 config.
      // Demoted to warnings so the migration doesn't impose a new hard failure;
      // adopting the React Compiler patterns is tracked as separate work.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
