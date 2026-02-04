/**
 * Transform Worker - Offloads heavy AST operations to a Web Worker
 * This keeps the main thread responsive during large transformations.
 */

// Import the bundled Babel packages (built with esbuild from scripts/babel-bundle-entry.js)
importScripts('./babel-bundle.js');

// Get the modules from globals set by the bundle
const parser = self.babelParser;
const traverse = self.babelTraverse;
const generate = self.babelGenerator;
const t = self.babelTypes;

// Log what we found for debugging
console.log('[Worker] Babel modules loaded:', {
  parser: !!parser,
  types: !!t,
  traverse: !!traverse,
  generate: !!generate
});

// Verify all modules loaded
const WORKER_READY = !!(parser && t && traverse && generate);

if (!WORKER_READY) {
  console.error('[Worker] Some Babel modules failed to load');
  self.postMessage({ type: 'error', payload: { 
    error: 'Babel modules failed to load in worker',
    available: { parser: !!parser, types: !!t, traverse: !!traverse, generate: !!generate }
  }});
}

/**
 * Parse code to AST
 */
function parseCode(code) {
  return parser.parse(code, {
    sourceType: 'unambiguous',
    plugins: ['jsx', 'typescript', 'decorators-legacy']
  });
}

/**
 * Generate code from AST
 */
function generateCode(ast) {
  return generate(ast, {
    comments: true,
    compact: false
  });
}

/**
 * Run a user-provided transform
 */
function runTransform(ast, transformCode, config = {}) {
  const stats = {};
  const logs = [];
  let modified = false;

  // Console capture
  const customConsole = {
    log: (...args) => logs.push({ type: 'log', args: args.map(String) }),
    warn: (...args) => logs.push({ type: 'warn', args: args.map(String) }),
    error: (...args) => logs.push({ type: 'error', args: args.map(String) }),
    info: (...args) => logs.push({ type: 'info', args: args.map(String) })
  };

  // Smart traverse wrapper
  const smartTraverse = (firstArg, secondArg) => {
    let visitor;
    if (secondArg !== undefined) {
      visitor = secondArg;
    } else if (firstArg && typeof firstArg === 'object') {
      if (firstArg.type && typeof firstArg.type === 'string') {
        throw new Error('traverse() called with only an AST. Usage: traverse(ast, { Visitor(path) {...} })');
      }
      visitor = firstArg;
    } else {
      throw new Error('traverse() requires a visitor object');
    }
    traverse(ast, visitor);
    modified = true;
  };

  // Parser wrapper for plugins that need to parse code strings
  const parserWrapper = {
    parse: (code, opts = {}) => parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'decorators-legacy'],
      allowReturnOutsideFunction: true,
      ...opts
    })
  };

  // Generate wrapper for plugins that need to generate code
  const generateWrapper = (node, opts = {}) => generate(node, { 
    comments: true, 
    compact: false,
    ...opts 
  });

  // Run helper - executes JavaScript code and returns the result
  // Useful for evaluating obfuscated strings/expressions
  const run = (code) => {
    try {
      return eval(code);
    } catch (e) {
      logs.push({ type: 'error', args: [`run() error: ${e.message}`] });
      return undefined;
    }
  };

  // Mock module/exports for transforms that use module.exports pattern
  const module = { exports: {} };
  const exports = module.exports;

  // Execute transform
  const fn = new Function(
    'ast', 'traverse', 't', 'types', 'config', 'stats', 'console',
    'JSON', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'RegExp', 'Date',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'unescape', 'decodeURIComponent',
    'module', 'exports', 'parser', 'generate', 'eval', 'Function', 'run',
    transformCode
  );

  fn(
    ast, smartTraverse, t, t, config, stats, customConsole,
    JSON, Math, String, Number, Boolean, Array, Object, RegExp, Date,
    parseInt, parseFloat, isNaN, isFinite, unescape, decodeURIComponent,
    module, exports, parserWrapper, generateWrapper, eval, Function, run
  );

  // If transform exported a visitor, run it
  if (module.exports && typeof module.exports === 'object' && !Array.isArray(module.exports)) {
    if (module.exports.Identifier || module.exports.CallExpression || module.exports.enter || 
        Object.keys(module.exports).some(k => /^[A-Z]/.test(k))) {
      smartTraverse(module.exports);
    }
  }

  return { ast, stats, logs, modified };
}

// Message handler
self.onmessage = function(e) {
  const { id, type, payload } = e.data;

  try {
    let result;

    switch (type) {
      case 'parse': {
        const ast = parseCode(payload.code);
        result = { success: true, ast };
        break;
      }

      case 'generate': {
        const output = generateCode(payload.ast);
        result = { success: true, code: output.code };
        break;
      }

      case 'transform': {
        // Parse if needed
        let ast = payload.ast;
        if (!ast) {
          ast = parseCode(payload.code);
        }

        // Run transform
        const transformResult = runTransform(ast, payload.transformCode, payload.config || {});

        // Generate code if requested
        let code = null;
        if (payload.generateCode !== false) {
          code = generateCode(transformResult.ast).code;
        }

        result = {
          success: true,
          code,
          ast: payload.returnAST ? transformResult.ast : null,
          stats: transformResult.stats,
          logs: transformResult.logs,
          modified: transformResult.modified
        };
        break;
      }

      case 'format': {
        const ast = parseCode(payload.code);
        const output = generateCode(ast);
        result = { success: true, code: output.code };
        break;
      }

      case 'runChain': {
        // Run a chain of transforms
        let ast = parseCode(payload.code);
        const results = [];
        let currentCode = payload.code;

        for (let i = 0; i < payload.recipe.length; i++) {
          const transform = payload.recipe[i];
          
          if (!transform.enabled) {
            results.push({ index: i, transform: transform.id, skipped: true });
            continue;
          }

          const startTime = performance.now();

          try {
            const transformResult = runTransform(ast, transform.code, transform.config || {});
            ast = transformResult.ast;
            
            const duration = Math.round(performance.now() - startTime);
            
            // Generate code to get size (but don't store the full code for middle steps)
            const tempCode = generateCode(ast).code;
            
            results.push({
              index: i,
              transform: transform.id,
              success: true,
              stats: transformResult.stats,
              logs: transformResult.logs,
              duration,
              codeSize: tempCode.length
            });

            // Report progress
            self.postMessage({
              id,
              type: 'progress',
              payload: { step: i, total: payload.recipe.length }
            });

          } catch (err) {
            results.push({
              index: i,
              transform: transform.id,
              success: false,
              error: err.message
            });

            // Generate current code state
            currentCode = generateCode(ast).code;

            self.postMessage({
              id,
              type: 'result',
              payload: {
                success: false,
                failedAt: i,
                results,
                currentCode,
                error: err.message
              }
            });
            return;
          }
        }

        // Final generation
        const finalCode = generateCode(ast).code;

        result = {
          success: true,
          results,
          finalCode
        };
        break;
      }

      default:
        result = { success: false, error: `Unknown message type: ${type}` };
    }

    self.postMessage({ id, type: 'result', payload: result });

  } catch (error) {
    self.postMessage({
      id,
      type: 'result',
      payload: { success: false, error: error.message, stack: error.stack }
    });
  }
};

// Signal worker is ready
self.postMessage({ type: 'ready' });
