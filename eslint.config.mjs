import nextVitals from "eslint-config-next/core-web-vitals";

export default [
  ...nextVitals,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "data/**",
      "logs/**",
      "evaluation/reports/**",
    ],
  },
];
