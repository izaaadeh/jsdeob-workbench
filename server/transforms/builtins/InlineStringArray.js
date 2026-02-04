/**
 * Inline String Array Transform
 * 
 * Resolves string array obfuscation patterns where strings are stored in an array
 * and accessed by index throughout the code.
 * 
 * Example:
 *   var _0x1234 = ["Hello", "World", "log"];
 *   console[_0x1234[2]](_0x1234[0]);
 *   
 * Becomes:
 *   console["log"]("Hello");
 */

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'InlineStringArray',
    description: 'Inlines string array accesses like arr[0] with the actual string value',
    category: 'Deobfuscation',
    config: {
      removeArray: { type: 'boolean', default: true, description: 'Remove the array declaration if no longer used' },
      minArraySize: { type: 'number', default: 1, description: 'Minimum array size to consider for inlining' },
      maxArraySize: { type: 'number', default: 10000, description: 'Maximum array size to inline' },
      onlyObfuscatedNames: { type: 'boolean', default: false, description: 'Only process arrays with obfuscated names (like _0x1234)' }
    }
  },
  async (ast, config = {}) => {
    /**
     * String Array Inlining Transform
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT DOES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Finds patterns like:
     *     var _0x1234 = ["Hello", "World", "log"];
     *     console[_0x1234[2]](_0x1234[0], _0x1234[1]);
     * 
     *   Transforms to:
     *     console["log"]("Hello", "World");
     * 
     *   Or with property access simplification:
     *     console.log("Hello", "World");
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * HANDLES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   - var/let/const declarations with array literals
     *   - Numeric index access: arr[0], arr[1], etc.
     *   - Computed index with literals: arr[0x10], arr[1 + 2]
     *   - Nested in member expressions: obj[arr[0]]
     *   - Function arguments: func(arr[0], arr[1])
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - removeArray: true       → Remove array declaration after inlining
     *   - minArraySize: 1         → Minimum array size to process
     *   - maxArraySize: 10000     → Maximum array size to process
     *   - onlyObfuscatedNames: false → Only process _0x... style names
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    
    const opts = {
      removeArray: config.removeArray !== false,
      minArraySize: config.minArraySize || 1,
      maxArraySize: config.maxArraySize || 10000,
      onlyObfuscatedNames: config.onlyObfuscatedNames === true
    };
    
    let stats = {
      arraysFound: 0,
      accessesInlined: 0,
      arraysRemoved: 0
    };
    
    // Store found string arrays: { name: string, elements: any[], binding: Binding, path: NodePath }
    const stringArrays = new Map();
    
    // Helper: Check if name looks obfuscated
    function isObfuscatedName(name) {
      // Matches patterns like _0x1234, _0xabcd, $0x..., etc.
      return /^[_$]?0x[0-9a-fA-F]+$/.test(name) || 
             /^[_$][a-zA-Z0-9]{4,}$/.test(name);
    }
    
    // Helper: Check if array contains only literals (strings, numbers, booleans, null)
    function isLiteralArray(elements) {
      return elements.every(el => 
        el === null || // sparse array
        t.isStringLiteral(el) ||
        t.isNumericLiteral(el) ||
        t.isBooleanLiteral(el) ||
        t.isNullLiteral(el) ||
        (t.isUnaryExpression(el) && el.operator === '-' && t.isNumericLiteral(el.argument))
      );
    }
    
    // Helper: Get value from literal node
    function getLiteralValue(node) {
      if (t.isStringLiteral(node)) return node.value;
      if (t.isNumericLiteral(node)) return node.value;
      if (t.isBooleanLiteral(node)) return node.value;
      if (t.isNullLiteral(node)) return null;
      if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
        return -node.argument.value;
      }
      return undefined;
    }
    
    // Helper: Create AST node from value
    function valueToNode(value) {
      if (typeof value === 'string') return t.stringLiteral(value);
      if (typeof value === 'number') {
        if (value < 0) {
          return t.unaryExpression('-', t.numericLiteral(-value));
        }
        return t.numericLiteral(value);
      }
      if (typeof value === 'boolean') return t.booleanLiteral(value);
      if (value === null) return t.nullLiteral();
      return null;
    }
    
    // Helper: Try to evaluate index expression to a number
    function evaluateIndex(node) {
      if (t.isNumericLiteral(node)) {
        return node.value;
      }
      // Handle hex literals that might be in expressions
      if (t.isUnaryExpression(node) && node.operator === '+' && t.isNumericLiteral(node.argument)) {
        return node.argument.value;
      }
      // Simple binary expressions with literals
      if (t.isBinaryExpression(node) && 
          t.isNumericLiteral(node.left) && 
          t.isNumericLiteral(node.right)) {
        switch (node.operator) {
          case '+': return node.left.value + node.right.value;
          case '-': return node.left.value - node.right.value;
          case '*': return node.left.value * node.right.value;
          case '/': return Math.floor(node.left.value / node.right.value);
          case '%': return node.left.value % node.right.value;
          case '|': return node.left.value | node.right.value;
          case '&': return node.left.value & node.right.value;
          case '^': return node.left.value ^ node.right.value;
        }
      }
      return null;
    }
    
    // First pass: Find all string arrays
    traverse(ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        
        // Must be: var name = [...]
        if (!t.isIdentifier(id) || !t.isArrayExpression(init)) {
          return;
        }
        
        const name = id.name;
        const elements = init.elements;
        
        // Check name if required
        if (opts.onlyObfuscatedNames && !isObfuscatedName(name)) {
          return;
        }
        
        // Check array size
        if (elements.length < opts.minArraySize || elements.length > opts.maxArraySize) {
          return;
        }
        
        // Check if array contains only literals
        if (!isLiteralArray(elements)) {
          return;
        }
        
        // Get binding to check if array is modified
        const binding = path.scope.getBinding(name);
        if (!binding) return;
        
        // Check if array is reassigned or modified
        let isModified = false;
        for (const refPath of binding.referencePaths) {
          const parent = refPath.parent;
          
          // Check for array modification: arr[0] = x, arr.push(x), etc.
          if (t.isAssignmentExpression(parent) && 
              t.isMemberExpression(parent.left) &&
              parent.left.object === refPath.node) {
            isModified = true;
            break;
          }
          
          // Check for method calls that modify: arr.push(), arr.pop(), etc.
          if (t.isCallExpression(parent) && 
              t.isMemberExpression(parent.callee) &&
              parent.callee.object === refPath.node) {
            const method = parent.callee.property;
            if (t.isIdentifier(method) && 
                ['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort', 'fill'].includes(method.name)) {
              isModified = true;
              break;
            }
          }
          
          // Check for reassignment: arr = [...]
          if (t.isAssignmentExpression(parent) && parent.left === refPath.node) {
            isModified = true;
            break;
          }
        }
        
        if (isModified) {
          return;
        }
        
        // Extract values
        const values = elements.map(el => el ? getLiteralValue(el) : undefined);
        
        stringArrays.set(name, {
          name,
          values,
          elements,
          binding,
          path,
          accessCount: 0
        });
        
        stats.arraysFound++;
      }
    });
    
    // Second pass: Replace array accesses
    traverse(ast, {
      MemberExpression(path) {
        const { node } = path;
        
        // Must be computed access: arr[index]
        if (!node.computed) return;
        
        // Object must be identifier
        if (!t.isIdentifier(node.object)) return;
        
        const arrayName = node.object.name;
        const arrayInfo = stringArrays.get(arrayName);
        
        if (!arrayInfo) return;
        
        // Try to evaluate the index
        const index = evaluateIndex(node.property);
        
        if (index === null || index < 0 || index >= arrayInfo.values.length) {
          return;
        }
        
        const value = arrayInfo.values[index];
        if (value === undefined) return; // Sparse array hole
        
        const replacement = valueToNode(value);
        if (!replacement) return;
        
        path.replaceWith(replacement);
        arrayInfo.accessCount++;
        stats.accessesInlined++;
      }
    });
    
    // Third pass: Remove unused array declarations
    if (opts.removeArray) {
      for (const [name, info] of stringArrays) {
        // Refresh scope info after modifications
        info.path.scope.crawl();
        
        // Check if array is still referenced
        const binding = info.path.scope.getBinding(name);
        
        // Remove if:
        // 1. We inlined some accesses and no references remain, OR
        // 2. The array was never used at all (dead code)
        if (binding && binding.referencePaths.length === 0) {
          // Remove the declaration
          const declarator = info.path;
          const declaration = declarator.parentPath;
          
          if (t.isVariableDeclaration(declaration.node) && 
              declaration.node.declarations.length === 1) {
            // Only declarator in declaration, remove whole statement
            declaration.remove();
          } else {
            // Multiple declarators, just remove this one
            declarator.remove();
          }
          stats.arraysRemoved++;
        }
      }
    }
    
    return {
      stats: {
        changes: stats.accessesInlined + stats.arraysRemoved,
        ...stats
      }
    };
  }
);
