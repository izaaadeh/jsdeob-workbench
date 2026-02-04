
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'RemoveIIFE',
    description: 'Unwraps IIFEs (Immediately Invoked Function Expressions)',
    category: 'Deobfuscation',
    config: {
      removeNoArgs: { type: 'boolean', default: true, description: 'Remove IIFEs with no arguments' },
      removeWithArgs: { type: 'boolean', default: true, description: 'Remove IIFEs with arguments (with safety checks)' },
      preserveThis: { type: 'boolean', default: true, description: 'Preserve IIFEs that use "this" binding' },
      preserveArguments: { type: 'boolean', default: true, description: 'Preserve IIFEs that use "arguments" object' },
      preserveReturn: { type: 'boolean', default: true, description: 'Preserve IIFEs whose return value is used' },
      unwrapSingleStatement: { type: 'boolean', default: true, description: 'Unwrap even if body has single statement' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Remove IIFE Transform
     * Unwraps Immediately Invoked Function Expressions
     * (function() { ... })() → ...
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * 20 TEST CASES
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     * WILL UNWRAP (✓):
     * 
     *   1.  (function(){})();                           → (removed)
     *   2.  (function(){ a(); })();                     → a();
     *   3.  (function(){ return; })();                  → (removed)
     *   4.  (function(){ a(); return; })();             → a();
     *   5.  (function(){ return true; })();             → (removed, literal ignored)
     *   6.  (function(){ a(); return true; })();        → a();
     *   7.  (function(){ return foo(); })();            → foo(); (side effect kept)
     *   8.  (function(){ a(); return foo(); })();       → a(); foo();
     *   9.  (() => { a(); })();                         → a();
     *   10. (() => expr)();                             → expr;
     *   11. (function(){ let x=1; const y=2; })();      → let x=1; const y=2;
     *   12. (function(a,b){ log(a+b); })(1,2);          → log(1+2);
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     * WILL PRESERVE (✗):
     * 
     *   13. (function(){ if(x) return; a(); })();       → KEPT (early return)
     *   14. (function(){ if(x) return y; a(); })();     → KEPT (early return)
     *   15. (function(){ for(...){ return; } })();      → KEPT (return in loop)
     *   16. (function(){ if(x){return a;}else{return b;} })(); → KEPT (multiple returns)
     *   17. var x = (function(){ return 1; })();        → KEPT (value used)
     *   18. log((function(){ return 1; })());           → KEPT (value used)
     *   19. (function(){ console.log(this); })();       → KEPT (uses this)
     *   20. (function(){ log(arguments[0]); })(1);      → KEPT (uses arguments)
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - removeNoArgs: true      → Set false to keep zero-arg IIFEs
     *   - removeWithArgs: true    → Set false to only remove zero-arg IIFEs
     *   - preserveThis: true      → Set false to remove even if uses `this`
     *   - preserveArguments: true → Set false to remove even if uses `arguments`
     *   - preserveReturn: true    → Set false to remove even if return value used
     * ═══════════════════════════════════════════════════════════════════════════════
     */

    const opts = {
      removeNoArgs: config.removeNoArgs !== false,
      removeWithArgs: config.removeWithArgs !== false,
      preserveThis: config.preserveThis !== false,
      preserveArguments: config.preserveArguments !== false,
      preserveReturn: config.preserveReturn !== false,
      unwrapSingleStatement: config.unwrapSingleStatement !== false
    };

    const stats = {
      iifeNoArgsRemoved: 0,
      iifeWithArgsRemoved: 0,
      iifePreserved: 0,
      totalRemoved: 0
    };

    /**
     * Check if a function body uses 'this'
     */
    function usesThis(funcPath) {
      let found = false;
      funcPath.traverse({
        ThisExpression(path) {
          // Make sure we're not inside a nested function that has its own 'this'
          const parentFunc = path.findParent(p => t.isFunction(p.node) && p.node !== funcPath.node);
          if (!parentFunc) {
            found = true;
            path.stop();
          }
        },
        // Arrow functions don't have their own 'this', so check those too
        ArrowFunctionExpression(path) {
          path.skip(); // Don't traverse into arrow functions for 'this'
        }
      });
      return found;
    }

    /**
     * Check if a function body uses 'arguments'
     */
    function usesArguments(funcPath) {
      let found = false;
      funcPath.traverse({
        Identifier(path) {
          if (path.node.name === 'arguments') {
            // Make sure it's the arguments object, not a variable named 'arguments'
            const binding = path.scope.getBinding('arguments');
            if (!binding) {
              // Make sure we're not inside a nested function
              const parentFunc = path.findParent(p => t.isFunction(p.node) && !t.isArrowFunctionExpression(p.node) && p.node !== funcPath.node);
              if (!parentFunc) {
                found = true;
                path.stop();
              }
            }
          }
        }
      });
      return found;
    }

    /**
     * Check if the IIFE's return value is used
     */
    function returnValueUsed(callPath) {
      const parent = callPath.parentPath;
      
      // Expression statement - return value not used
      if (t.isExpressionStatement(parent.node)) {
        return false;
      }
      
      // Sequence expression where IIFE is not the last - return value not used
      if (t.isSequenceExpression(parent.node)) {
        const exprs = parent.node.expressions;
        const idx = exprs.indexOf(callPath.node);
        if (idx !== exprs.length - 1) {
          return false;
        }
      }
      
      // Otherwise, return value is likely used
      return true;
    }

    /**
     * Check if function body has any return statements with values
     */
    function hasReturnValue(funcPath) {
      let found = false;
      funcPath.traverse({
        ReturnStatement(path) {
          if (path.node.argument) {
            // Make sure it's not inside a nested function
            const parentFunc = path.findParent(p => t.isFunction(p.node) && p.node !== funcPath.node);
            if (!parentFunc) {
              found = true;
              path.stop();
            }
          }
        },
        Function(path) {
          path.skip(); // Don't traverse into nested functions
        }
      });
      return found;
    }

    /**
     * Analyze returns in function to determine if IIFE can be safely unwrapped
     * Returns: { canUnwrap: boolean, statements: Statement[] }
     * 
     * TEST CASES:
     * 1.  (function(){})()                              → canUnwrap: true, []
     * 2.  (function(){ a(); })()                        → canUnwrap: true, [a()]
     * 3.  (function(){ return; })()                     → canUnwrap: true, []
     * 4.  (function(){ a(); return; })()                → canUnwrap: true, [a()]
     * 5.  (function(){ return true; })()                → canUnwrap: true, []
     * 6.  (function(){ a(); return true; })()           → canUnwrap: true, [a()]
     * 7.  (function(){ return foo(); })()               → canUnwrap: true, [foo()]
     * 8.  (function(){ a(); return foo(); })()          → canUnwrap: true, [a(), foo()]
     * 9.  (function(){ if(x) return; a(); })()          → canUnwrap: false (early return)
     * 10. (function(){ if(x) return y; a(); })()        → canUnwrap: false (early return)
     * 11. (function(){ for(...) { return; } })()        → canUnwrap: false (return in loop)
     * 12. (function(){ if(x){return a;}else{return b;} })() → canUnwrap: false (multiple returns)
     * 13. (function(){ return a; return b; })()         → canUnwrap: false (multiple returns)
     * 14. var x = (function(){ return 1; })()           → canUnwrap: false (value used)
     * 15. (function(){ (function(){ return; })(); })()  → canUnwrap: true (nested return ok)
     * 16. (function(){ a(); b(); c(); })()              → canUnwrap: true, [a(), b(), c()]
     * 17. (() => { a(); })()                            → canUnwrap: true, [a()]
     * 18. (() => expr)()                                → canUnwrap: true (handled separately)
     * 19. (function(){ let x=1; })()                    → canUnwrap: true, [let x=1]
     * 20. (function(a){ return a; })(1)                 → with args, canUnwrap: true, []
     */
    function analyzeReturns(funcNode) {
      const body = funcNode.body;
      
      // Arrow function with expression body - no returns to analyze
      if (!t.isBlockStatement(body)) {
        return { canUnwrap: true, statements: [t.expressionStatement(body)] };
      }
      
      const statements = body.body;
      
      // Collect all returns in the function (excluding nested functions)
      const returns = [];
      const returnParents = new Set();
      
      // Use a simple recursive walk (not traverse) to find returns
      function findReturns(node, parent) {
        if (!node || typeof node !== 'object') return;
        
        // Skip nested functions
        if (t.isFunction(node) && node !== funcNode) return;
        
        if (t.isReturnStatement(node)) {
          returns.push({ node, parent });
          returnParents.add(parent);
        }
        
        // Traverse children
        for (const key of Object.keys(node)) {
          if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
          const child = node[key];
          if (Array.isArray(child)) {
            child.forEach(c => findReturns(c, node));
          } else if (child && typeof child === 'object' && child.type) {
            findReturns(child, node);
          }
        }
      }
      
      findReturns(funcNode.body, funcNode);
      
      // No returns - can safely unwrap with all statements
      if (returns.length === 0) {
        return { canUnwrap: true, statements: [...statements] };
      }
      
      // Multiple returns - can't safely unwrap
      if (returns.length > 1) {
        return { canUnwrap: false, reason: 'multiple returns' };
      }
      
      // Single return - check if it's the last top-level statement
      const singleReturn = returns[0];
      const lastStatement = statements[statements.length - 1];
      
      // Return must be the last top-level statement
      if (singleReturn.node !== lastStatement) {
        return { canUnwrap: false, reason: 'return not at end' };
      }
      
      // Return is the last statement - we can handle this
      // Copy all statements except the last (which is return)
      const cleanedStatements = statements.slice(0, -1);
      
      // Handle the return value
      const returnArg = singleReturn.node.argument;
      if (returnArg) {
        // Return has a value - check if it has side effects
        // Only keep if it might have side effects
        if (!t.isLiteral(returnArg) && 
            !t.isIdentifier(returnArg) &&
            !(t.isUnaryExpression(returnArg) && t.isLiteral(returnArg.argument))) {
          // Has potential side effects, keep as expression statement
          cleanedStatements.push(t.expressionStatement(returnArg));
        }
        // Otherwise, literal/identifier returns are dropped (no side effects)
      }
      // Return without value (return;) is just dropped
      
      return { canUnwrap: true, statements: cleanedStatements };
    }

    /**
     * Check if we can safely inline arguments
     */
    function canInlineArgs(params, args, funcPath) {
      // Each param must be a simple identifier
      for (const param of params) {
        if (!t.isIdentifier(param)) {
          return false; // Destructuring, rest params etc.
        }
      }
      
      // Check for parameter shadowing issues
      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        const arg = args[i];
        
        if (!arg) continue; // undefined argument
        
        // Check if arg references variables that might be shadowed
        if (t.isIdentifier(arg)) {
          const argName = arg.name;
          // Check if this name is also a parameter (shadowing)
          if (params.some((p, j) => j !== i && t.isIdentifier(p) && p.name === argName)) {
            return false;
          }
        }
      }
      
      return true;
    }

    /**
     * Replace parameter references with argument values
     */
    function inlineArguments(bodyStatements, params, args, scope) {
      // Build replacement map
      const replacements = new Map();
      
      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        if (t.isIdentifier(param)) {
          const arg = args[i];
          if (arg) {
            replacements.set(param.name, arg);
          } else {
            // Undefined argument
            replacements.set(param.name, t.identifier('undefined'));
          }
        }
      }
      
      // Create a temporary block to traverse
      const tempBlock = t.blockStatement(bodyStatements);
      
      traverse(tempBlock, {
        Identifier(path) {
          const name = path.node.name;
          if (replacements.has(name)) {
            // Check if this is a reference (not a declaration or property)
            if (path.isReferencedIdentifier()) {
              // Check if there's a local binding that shadows
              const binding = path.scope.getBinding(name);
              if (!binding || binding.scope === path.scope) {
                // This might be our parameter - check parent scope
                const parentBinding = path.scope.parent?.getBinding(name);
                if (!parentBinding) {
                  path.replaceWith(t.cloneNode(replacements.get(name)));
                }
              }
            }
          }
        },
        // Don't traverse into nested scopes that redeclare the params
        Scope(path) {
          for (const [name] of replacements) {
            if (path.scope.hasOwnBinding(name)) {
              path.skip();
              return;
            }
          }
        }
      }, null, { scope });
      
      return tempBlock.body;
    }

    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const args = path.node.arguments;
        
        // Check for IIFE pattern: (function() {})() or (function() {}).call(this)
        let funcExpr = null;
        let isCallMethod = false;
        
        if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
          funcExpr = callee;
        } else if (t.isParenthesizedExpression(callee) && 
                   (t.isFunctionExpression(callee.expression) || t.isArrowFunctionExpression(callee.expression))) {
          funcExpr = callee.expression;
        } else if (t.isMemberExpression(callee) && 
                   t.isIdentifier(callee.property) && 
                   callee.property.name === 'call') {
          // (function(){}).call(this)
          const obj = callee.object;
          if (t.isFunctionExpression(obj) || t.isArrowFunctionExpression(obj)) {
            funcExpr = obj;
            isCallMethod = true;
          } else if (t.isParenthesizedExpression(obj) &&
                     (t.isFunctionExpression(obj.expression) || t.isArrowFunctionExpression(obj.expression))) {
            funcExpr = obj.expression;
            isCallMethod = true;
          }
        }
        
        if (!funcExpr) return;
        
        // Get function parameters and body
        const params = funcExpr.params;
        const body = funcExpr.body;
        
        // Arrow functions with expression body: () => expr
        if (!t.isBlockStatement(body)) {
          // Simple arrow function returning expression
          if (params.length === 0 && args.length === 0 && opts.removeNoArgs) {
            path.replaceWith(body);
            stats.iifeNoArgsRemoved++;
            stats.totalRemoved++;
          }
          return;
        }
        
        const funcPath = path.get('callee');
        if (t.isParenthesizedExpression(callee)) {
          // funcPath is the parenthesized expression, get inner
        }
        
        // Safety checks
        if (opts.preserveThis && usesThis(path.get(t.isParenthesizedExpression(callee) ? 'callee.expression' : 'callee'))) {
          stats.iifePreserved++;
          return;
        }
        
        if (opts.preserveArguments && usesArguments(path.get(t.isParenthesizedExpression(callee) ? 'callee.expression' : 'callee'))) {
          stats.iifePreserved++;
          return;
        }
        
        if (opts.preserveReturn && returnValueUsed(path)) {
          if (hasReturnValue(path.get(t.isParenthesizedExpression(callee) ? 'callee.expression' : 'callee'))) {
            stats.iifePreserved++;
            return;
          }
        }
        
        const effectiveArgs = isCallMethod ? args.slice(1) : args; // .call(this, arg1, arg2) -> args are [this, arg1, arg2]
        
        // Analyze returns to see if we can safely unwrap
        const analysis = analyzeReturns(funcExpr);
        
        if (!analysis.canUnwrap) {
          stats.iifePreserved++;
          return;
        }
        
        // No arguments case
        if (params.length === 0 && effectiveArgs.length === 0) {
          if (!opts.removeNoArgs) {
            stats.iifePreserved++;
            return;
          }
          
          const cleanedStatements = analysis.statements;
          
          if (cleanedStatements.length === 0) {
            // Empty IIFE, remove entirely
            if (t.isExpressionStatement(path.parentPath.node)) {
              path.parentPath.remove();
            } else {
              path.replaceWith(t.identifier('undefined'));
            }
          } else if (t.isExpressionStatement(path.parentPath.node)) {
            // Replace expression statement with body statements
            path.parentPath.replaceWithMultiple(cleanedStatements);
          } else {
            // IIFE value might be used, wrap in sequence or keep
            stats.iifePreserved++;
            return;
          }
          
          stats.iifeNoArgsRemoved++;
          stats.totalRemoved++;
          return;
        }
        
        // With arguments case
        if (!opts.removeWithArgs) {
          stats.iifePreserved++;
          return;
        }
        
        // Check if we can safely inline
        if (!canInlineArgs(params, effectiveArgs, path)) {
          stats.iifePreserved++;
          return;
        }
        
        let cleanedStatements = analysis.statements;
        
        if (cleanedStatements.length === 0) {
          if (t.isExpressionStatement(path.parentPath.node)) {
            path.parentPath.remove();
          } else {
            path.replaceWith(t.identifier('undefined'));
          }
          stats.iifeWithArgsRemoved++;
          stats.totalRemoved++;
          return;
        }
        
        // Inline the arguments
        cleanedStatements = inlineArguments(cleanedStatements, params, effectiveArgs, path.scope);
        
        if (t.isExpressionStatement(path.parentPath.node)) {
          path.parentPath.replaceWithMultiple(cleanedStatements);
          stats.iifeWithArgsRemoved++;
          stats.totalRemoved++;
        } else {
          // Can't unwrap if value is used
          stats.iifePreserved++;
        }
      }
    });

    return { stats };
  }
);
