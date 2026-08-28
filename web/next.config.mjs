import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
export default {
  // Route handlers import agent/create-agent.js from outside web/, so file
  // tracing has to be rooted at the repo, not at this workspace.
  outputFileTracingRoot: repoRoot,
  // Next writes its own AGENTS.md/CLAUDE.md into this workspace on dev start.
  // The repo already documents its conventions at the root, and a generated
  // file that shadows them is worse than none.
  agentRules: false,
};
