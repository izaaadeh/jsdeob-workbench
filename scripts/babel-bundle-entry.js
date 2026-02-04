/**
 * Entry file for bundling Babel packages for use in Web Workers
 * This gets bundled by esbuild into client/js/babel-bundle.js
 */

// Polyfill process for browser/worker environment (Babel checks process.env.NODE_ENV)
if (typeof self !== 'undefined' && typeof self.process === 'undefined') {
  self.process = { env: { NODE_ENV: 'production' } };
}

import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

// Expose as globals for the Web Worker
self.babelParser = parser;
self.babelTraverse = traverse;
self.babelGenerator = generate;
self.babelTypes = t;

// Also expose a convenience object
self.BabelModules = {
  parser,
  traverse,
  generate,
  types: t
};

console.log('[babel-bundle] Babel modules loaded successfully');
