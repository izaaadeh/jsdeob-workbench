/**
 * Shared helpers for transforms
 */

const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

// Parse options
const PARSE_OPTIONS = {
  sourceType: 'unambiguous',
  plugins: ['jsx', 'typescript', 'decorators-legacy']
};

/**
 * Helper to create a transform with metadata
 * The transform function receives (input, config, options)
 * - input: code string OR AST (if options.inputIsAST)
 * - config: user config
 * - options: { inputIsAST, returnAST }
 * 
 * Returns { code, stats } or { ast, stats } based on options.returnAST
 */
function createTransform(meta, transformFn) {
  // Wrap the transform to handle AST input/output
  const wrappedFn = async (input, config = {}, options = {}) => {
    const { inputIsAST = false, returnAST = false } = options;
    
    // Get AST from input
    let ast;
    if (inputIsAST && typeof input !== 'string') {
      ast = input;
    } else {
      ast = parseCode(typeof input === 'string' ? input : generateCode(input));
    }
    
    // Call original transform with AST
    // Transform should modify ast in place and return stats
    const result = await transformFn(ast, config);
    
    // Handle different return types from transform
    if (result && result.ast) {
      // Transform returned { ast, stats }
      ast = result.ast;
    } else if (result && result.code) {
      // Transform returned { code, stats } - re-parse if we need AST
      if (returnAST) {
        ast = parseCode(result.code);
      } else {
        return result; // Just pass through
      }
    }
    // else transform modified ast in-place
    
    // Return based on options
    if (returnAST) {
      return { ast, stats: result?.stats || {} };
    } else {
      return { code: generateCode(ast), stats: result?.stats || {} };
    }
  };
  
  wrappedFn.meta = meta;
  wrappedFn.__source = transformFn.toString();
  return wrappedFn;
}

/**
 * Create an AST-native transform (no re-parsing)
 * The transformFn receives (ast, config) and should return { ast, stats }
 */
function createASTTransform(meta, transformFn) {
  const wrappedFn = async (input, config = {}, options = {}) => {
    const { inputIsAST = false, returnAST = false } = options;
    
    // Parse if needed
    let ast = inputIsAST ? input : parseCode(input);
    
    // Run transform
    const stats = await transformFn(ast, config);
    
    // Return based on options
    if (returnAST) {
      return { ast, stats: stats || {} };
    } else {
      return { code: generateCode(ast), stats: stats || {} };
    }
  };
  
  wrappedFn.meta = meta;
  wrappedFn.__source = transformFn.toString();
  return wrappedFn;
}

// Parse helper
function parseCode(code) {
  return parser.parse(code, PARSE_OPTIONS);
}

// Generate helper - with stack overflow protection
function generateCode(ast) {
  try {
    return generate(ast, { comments: true, compact: false }).code;
  } catch (err) {
    if (err.message && err.message.includes('call stack')) {
      // Stack overflow on deeply nested code - try compact mode which may use less stack
      try {
        return generate(ast, { comments: false, compact: true, minified: true }).code;
      } catch (err2) {
        throw new Error('Code is too deeply nested to generate. Try simplifying transforms first (e.g., ConstantFolding, SimplifyLiterals).');
      }
    }
    throw err;
  }
}

/**
 * Smart input handler - accepts code string OR AST
 * Returns { ast, wasAst } so caller knows if they need to generate
 */
function ensureAST(input) {
  if (typeof input === 'string') {
    return { ast: parseCode(input), wasAst: false };
  }
  // Already an AST
  return { ast: input, wasAst: true };
}

/**
 * Smart output handler - returns code or AST based on options
 */
function formatOutput(ast, stats, options = {}) {
  if (options.returnAST) {
    return { ast, stats, code: null };
  }
  return { code: generateCode(ast), stats };
}

// Reserved words check
function isReservedWord(word) {
  const reserved = ['break', 'case', 'catch', 'continue', 'debugger', 'default', 
    'delete', 'do', 'else', 'finally', 'for', 'function', 'if', 'in', 
    'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try', 
    'typeof', 'var', 'void', 'while', 'with', 'class', 'const', 'enum',
    'export', 'extends', 'import', 'super', 'implements', 'interface',
    'let', 'package', 'private', 'protected', 'public', 'static', 'yield'];
  return reserved.includes(word);
}

module.exports = {
  createTransform,
  createASTTransform,
  parseCode,
  generateCode,
  ensureAST,
  formatOutput,
  isReservedWord,
  PARSE_OPTIONS
};
