

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'OpaquePredicateRemoval',
    description: 'Removes opaque predicates (if conditions that always evaluate to true/false)',
    category: 'Deobfuscation',
    config: {
      removeDeadElse: { type: 'boolean', default: true, description: 'Remove else blocks when condition is always true' },
      removeDeadIf: { type: 'boolean', default: true, description: 'Remove if blocks when condition is always false' },
      foldTernary: { type: 'boolean', default: true, description: 'Also fold ternary expressions (a ? b : c)' },
      foldLogical: { type: 'boolean', default: true, description: 'Also fold logical expressions (a && b, a || b)' },
      unwrapBlocks: { type: 'boolean', default: true, description: 'Unwrap single-statement blocks' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Opaque Predicate Removal Transform
     * Evaluates if/else conditions and removes dead branches
     * Only folds conditions that can be fully evaluated (no variables)
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT REMOVES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Always-true conditions (removes else):
     *     if (1 + 1 === 2) {         →  console.log("always");
     *       console.log("always");
     *     } else {
     *       console.log("never");
     *     }
     * 
     *   Always-false conditions (removes if):
     *     if (false) {               →  (removed entirely)
     *       console.log("never");
     *     }
     * 
     *     if (1 > 2) {               →  console.log("else runs");
     *       console.log("never");
     *     } else {
     *       console.log("else runs");
     *     }
     * 
     *   Ternary expressions:
     *     var x = (5 > 3) ? "yes" : "no";  →  var x = "yes";
     * 
     *   Logical expressions:
     *     var y = true && getValue();      →  var y = getValue();
     *     var z = false || getDefault();   →  var z = getDefault();
     *     var w = null ?? "fallback";      →  var w = "fallback";
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WILL NOT REMOVE:
     * ═══════════════════════════════════════════════════════════════════════════════
     *                                      
     *   - Conditions containing variables (can't evaluate confidently)
     *   - Conditions with function calls (side effects)
     *   - Any expression where path.evaluate() returns confident: false
     * 
     *   Example (kept as-is):
     *     if (x > 5) { ... }         // x is a variable
     *     if (getValue()) { ... }    // function call
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - removeDeadElse: true      → Remove else when condition always true
    *   - removeDeadIf: true        → Remove if when condition always false
    *   - foldTernary: true         → Fold ternary expressions
    *   - foldLogical: true         → Fold && || ?? expressions
    *   - unwrapBlocks: true        → Unwrap single-statement blocks
    * ═══════════════════════════════════════════════════════════════════════════════
    */
    const opts = {
      removeDeadElse: config.removeDeadElse !== false,
      removeDeadIf: config.removeDeadIf !== false,
      foldTernary: config.foldTernary !== false,
      foldLogical: config.foldLogical !== false,
      unwrapBlocks: config.unwrapBlocks !== false
    };

    const stats = {
      ifStatementsRemoved: 0,
      elseBlocksRemoved: 0,
      ternariesFolded: 0,
      logicalFolded: 0,
      totalRemoved: 0
    };

    /**
     * Get statements from a block or wrap single statement
     */
    function getStatements(node) {
      if (!node) return [];
      if (t.isBlockStatement(node)) {
        return node.body;
      }
      return [node];
    }

    /**
     * Check if we can safely replace an if statement with its body
     * (need to handle variable declarations that would leak scope)
     */
    function canUnwrapToParent(statements, parentPath) {
      // If parent is a block or program, we can unwrap
      if (t.isBlockStatement(parentPath.node) || t.isProgram(parentPath.node)) {
        return true;
      }
      
      // If parent expects a single statement, we can only unwrap if there's one statement
      // and it's not a declaration
      if (statements.length === 1) {
        const stmt = statements[0];
        if (!t.isVariableDeclaration(stmt) && !t.isFunctionDeclaration(stmt)) {
          return true;
        }
      }
      
      return false;
    }

    // Process if statements
    traverse(ast, {
      IfStatement(path) {
        const test = path.get('test');
        
        // Try to evaluate the condition
        const result = test.evaluate();
        
        // Only proceed if we're confident (no variables involved)
        if (!result.confident) return;
        
        const conditionValue = result.value;
        
        if (conditionValue) {
          // Condition is always TRUE - replace with consequent
          if (!opts.removeDeadElse) return;
          
          const consequent = path.node.consequent;
          const statements = getStatements(consequent);
          
          if (statements.length === 0) {
            // Empty block, just remove the if
            path.remove();
          } else if (canUnwrapToParent(statements, path.parentPath)) {
            // Replace if with its body
            if (statements.length === 1 && !t.isBlockStatement(path.parentPath.node)) {
              path.replaceWith(statements[0]);
            } else {
              path.replaceWithMultiple(statements);
            }
          } else {
            // Wrap in block to preserve scope
            path.replaceWith(t.blockStatement(statements));
          }
          
          stats.ifStatementsRemoved++;
          stats.totalRemoved++;
          
        } else {
          // Condition is always FALSE - replace with alternate (else) or remove
          if (!opts.removeDeadIf) return;
          
          const alternate = path.node.alternate;
          
          if (!alternate) {
            // No else block, just remove the if entirely
            path.remove();
          } else {
            const statements = getStatements(alternate);
            
            if (statements.length === 0) {
              path.remove();
            } else if (canUnwrapToParent(statements, path.parentPath)) {
              if (statements.length === 1 && !t.isBlockStatement(path.parentPath.node)) {
                path.replaceWith(statements[0]);
              } else {
                path.replaceWithMultiple(statements);
              }
            } else {
              path.replaceWith(t.blockStatement(statements));
            }
          }
          
          stats.elseBlocksRemoved++;
          stats.totalRemoved++;
        }
      },

      // Handle ternary expressions: condition ? a : b
      ConditionalExpression(path) {
        if (!opts.foldTernary) return;
        
        const test = path.get('test');
        const result = test.evaluate();
        
        if (!result.confident) return;
        
        if (result.value) {
          // Replace with consequent
          path.replaceWith(path.node.consequent);
        } else {
          // Replace with alternate
          path.replaceWith(path.node.alternate);
        }
        
        stats.ternariesFolded++;
        stats.totalRemoved++;
      },

      // Handle logical expressions: a && b, a || b
      LogicalExpression(path) {
        if (!opts.foldLogical) return;
        
        const left = path.get('left');
        const result = left.evaluate();
        
        if (!result.confident) return;
        
        const op = path.node.operator;
        
        if (op === '&&') {
          if (result.value) {
            // true && b => b
            path.replaceWith(path.node.right);
            stats.logicalFolded++;
            stats.totalRemoved++;
          } else {
            // false && b => false
            path.replaceWith(path.node.left);
            stats.logicalFolded++;
            stats.totalRemoved++;
          }
        } else if (op === '||') {
          if (result.value) {
            // true || b => true
            path.replaceWith(path.node.left);
            stats.logicalFolded++;
            stats.totalRemoved++;
          } else {
            // false || b => b
            path.replaceWith(path.node.right);
            stats.logicalFolded++;
            stats.totalRemoved++;
          }
        } else if (op === '??') {
          // Nullish coalescing
          if (result.value !== null && result.value !== undefined) {
            // non-nullish ?? b => non-nullish
            path.replaceWith(path.node.left);
            stats.logicalFolded++;
            stats.totalRemoved++;
          } else {
            // null/undefined ?? b => b
            path.replaceWith(path.node.right);
            stats.logicalFolded++;
            stats.totalRemoved++;
          }
        }
      }
    });

    return { stats };
  }
);
