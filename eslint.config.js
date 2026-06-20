import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "dashboard/dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `npm run typecheck` (tsc) resolves identifiers and ambient/platform globals (process, fetch,
      // document, …) far more accurately than ESLint's no-undef, which reports false positives on
      // type-only references and DOM/Node globals. See typescript-eslint's FAQ — disable no-undef for TS.
      "no-undef": "off",
    },
  },
);
