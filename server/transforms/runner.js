/**
 * Transform Runner - Direct execution for maximum speed
 * Executes user-provided transforms against ASTs
 */

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

/**
 * Run a user-provided transform directly
 * @param {string|object} input - Code string OR AST
 * @param {string} transformCode - The user's transform code
 * @param {object} config - Configuration for the transform
 * @param {object} options - { inputIsAST, returnAST }
 * @returns {object} - { code, ast, stats, logs }
 */
async function runTransform(input, transformCode, config = {}, options = {}) {
  const { inputIsAST = false, returnAST = false } = options;
  
  // Parse if needed
  let ast;
  if (inputIsAST && typeof input !== 'string') {
    ast = input;
  } else {
    ast = parser.parse(input, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'decorators-legacy']
    });
  }
  
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
  
  // Execute transform directly
  try {
    // Mock module/exports for transforms that use module.exports pattern
    const module = { exports: {} };
    const exports = module.exports;
    
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
      if (module.exports.Identifier || module.exports.CallExpression || module.exports.enter || Object.keys(module.exports).some(k => /^[A-Z]/.test(k))) {
        smartTraverse(module.exports);
      }
    }
  } catch (error) {
    throw new Error(`Transform error: ${error.message}`);
  }
  
  return {
    code: returnAST ? null : generate(ast, { comments: true, compact: false }).code,
    ast,
    stats,
    logs,
    modified
  };
}

/**
 * Validate transform code syntax
 */
function validateTransform(transformCode) {
  try {
    parser.parse(transformCode, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript']
    });
    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Syntax error: ${error.message}` };
  }
}

module.exports = {
  runTransform,
  validateTransform
};
