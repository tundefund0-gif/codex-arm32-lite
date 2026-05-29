#!/usr/bin/env node
import { main } from '../src/index.js';

process.title = 'codex';

main(process.argv.slice(2)).catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
