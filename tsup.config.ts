// import { defineConfig } from "tsup";
//
// export default defineConfig({
//     entry: ["src/index.ts"],
//     outDir: "dist",
//     sourcemap: true,
//     clean: true,
//     format: ["esm"], // Ensure you're targeting CommonJS
//     external: [
//         "@elizaos/core",
//         "dotenv", // Externalize dotenv to prevent bundling
//         "fs", // Externalize fs to use Node.js built-in module
//         "path", // Externalize other built-ins if necessary
//         "@reflink/reflink",
//         "@node-llama-cpp",
//         "https",
//         "http",
//         "agentkeepalive",
//         "@pinata/sdk"
//     ],
// });

import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'], // ESM output format
  dts: true,
  external: [
    'dotenv',
    'fs',
    'path',
    'https',
    'http',
    '@elizaos/core',
    'zod',
    "@reflink/reflink",
    "@node-llama-cpp",
    "agentkeepalive",
    "@pinata/sdk"
  ],
});
