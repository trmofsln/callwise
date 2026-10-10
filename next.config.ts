import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Files read at runtime by path, which the bundler cannot see: the live model artifacts and the
  // ffmpeg binary used to prepare call recordings for Sarvam speech-to-text.
  outputFileTracingIncludes: {
    "/api/**/*": ["./models/live/**/*.json"],
    "/api/recordings": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
