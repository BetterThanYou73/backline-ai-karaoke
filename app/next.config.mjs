/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // node:sqlite is a Node builtin. Keep the bundler out of it.
  serverExternalPackages: ["node:sqlite"],

  // Deliberately no COOP/COEP headers. Cross origin isolation would buy
  // SharedArrayBuffer for the worklet handoff, but pitch frames are tiny and
  // arrive at about 50 Hz, so postMessage is comfortably enough. Skipping
  // isolation keeps the MediaPipe WASM bundle loadable without CORP headers.
};

export default nextConfig;
