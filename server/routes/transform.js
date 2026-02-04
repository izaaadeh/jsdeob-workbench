const express = require('express');
const router = express.Router();
const babel = require('@babel/core');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

// Import built-in transforms
const builtInTransforms = require('../transforms');

// Direct transform runner
const directRunner = require('../transforms/runner');

// Parse code to AST
router.post('/parse', async (req, res) => {
  try {
    const { code } = req.body;
    
    const ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'decorators-legacy']
    });
    res.json({ success: true, ast });
  } catch (error) {
    // Check for stack overflow
    if (error.message && error.message.includes('stack')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Stack overflow during parsing. The code is too deeply nested. For JSFuck-style code, try evaluating it in browser console first: copy the code, paste in console, and use the result.'
      });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// Generate code from AST
router.post('/generate', async (req, res) => {
  try {
    const { ast } = req.body;
    const output = generate(ast, { 
      comments: true,
      compact: false 
    });
    res.json({ success: true, code: output.code });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Run a single transform
router.post('/run', async (req, res) => {
  try {
    const { code, transform, config = {} } = req.body;
    const startTime = Date.now();
    
    let result;
    
    if (transform.type === 'builtin') {
      // Use built-in transform
      const transformFn = builtInTransforms[transform.id];
      if (!transformFn) {
        throw new Error(`Unknown built-in transform: ${transform.id}`);
      }
      result = await transformFn(code, config);
    } else if (transform.type === 'user' || transform.type === 'inline' || transform.type === 'script' || transform.type === 'example' || transform.type === 'plugin' || transform.type === 'folder') {
      // Run user/inline/script/example/plugin transform directly (no sandbox overhead)
      result = await directRunner.runTransform(code, transform.code, config);
    } else {
      throw new Error(`Unknown transform type: ${transform.type}`);
    }
    
    const duration = Date.now() - startTime;
    
    res.json({ 
      success: true, 
      code: result.code,
      stats: result.stats || {},
      logs: result.logs || [],
      duration
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message, stack: error.stack });
  }
});

// Run a recipe chain - OPTIMIZED: parse once, pass AST, generate once
router.post('/run-chain', async (req, res) => {
  try {
    const { code, recipe, stepMode = false } = req.body;
    const results = [];
    
    console.log('[run-chain] Starting with', recipe.length, 'transforms, code length:', code.length);
    
    // Check for extremely nested code that might cause stack overflow
    let maxNesting = 0;
    let currentNesting = 0;
    for (let i = 0; i < Math.min(code.length, 100000); i++) {
      const c = code[i];
      if (c === '[' || c === '(' || c === '{') {
        currentNesting++;
        if (currentNesting > maxNesting) maxNesting = currentNesting;
      } else if (c === ']' || c === ')' || c === '}') {
        currentNesting--;
      }
    }
    
    if (maxNesting > 500) {
      return res.status(400).json({ 
        success: false, 
        error: `Code has very deep nesting (${maxNesting} levels). This may cause stack overflow. The code might be JSFuck or similar - try eval() in browser console first.`
      });
    }
    
    // Parse once at the beginning
    let currentAST = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'decorators-legacy']
    });
    let currentCode = code;
    let needsReparse = false;
    
    for (let i = 0; i < recipe.length; i++) {
      const transform = recipe[i];
      
      console.log(`[run-chain] Transform ${i + 1}/${recipe.length}: ${transform.id} (${transform.type})`);
      
      if (!transform.enabled) {
        results.push({ index: i, transform: transform.id, skipped: true });
        continue;
      }
      
      const startTime = Date.now();
      
      try {
        let result;
        let resultCode;
        
        if (transform.type === 'builtin') {
          const transformFn = builtInTransforms[transform.id];
          if (!transformFn) {
            throw new Error(`Unknown built-in transform: ${transform.id}`);
          }
          
          if (needsReparse) {
            currentAST = parser.parse(currentCode, {
              sourceType: 'unambiguous',
              plugins: ['jsx', 'typescript', 'decorators-legacy']
            });
            needsReparse = false;
          }
          
          result = await transformFn(currentAST, transform.config || {}, { inputIsAST: true, returnAST: true });
          
          if (result.ast) {
            currentAST = result.ast;
            resultCode = null;
          } else {
            currentCode = result.code;
            needsReparse = true;
            resultCode = result.code;
          }
        } else if (transform.type === 'user' || transform.type === 'inline' || transform.type === 'example' || transform.type === 'script' || transform.type === 'plugin' || transform.type === 'folder') {
          const isLast = i === recipe.length - 1;
          
          // Run transform directly (no sandbox overhead)
          result = await directRunner.runTransform(
            needsReparse ? currentCode : currentAST,
            transform.code,
            transform.config || {},
            { inputIsAST: !needsReparse, returnAST: !isLast }
          );
          
          if (result.ast && !isLast) {
            currentAST = result.ast;
            needsReparse = false;
            resultCode = null;
          } else {
            currentCode = result.code;
            needsReparse = true;
            resultCode = result.code;
          }
        }
        
        const duration = Date.now() - startTime;
        const isLast = i === recipe.length - 1 || stepMode;
        
        if (isLast && !resultCode && !needsReparse) {
          resultCode = generate(currentAST, { comments: true, compact: false }).code;
          currentCode = resultCode;
        }
        
        // Calculate code size for chart - generate temporarily if needed
        let codeSize = 0;
        if (resultCode) {
          codeSize = resultCode.length;
        } else if (!needsReparse && currentAST) {
          // Generate temporarily just to measure size
          try {
            const tempCode = generate(currentAST, { comments: true, compact: false }).code;
            codeSize = tempCode.length;
          } catch (e) {
            codeSize = 0;
          }
        } else if (currentCode) {
          codeSize = currentCode.length;
        }
        
        results.push({
          index: i,
          transform: transform.id,
          success: true,
          code: resultCode || '[AST]',
          codeSize: codeSize,
          stats: result.stats || {},
          logs: result.logs || [],
          duration
        });
        
        if (stepMode) {
          if (!resultCode && !needsReparse) {
            currentCode = generate(currentAST, { comments: true, compact: false }).code;
          }
          return res.json({
            success: true,
            stepIndex: i,
            results,
            currentCode,
            complete: i === recipe.length - 1
          });
        }
      } catch (err) {
        if (!needsReparse && currentAST) {
          try {
            currentCode = generate(currentAST, { comments: true, compact: false }).code;
          } catch (e) {}
        }
        
        results.push({
          index: i,
          transform: transform.id,
          success: false,
          error: err.message
        });
        
        return res.json({
          success: false,
          failedAt: i,
          results,
          currentCode,
          error: err.message
        });
      }
    }
    
    // Final generation
    if (!needsReparse && currentAST) {
      currentCode = generate(currentAST, { comments: true, compact: false }).code;
    }
    
    console.log('[run-chain] Complete! Final code length:', currentCode.length);
    
    res.json({
      success: true,
      results,
      finalCode: currentCode
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Format/prettify code
router.post('/format', async (req, res) => {
  try {
    const { code } = req.body;
    // Parse with Babel and regenerate for consistent AST-based formatting
    const ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'decorators-legacy']
    });
    const output = generate(ast, {
      comments: true,
      compact: false
    });
    res.json({ success: true, code: output.code });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get scope analysis
router.post('/analyze-scope', async (req, res) => {
  try {
    const { code } = req.body;
    const ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript']
    });
    
    const scopes = [];
    const seenScopes = new Set();
    
    // Helper to extract bindings from a scope
    const extractBindings = (scope) => {
      const bindings = {};
      for (const [name, binding] of Object.entries(scope.bindings)) {
        bindings[name] = {
          kind: binding.kind,
          references: binding.referencePaths.map(ref => ({
            line: ref.node.loc?.start.line,
            column: ref.node.loc?.start.column
          })),
          constant: binding.constant,
          loc: binding.identifier.loc
        };
      }
      return bindings;
    };
    
    traverse(ast, {
      // Capture Program scope first
      Program(path) {
        const scope = path.scope;
        if (!seenScopes.has(scope)) {
          seenScopes.add(scope);
          scopes.push({
            type: 'Program',
            bindings: extractBindings(scope),
            loc: path.node.loc
          });
        }
      },
      // Capture all other scopes
      Scope(path) {
        // Skip Program (already handled)
        if (path.isProgram()) return;
        
        const scope = path.scope;
        if (seenScopes.has(scope)) return;
        seenScopes.add(scope);
        
        scopes.push({
          type: path.type,
          bindings: extractBindings(scope),
          loc: path.node.loc
        });
      }
    });
    
    res.json({ success: true, scopes });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// List available built-in transforms
router.get('/builtins', (req, res) => {
  const transforms = Object.keys(builtInTransforms)
    .filter(id => !id.startsWith('__')) // Skip internal properties like __filePaths, __reload
    .map(id => ({
      id,
      ...builtInTransforms[id].meta,
      // Include example code for each transform
      exampleCode: getBuiltinExampleCode(id)
    }));
  res.json({ success: true, transforms });
});

// Get source code of a built-in transform
router.get('/builtin-source/:id', (req, res) => {
  const { id } = req.params;
  const transformFn = builtInTransforms[id];
  
  if (!transformFn) {
    return res.status(404).json({ success: false, error: 'Transform not found' });
  }
  
  const meta = transformFn.meta || {};
  // Use stored __source (the real transform function) if available
  const sourceCode = transformFn.__source || transformFn.toString();
  
  res.json({ 
    success: true, 
    id,
    name: meta.name,
    source: sourceCode
  });
});

// Example code snippets for built-in transforms (for viewing/editing in UI)
function getBuiltinExampleCode(id) {
  const examples = {
    constantFolding: `// Constant Folding - Evaluates constant expressions
traverse({
  BinaryExpression(path) {
    const { left, right, operator } = path.node;
    
    if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
      let result;
      switch (operator) {
        case '+': result = left.value + right.value; break;
        case '-': result = left.value - right.value; break;
        case '*': result = left.value * right.value; break;
        case '/': result = left.value / right.value; break;
        default: return;
      }
      if (Number.isFinite(result)) {
        path.replaceWith(t.numericLiteral(result));
      }
    }
  }
});`,

    deadCodeRemoval: `// Dead Code Removal - Removes unreachable code
traverse({
  IfStatement(path) {
    const test = path.node.test;
    if (t.isBooleanLiteral(test)) {
      if (test.value) {
        path.replaceWith(path.node.consequent);
      } else if (path.node.alternate) {
        path.replaceWith(path.node.alternate);
      } else {
        path.remove();
      }
    }
  },
  ConditionalExpression(path) {
    const test = path.node.test;
    if (t.isBooleanLiteral(test)) {
      path.replaceWith(test.value ? path.node.consequent : path.node.alternate);
    }
  }
});`,

    unusedVariableRemoval: `// Unused Variable Removal
traverse({
  VariableDeclarator(path) {
    const name = path.node.id.name;
    const binding = path.scope.getBinding(name);
    
    if (binding && binding.referencePaths.length === 0) {
      const init = path.node.init;
      // Only remove if initializer is safe (no side effects)
      if (!init || t.isLiteral(init) || t.isIdentifier(init) ||
          t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        path.remove();
      }
    }
  }
});`,

    normalizeNumbers: `// Normalize Numbers - Converts hex/octal/binary to decimal
traverse({
  NumericLiteral(path) {
    const extra = path.node.extra;
    if (extra && extra.raw && extra.raw !== String(path.node.value)) {
      delete path.node.extra;
    }
  }
});`,

    stringDecoder: `// String Decoder - Decodes hex/unicode escape sequences
traverse({
  StringLiteral(path) {
    const raw = path.node.extra?.raw;
    if (raw && (raw.includes('\\\\x') || raw.includes('\\\\u'))) {
      // The value is already decoded, just remove extra to regenerate clean
      delete path.node.extra;
    }
  }
});`,

    computedToStatic: `// Computed to Static - obj["prop"] → obj.prop
traverse({
  MemberExpression(path) {
    if (path.node.computed && t.isStringLiteral(path.node.property)) {
      const propName = path.node.property.value;
      // Valid identifier check
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName)) {
        path.node.computed = false;
        path.node.property = t.identifier(propName);
      }
    }
  }
});`,

    inlineSimpleVars: `// Inline Simple Variables - Inlines variables used only once
traverse({
  VariableDeclarator(path) {
    const name = path.node.id.name;
    const init = path.node.init;
    const binding = path.scope.getBinding(name);
    
    if (binding && binding.referencePaths.length === 1 && 
        (t.isLiteral(init) || t.isIdentifier(init))) {
      binding.referencePaths[0].replaceWith(init);
      path.remove();
    }
  }
});`,

    sequenceUnwrap: `// Sequence Unwrap - Expands comma expressions to statements
traverse({
  ExpressionStatement(path) {
    if (t.isSequenceExpression(path.node.expression)) {
      const statements = path.node.expression.expressions.map(expr =>
        t.expressionStatement(expr)
      );
      path.replaceWithMultiple(statements);
    }
  }
});`,

    booleanSimplify: `// Boolean Simplify - !0 → true, !1 → false
traverse({
  UnaryExpression(path) {
    if (path.node.operator === '!' && t.isNumericLiteral(path.node.argument)) {
      const value = path.node.argument.value;
      path.replaceWith(t.booleanLiteral(!value));
    }
  }
});`,

    voidToUndefined: `// Void to Undefined - void 0 → undefined
traverse({
  UnaryExpression(path) {
    if (path.node.operator === 'void' && t.isNumericLiteral(path.node.argument)) {
      path.replaceWith(t.identifier('undefined'));
    }
  }
});`,

    removePureIifes: `// Remove Pure IIFEs - Removes side-effect-free IIFEs
traverse({
  ExpressionStatement(path) {
    const expr = path.node.expression;
    
    // Check for (function(){...})() pattern
    if (t.isCallExpression(expr) && expr.arguments.length === 0) {
      const fn = expr.callee;
      
      if (t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) {
        // Check if body is pure (only returns, literals, etc.)
        const body = fn.body;
        if (t.isBlockStatement(body)) {
          const isPure = body.body.every(stmt => 
            t.isReturnStatement(stmt) || t.isEmptyStatement(stmt)
          );
          if (isPure) {
            path.remove();
          }
        }
      }
    }
  }
});`,

    stringArrayRestore: `// String Array Restore - Replaces array lookups with strings
// This is a complex transform - see documentation for full implementation
traverse({
  CallExpression(path) {
    // Look for patterns like _0x1234(index) or _0x1234[index]
    // that reference a string array, then replace with actual string
  }
});`,

    controlFlowFlatten: `// Control Flow Flatten - Unflattens switch-based obfuscation
// This is a complex transform - see documentation for full implementation
traverse({
  WhileStatement(path) {
    // Look for while(true) with switch inside
    // Analyze state variable and reorder blocks
  }
});`,

    evalUnpack: `// Eval Unpack - Unpacks eval() calls
// WARNING: Only use on trusted code
traverse({
  CallExpression(path) {
    if (t.isIdentifier(path.node.callee, { name: 'eval' })) {
      const arg = path.node.arguments[0];
      if (t.isStringLiteral(arg)) {
        // Replace eval("code") with the parsed code
        const innerCode = arg.value;
        // Parse and insert the inner code
      }
    }
  }
});`,

    renameVariables: `// Rename Variables - Renames obfuscated variable names
let counter = 0;
traverse({
  Scope(path) {
    for (const [name, binding] of Object.entries(path.scope.bindings)) {
      // Check if name looks obfuscated (hex pattern)
      if (/^_0x[a-f0-9]+$/i.test(name)) {
        const newName = 'var' + counter++;
        path.scope.rename(name, newName);
      }
    }
  }
});`,

    unminify: `// Unminify - Formats code with Babel generator
// Uses compact: false for readable output
return generate(ast, {
  comments: true,
  compact: false,
  concise: false,
  retainLines: false
}).code;`,

    removeComments: `// Remove Comments - Removes all comments from the code
traverse({
  enter(path) {
    if (path.node.leadingComments) {
      path.node.leadingComments = [];
    }
    if (path.node.trailingComments) {
      path.node.trailingComments = [];
    }
    if (path.node.innerComments) {
      path.node.innerComments = [];
    }
  }
});`
  };
  
  return examples[id] || `// ${id} transform\\n// No example code available`;
}

module.exports = router;
