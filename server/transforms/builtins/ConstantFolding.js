

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'ConstantFolding',
    description: 'Greedily folds constant expressions using path.evaluate()',
    category: 'Simplification',
    config: {
      foldStrings: { type: 'boolean', default: true, description: 'Fold string concatenations' },
      foldMath: { type: 'boolean', default: true, description: 'Fold math operations' },
      foldLogical: { type: 'boolean', default: true, description: 'Fold logical expressions (&&, ||)' },
      foldComparisons: { type: 'boolean', default: true, description: 'Fold comparisons (===, <, etc)' },
      foldArrays: { type: 'boolean', default: true, description: 'Fold array methods like join, length' },
      foldTemplateLiterals: { type: 'boolean', default: true, description: 'Fold template literals to strings' },
      maxStringLength: { type: 'number', default: 10000, description: 'Max string length to inline' },
      maxArrayLength: { type: 'number', default: 100, description: 'Max array length to evaluate' },
      maxPasses: { type: 'number', default: 5, description: 'Max folding passes (for nested expressions)' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Constant Folding Transform (Greedy)
     * Uses path.evaluate() to fold all evaluable expressions
     * Handles: math, strings, booleans, arrays, objects, and more
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT FOLDS:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Math operations:
     *     1 + 2 * 3           → 7
     *     10 / 2 + 1          → 6
     *     Math.pow(2, 8)      → 256
     * 
     *   String operations:
     *     "a" + "b" + "c"     → "abc"
     *     "hello".length      → 5
     *     "hello"[0]          → "h"
     *     "abc".toUpperCase() → "ABC"
     * 
     *   Comparisons:
     *     5 > 3               → true
     *     "a" === "b"         → false
     *     1 == "1"            → true
     * 
     *   Logical expressions:
     *     true && false       → false
     *     true || false       → true
     *     !false              → true
     * 
     *   Unary expressions:
     *     -(-5)               → 5
     *     ~0                  → -1
     *     typeof "hello"      → "string"
     * 
     *   Template literals:
     *     `hello ${"world"}`  → "hello world"
     * 
     *   Array operations:
     *     [1,2,3][1]          → 2
     *     [1,2,3].length      → 3
     *     [1,2,3].join("-")   → "1-2-3"
     * 
     *   Ternary expressions:
     *     true ? "yes" : "no" → "yes"
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WILL NOT FOLD:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   - Expressions containing variables (not confident)
     *   - Function calls with side effects
     *   - Strings longer than maxStringLength
     *   - Arrays larger than maxArrayLength
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - foldStrings: true         → Fold string concatenations
     *   - foldMath: true            → Fold math operations
     *   - foldLogical: true         → Fold && || expressions
     *   - foldComparisons: true     → Fold === < > etc
     *   - foldArrays: true          → Fold array methods
     *   - foldTemplateLiterals: true→ Fold template strings
     *   - maxPasses: 5              → Passes for nested expressions
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    const opts = {
      foldStrings: config.foldStrings !== false,
      foldMath: config.foldMath !== false,
      foldLogical: config.foldLogical !== false,
      foldComparisons: config.foldComparisons !== false,
      foldArrays: config.foldArrays !== false,
      foldTemplateLiterals: config.foldTemplateLiterals !== false,
      maxStringLength: config.maxStringLength || 10000,
      maxArrayLength: config.maxArrayLength || 100,
      maxPasses: config.maxPasses || 5
    };

    const stats = {
      binaryFolded: 0,
      unaryFolded: 0,
      logicalFolded: 0,
      comparisonsFolded: 0,
      stringsFolded: 0,
      templatesFolded: 0,
      arraysFolded: 0,
      callsFolded: 0,
      membersFolded: 0,
      conditionalsFolded: 0,
      totalFolded: 0,
      passes: 0
    };

    /**
     * Check if a value can be safely converted to an AST node
     */
    function canConvertToNode(value) {
      if (value === null) return true;
      if (value === undefined) return true;
      
      const type = typeof value;
      if (type === 'string') return value.length <= opts.maxStringLength;
      if (type === 'number') return Number.isFinite(value);
      if (type === 'boolean') return true;
      
      if (Array.isArray(value)) {
        return value.length <= opts.maxArrayLength && 
               value.every(v => canConvertToNode(v));
      }
      
      if (type === 'object' && value !== null) {
        const keys = Object.keys(value);
        return keys.length <= opts.maxArrayLength &&
               keys.every(k => typeof k === 'string' && canConvertToNode(value[k]));
      }
      
      return false;
    }

    /**
     * Convert a JavaScript value to an AST node
     */
    function valueToNode(value) {
      if (value === null) return t.nullLiteral();
      if (value === undefined) return t.identifier('undefined');
      
      const type = typeof value;
      
      if (type === 'string') return t.stringLiteral(value);
      if (type === 'number') {
        if (Object.is(value, -0)) return t.unaryExpression('-', t.numericLiteral(0));
        if (value < 0) return t.unaryExpression('-', t.numericLiteral(-value));
        if (!Number.isFinite(value)) {
          if (Number.isNaN(value)) return t.identifier('NaN');
          return t.identifier('Infinity');
        }
        return t.numericLiteral(value);
      }
      if (type === 'boolean') return t.booleanLiteral(value);
      
      if (Array.isArray(value)) {
        return t.arrayExpression(value.map(v => valueToNode(v)));
      }
      
      if (type === 'object' && value !== null) {
        const props = Object.keys(value).map(key => {
          const keyNode = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
            ? t.identifier(key)
            : t.stringLiteral(key);
          return t.objectProperty(keyNode, valueToNode(value[key]));
        });
        return t.objectExpression(props);
      }
      
      return null;
    }

    /**
     * Check if node type should be folded based on config
     */
    function shouldFold(path) {
      const node = path.node;
      
      // Binary expressions (math, string concat, comparisons)
      if (t.isBinaryExpression(node)) {
        const op = node.operator;
        // Math operators
        if (['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^'].includes(op)) {
          // Check if it's string concat or math
          if (op === '+') {
            return opts.foldStrings || opts.foldMath;
          }
          return opts.foldMath;
        }
        // Comparison operators
        if (['===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(op)) {
          return opts.foldComparisons;
        }
      }
      
      // Unary expressions (!x, -x, ~x, typeof x)
      if (t.isUnaryExpression(node)) {
        return opts.foldMath;
      }
      
      // Logical expressions (&&, ||, ??)
      if (t.isLogicalExpression(node)) {
        return opts.foldLogical;
      }
      
      // Template literals
      if (t.isTemplateLiteral(node)) {
        return opts.foldTemplateLiterals;
      }
      
      // Conditional expressions (ternary)
      if (t.isConditionalExpression(node)) {
        return opts.foldLogical;
      }
      
      // Member expressions (array.length, string.length, "abc"[0])
      if (t.isMemberExpression(node)) {
        return opts.foldArrays || opts.foldStrings;
      }
      
      // Call expressions (array methods, String/Number constructors)
      if (t.isCallExpression(node)) {
        return opts.foldArrays || opts.foldStrings;
      }
      
      return true;
    }

    /**
     * Perform one pass of constant folding
     */
    function foldPass() {
      let folded = 0;

      traverse(ast, {
        // Evaluate all expression types that can be folded
        'BinaryExpression|UnaryExpression|LogicalExpression|ConditionalExpression|MemberExpression|CallExpression|TemplateLiteral'(path) {
          // Skip if already a literal
          if (t.isLiteral(path.node) && !t.isTemplateLiteral(path.node)) return;
          
          // Check config
          if (!shouldFold(path)) return;
          
          // Don't fold if it would affect function behavior
          if (path.parentPath && t.isCallExpression(path.parentPath.node) && 
              path.parentPath.node.callee === path.node) {
            // This is a callee, only fold if it's a simple lookup
            if (!t.isMemberExpression(path.node)) return;
          }

          try {
            const result = path.evaluate();
            
            if (result.confident && canConvertToNode(result.value)) {
              const newNode = valueToNode(result.value);
              
              if (newNode && !nodesEqual(path.node, newNode)) {
                // Track what we folded
                if (t.isBinaryExpression(path.node)) {
                  if (['===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(path.node.operator)) {
                    stats.comparisonsFolded++;
                  } else if (path.node.operator === '+' && typeof result.value === 'string') {
                    stats.stringsFolded++;
                  } else {
                    stats.binaryFolded++;
                  }
                } else if (t.isUnaryExpression(path.node)) {
                  stats.unaryFolded++;
                } else if (t.isLogicalExpression(path.node)) {
                  stats.logicalFolded++;
                } else if (t.isTemplateLiteral(path.node)) {
                  stats.templatesFolded++;
                } else if (t.isMemberExpression(path.node)) {
                  stats.membersFolded++;
                } else if (t.isCallExpression(path.node)) {
                  stats.callsFolded++;
                } else if (t.isConditionalExpression(path.node)) {
                  stats.conditionalsFolded++;
                }
                
                path.replaceWith(newNode);
                folded++;
                stats.totalFolded++;
              }
            }
          } catch (e) {
            // Evaluation failed, skip this node
          }
        },

        // Special handling for sequence expressions like (0, func)()
        SequenceExpression(path) {
          const exprs = path.node.expressions;
          // If all but last are literals, we can simplify
          if (exprs.length > 1) {
            const meaningful = exprs.filter((e, i) => {
              if (i === exprs.length - 1) return true; // Keep last
              return !t.isLiteral(e) && !t.isIdentifier(e);
            });
            if (meaningful.length === 1) {
              path.replaceWith(meaningful[0]);
              folded++;
              stats.totalFolded++;
            }
          }
        }
      });

      return folded;
    }

    /**
     * Check if two nodes are essentially equal
     */
    function nodesEqual(a, b) {
      if (a.type !== b.type) return false;
      
      if (t.isStringLiteral(a) && t.isStringLiteral(b)) {
        return a.value === b.value;
      }
      if (t.isNumericLiteral(a) && t.isNumericLiteral(b)) {
        return a.value === b.value;
      }
      if (t.isBooleanLiteral(a) && t.isBooleanLiteral(b)) {
        return a.value === b.value;
      }
      if (t.isNullLiteral(a) && t.isNullLiteral(b)) {
        return true;
      }
      if (t.isIdentifier(a) && t.isIdentifier(b)) {
        return a.name === b.name;
      }
      
      return false;
    }

    // Run multiple passes until no more folding happens
    let totalFolded = 0;
    for (let pass = 0; pass < opts.maxPasses; pass++) {
      stats.passes++;
      const folded = foldPass();
      totalFolded += folded;
      
      if (folded === 0) break; // No more to fold
    }

    return { stats };
  }
);
