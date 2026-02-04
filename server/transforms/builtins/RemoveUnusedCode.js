

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'RemoveUnusedCode',
    description: 'Removes unused variables, functions, and classes with 0 references',
    category: 'Cleanup',
    config: {
      removeVariables: { type: 'boolean', default: true, description: 'Remove unused variables (var, let, const)' },
      removeFunctions: { type: 'boolean', default: true, description: 'Remove unused function declarations' },
      removeClasses: { type: 'boolean', default: true, description: 'Remove unused class declarations' },
      removeParams: { type: 'boolean', default: false, description: 'Remove unused function parameters (can break code)' },
      removeImports: { type: 'boolean', default: true, description: 'Remove unused imports' },
      preservePatterns: { type: 'string', default: '', description: 'Regex pattern for names to preserve (e.g., "^_|^on[A-Z]")' },
      preserveExports: { type: 'boolean', default: true, description: 'Preserve exported items even if unused locally' },
      maxPasses: { type: 'number', default: 10, description: 'Max removal passes (removing one may make others unused)' },
      removeSideEffectFree: { type: 'boolean', default: true, description: 'Only remove if initializer has no side effects' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Remove Unused Code Transform
     * Removes variables, functions, and classes that have no references
     * Uses Babel's scope analysis to detect unused bindings
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT REMOVES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Unused variables:
     *     var unused = "never used";        // Removed
     *     var used = "hello";               // Kept (referenced below)
     *     console.log(used);
     * 
     *   Unused functions:
     *     function deadFunc() { ... }       // Removed (never called)
     *     function liveFunc() { ... }       // Kept (called below)
     *     liveFunc();
     * 
     *   Unused classes:
     *     class DeadClass { }               // Removed (never instantiated)
     *     class LiveClass { }               // Kept (used below)
     *     new LiveClass();
     * 
     *   Unused imports:
     *     import { unused } from 'mod';     // Removed
     *     import { used } from 'mod';       // Kept
     *     console.log(used);
     * 
     *   Multi-pass removal (removing one makes others unused):
     *     var helper = 42;                  // Removed (pass 2)
     *     var unused = helper + 1;          // Removed (pass 1)
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WILL NOT REMOVE:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   - Variables with side effects: var x = doSomething();
     *   - Exported items (if preserveExports: true)
     *   - Names matching preservePatterns regex
     *   - Side-effect imports: import 'polyfill';
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - removeVariables: true     → Remove unused var/let/const
     *   - removeFunctions: true     → Remove unused function declarations
     *   - removeClasses: true       → Remove unused class declarations
     *   - removeParams: false       → Remove trailing unused params (risky)
     *   - removeImports: true       → Remove unused imports
     *   - preserveExports: true     → Keep exported items
     *   - preservePatterns: ""      → Regex for names to keep (e.g., "^_")
     *   - maxPasses: 10             → Max removal passes
     *   - removeSideEffectFree: true→ Only remove if no side effects
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    const opts = {
      removeVariables: config.removeVariables !== false,
      removeFunctions: config.removeFunctions !== false,
      removeClasses: config.removeClasses !== false,
      removeParams: config.removeParams === true,
      removeImports: config.removeImports !== false,
      preservePatterns: config.preservePatterns || '',
      preserveExports: config.preserveExports !== false,
      maxPasses: config.maxPasses || 10,
      removeSideEffectFree: config.removeSideEffectFree !== false
    };

    const stats = {
      variablesRemoved: 0,
      functionsRemoved: 0,
      classesRemoved: 0,
      paramsRemoved: 0,
      importsRemoved: 0,
      totalRemoved: 0,
      passes: 0
    };

    // Build preserve pattern regex
    let preserveRegex = null;
    if (opts.preservePatterns) {
      try {
        preserveRegex = new RegExp(opts.preservePatterns);
      } catch (e) {
        // Invalid regex, ignore
      }
    }

    /**
     * Check if a name should be preserved
     */
    function shouldPreserve(name) {
      if (!name) return false;
      if (preserveRegex && preserveRegex.test(name)) return true;
      return false;
    }

    /**
     * Check if an expression has side effects
     */
    function hasSideEffects(node) {
      if (!node) return false;
      
      // Literals are safe
      if (t.isLiteral(node)) return false;
      
      // Identifiers are safe (just references)
      if (t.isIdentifier(node)) return false;
      
      // Array/object expressions - check elements
      if (t.isArrayExpression(node)) {
        return node.elements.some(el => el && hasSideEffects(el));
      }
      if (t.isObjectExpression(node)) {
        return node.properties.some(prop => {
          if (t.isSpreadElement(prop)) return hasSideEffects(prop.argument);
          if (t.isObjectProperty(prop)) return hasSideEffects(prop.value);
          return true; // Methods have effects
        });
      }
      
      // Arrow/function expressions are safe (not called)
      if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
        return false;
      }
      
      // Class expressions are generally safe
      if (t.isClassExpression(node)) return false;
      
      // Binary/unary on literals are safe
      if (t.isBinaryExpression(node)) {
        return hasSideEffects(node.left) || hasSideEffects(node.right);
      }
      if (t.isUnaryExpression(node) && node.operator !== 'delete') {
        return hasSideEffects(node.argument);
      }
      
      // Logical expressions
      if (t.isLogicalExpression(node)) {
        return hasSideEffects(node.left) || hasSideEffects(node.right);
      }
      
      // Conditional expression
      if (t.isConditionalExpression(node)) {
        return hasSideEffects(node.test) || 
               hasSideEffects(node.consequent) || 
               hasSideEffects(node.alternate);
      }
      
      // Template literals without expressions are safe
      if (t.isTemplateLiteral(node)) {
        return node.expressions.some(e => hasSideEffects(e));
      }

      // Member expressions are safe unless computed with side effects
      if (t.isMemberExpression(node)) {
        return hasSideEffects(node.object) || 
               (node.computed && hasSideEffects(node.property));
      }
      
      // Call expressions, new expressions, assignments etc. have side effects
      return true;
    }

    /**
     * Check if a binding is from an export
     */
    function isExported(binding) {
      if (!binding || !binding.path) return false;
      
      const path = binding.path;
      
      // Check if parent is export
      if (path.parentPath) {
        if (t.isExportNamedDeclaration(path.parentPath.node)) return true;
        if (t.isExportDefaultDeclaration(path.parentPath.node)) return true;
      }
      
      // Check for export { name } elsewhere in file
      // This would require more complex analysis, skip for now
      
      return false;
    }

    /**
     * Perform one pass of dead code removal
     */
    function removePass() {
      let removed = 0;
      
      // First, do a scope-building traversal to ensure all bindings are registered
      // This is necessary because previous transforms may have added nodes
      // that aren't in the scope system yet
      traverse(ast, {
        Program(path) {
          path.scope.crawl(); // Rebuild scope bindings
        }
      });
      
      traverse(ast, {
        // Handle variable declarations
        VariableDeclarator(path) {
          if (!opts.removeVariables) return;
          
          const id = path.node.id;
          if (!t.isIdentifier(id)) return; // Skip destructuring for now
          
          const name = id.name;
          if (shouldPreserve(name)) return;
          
          const binding = path.scope.getBinding(name);
          if (!binding) return;
          
          // Check if exported
          if (opts.preserveExports && isExported(binding)) return;
          
          // Check reference count (subtract 1 for the declaration itself if counted)
          const refs = binding.referencePaths.length;
          if (refs > 0) return; // Still has references
          
          // Check for side effects in initializer
          if (opts.removeSideEffectFree && path.node.init && hasSideEffects(path.node.init)) {
            return;
          }
          
          // Remove the declarator
          const varDecl = path.parentPath;
          if (t.isVariableDeclaration(varDecl.node)) {
            if (varDecl.node.declarations.length === 1) {
              varDecl.remove();
            } else {
              path.remove();
            }
            removed++;
            stats.variablesRemoved++;
            stats.totalRemoved++;
          }
        },
        
        // Handle function declarations
        FunctionDeclaration(path) {
          if (!opts.removeFunctions) return;
          
          const id = path.node.id;
          if (!id || !t.isIdentifier(id)) return;
          
          const name = id.name;
          if (shouldPreserve(name)) return;
          
          const binding = path.scope.getBinding(name);
          if (!binding) return;
          
          if (opts.preserveExports && isExported(binding)) return;
          
          const refs = binding.referencePaths.length;
          if (refs > 0) return;
          
          path.remove();
          removed++;
          stats.functionsRemoved++;
          stats.totalRemoved++;
        },
        
        // Handle class declarations
        ClassDeclaration(path) {
          if (!opts.removeClasses) return;
          
          const id = path.node.id;
          if (!id || !t.isIdentifier(id)) return;
          
          const name = id.name;
          if (shouldPreserve(name)) return;
          
          const binding = path.scope.getBinding(name);
          if (!binding) return;
          
          if (opts.preserveExports && isExported(binding)) return;
          
          const refs = binding.referencePaths.length;
          if (refs > 0) return;
          
          path.remove();
          removed++;
          stats.classesRemoved++;
          stats.totalRemoved++;
        },
        
        // Handle imports
        ImportDeclaration(path) {
          if (!opts.removeImports) return;
          
          const specifiers = path.node.specifiers;
          if (specifiers.length === 0) {
            // Side-effect import: import 'module';
            // Keep it as it might have side effects
            return;
          }
          
          // Check each specifier
          const usedSpecifiers = specifiers.filter(spec => {
            const localName = spec.local.name;
            if (shouldPreserve(localName)) return true;
            
            const binding = path.scope.getBinding(localName);
            if (!binding) return true; // Keep if we can't analyze
            
            return binding.referencePaths.length > 0;
          });
          
          if (usedSpecifiers.length === 0) {
            // All imports unused, remove entire declaration
            path.remove();
            removed++;
            stats.importsRemoved++;
            stats.totalRemoved++;
          } else if (usedSpecifiers.length < specifiers.length) {
            // Some imports unused, keep only used ones
            const removedCount = specifiers.length - usedSpecifiers.length;
            path.node.specifiers = usedSpecifiers;
            removed += removedCount;
            stats.importsRemoved += removedCount;
            stats.totalRemoved += removedCount;
          }
        },
        
        // Handle unused function parameters (optional, off by default)
        Function(path) {
          if (!opts.removeParams) return;
          
          const params = path.node.params;
          if (params.length === 0) return;
          
          // Only remove trailing unused params (can't remove middle ones)
          let lastUsedIndex = -1;
          
          for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (!t.isIdentifier(param)) {
              // Complex param (destructuring, rest), stop here
              lastUsedIndex = i;
              continue;
            }
            
            const name = param.name;
            if (shouldPreserve(name)) {
              lastUsedIndex = i;
              continue;
            }
            
            const binding = path.scope.getBinding(name);
            if (binding && binding.referencePaths.length > 0) {
              lastUsedIndex = i;
            }
          }
          
          // Remove trailing unused params
          if (lastUsedIndex < params.length - 1) {
            const removeCount = params.length - 1 - lastUsedIndex;
            params.splice(lastUsedIndex + 1);
            removed += removeCount;
            stats.paramsRemoved += removeCount;
            stats.totalRemoved += removeCount;
          }
        }
      });
      
      return removed;
    }

    // Run multiple passes until no more can be removed
    for (let pass = 0; pass < opts.maxPasses; pass++) {
      stats.passes++;
      const removed = removePass();
      
      if (removed === 0) break;
    }

    return { stats };
  }
);
