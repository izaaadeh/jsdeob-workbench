

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'InlineArrayValues',
    description: 'Replaces array member access (arr[0]) with actual values from constant arrays',
    category: 'Deobfuscation',
    config: {
      removeArray: { type: 'boolean', default: false, description: 'Remove the original array declaration if all references are inlined' },
      maxArraySize: { type: 'number', default: 10000, description: 'Max array size to process' },
      onlyStringArrays: { type: 'boolean', default: false, description: 'Only inline arrays containing only strings' },
      inlineObjects: { type: 'boolean', default: true, description: 'Also inline object property access' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Inline Array Values Transform
     * Finds constant arrays and replaces member access (arr[0], arr[1]) with actual values
     * Common pattern in obfuscated code: var _0x1234 = ["string1", "string2", ...]; then _0x1234[0]
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT DOES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Array inlining:
     *     var arr = ["hello", "world", "foo"];
     *     console.log(arr[0]);      → console.log("hello");
     *     console.log(arr[1]);      → console.log("world");
     *     var x = arr[2];           → var x = "foo";
     * 
     *   Object inlining (if enabled):
     *     var obj = { a: "secret", b: 42, c: true };
     *     console.log(obj.a);       → console.log("secret");
     *     console.log(obj["b"]);    → console.log(42);
     * 
     *   With removeArray: true:
     *     var arr = ["a", "b"];    // Gets removed if all accesses inlined
     *     x = "a"; y = "b";
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WILL NOT INLINE:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   - Arrays that are modified (push, pop, splice, assignment)
     *   - Arrays that are reassigned
     *   - Non-literal values (functions, objects, etc.)
     *   - Sparse arrays (arrays with holes)
     *   - Arrays larger than maxArraySize
     *   - Dynamic index access: arr[i] where i is a variable
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - removeArray: false        → Set true to remove array after inlining
     *   - maxArraySize: 10000       → Skip arrays larger than this
     *   - onlyStringArrays: false   → Set true to only process string arrays
     *   - inlineObjects: true       → Also inline object property access
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    const opts = {
      removeArray: config.removeArray === true,
      maxArraySize: config.maxArraySize || 10000,
      onlyStringArrays: config.onlyStringArrays === true,
      inlineObjects: config.inlineObjects !== false
    };

    const stats = {
      arraysFound: 0,
      objectsFound: 0,
      accessesInlined: 0,
      arraysRemoved: 0
    };

    // Map of variable name -> { values: [...], binding: Binding, allLiterals: bool }
    const arrayMap = new Map();
    const objectMap = new Map();

    /**
     * Check if a node is a constant literal we can inline
     */
    function isInlineableLiteral(node) {
      if (t.isStringLiteral(node)) return true;
      if (t.isNumericLiteral(node)) return true;
      if (t.isBooleanLiteral(node)) return true;
      if (t.isNullLiteral(node)) return true;
      if (t.isIdentifier(node) && node.name === 'undefined') return true;
      // Handle negative numbers: -5
      if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
        return true;
      }
      return false;
    }

    /**
     * Clone a literal node for insertion
     */
    function cloneLiteral(node) {
      if (t.isStringLiteral(node)) return t.stringLiteral(node.value);
      if (t.isNumericLiteral(node)) return t.numericLiteral(node.value);
      if (t.isBooleanLiteral(node)) return t.booleanLiteral(node.value);
      if (t.isNullLiteral(node)) return t.nullLiteral();
      if (t.isIdentifier(node) && node.name === 'undefined') return t.identifier('undefined');
      if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
        return t.unaryExpression('-', t.numericLiteral(node.argument.value));
      }
      return null;
    }

    /**
     * Check if array elements are all strings
     */
    function isAllStrings(elements) {
      return elements.every(el => el && t.isStringLiteral(el));
    }

    // Rebuild scope bindings in case previous transforms added nodes
    traverse(ast, {
      Program(path) {
        path.scope.crawl();
      }
    });

    // First pass: find all constant array declarations
    traverse(ast, {
      VariableDeclarator(path) {
        const id = path.node.id;
        const init = path.node.init;

        if (!t.isIdentifier(id) || !init) return;

        const varName = id.name;

        // Check for array: var arr = [...]
        if (t.isArrayExpression(init)) {
          const elements = init.elements;

          // Skip if too large
          if (elements.length > opts.maxArraySize) return;

          // Skip if has holes (sparse array)
          if (elements.some(el => el === null)) return;

          // Check if all elements are literals
          const allLiterals = elements.every(el => isInlineableLiteral(el));
          if (!allLiterals) return;

          // Check string-only constraint
          if (opts.onlyStringArrays && !isAllStrings(elements)) return;

          // Get binding to track modifications
          const binding = path.scope.getBinding(varName);
          if (!binding) return;

          // Check if array is modified anywhere (push, pop, splice, assignment)
          let isModified = false;
          for (const refPath of binding.referencePaths) {
            const parent = refPath.parentPath;
            
            // Check for arr[x] = y (assignment to element)
            if (parent && t.isMemberExpression(parent.node) && parent.node.object === refPath.node) {
              const grandParent = parent.parentPath;
              if (grandParent && t.isAssignmentExpression(grandParent.node) && grandParent.node.left === parent.node) {
                isModified = true;
                break;
              }
            }
            
            // Check for arr.push(), arr.pop(), etc.
            if (parent && t.isMemberExpression(parent.node) && parent.node.object === refPath.node) {
              if (t.isIdentifier(parent.node.property)) {
                const method = parent.node.property.name;
                if (['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort', 'fill'].includes(method)) {
                  isModified = true;
                  break;
                }
              }
            }

            // Check for reassignment: arr = [...]
            if (parent && t.isAssignmentExpression(parent.node) && parent.node.left === refPath.node) {
              isModified = true;
              break;
            }
          }

          if (isModified) return;

          arrayMap.set(varName, {
            values: elements,
            binding,
            declaratorPath: path,
            accessCount: 0
          });
          stats.arraysFound++;
        }

        // Check for object: var obj = { a: 1, b: 2 }
        if (opts.inlineObjects && t.isObjectExpression(init)) {
          const properties = init.properties;

          // Skip if has spread or methods
          if (properties.some(p => t.isSpreadElement(p) || t.isObjectMethod(p))) return;

          // Build property map
          const propMap = new Map();
          let allLiterals = true;

          for (const prop of properties) {
            if (!t.isObjectProperty(prop)) continue;
            
            let key;
            if (t.isIdentifier(prop.key)) {
              key = prop.key.name;
            } else if (t.isStringLiteral(prop.key)) {
              key = prop.key.value;
            } else {
              allLiterals = false;
              break;
            }

            if (!isInlineableLiteral(prop.value)) {
              allLiterals = false;
              break;
            }

            propMap.set(key, prop.value);
          }

          if (!allLiterals || propMap.size === 0) return;

          const binding = path.scope.getBinding(varName);
          if (!binding) return;

          // Check for modifications
          let isModified = false;
          for (const refPath of binding.referencePaths) {
            const parent = refPath.parentPath;
            
            // Check for obj.x = y
            if (parent && t.isMemberExpression(parent.node) && parent.node.object === refPath.node) {
              const grandParent = parent.parentPath;
              if (grandParent && t.isAssignmentExpression(grandParent.node) && grandParent.node.left === parent.node) {
                isModified = true;
                break;
              }
            }

            // Check for reassignment
            if (parent && t.isAssignmentExpression(parent.node) && parent.node.left === refPath.node) {
              isModified = true;
              break;
            }
          }

          if (isModified) return;

          objectMap.set(varName, {
            properties: propMap,
            binding,
            declaratorPath: path,
            accessCount: 0
          });
          stats.objectsFound++;
        }
      }
    });

    // Second pass: replace member expressions
    traverse(ast, {
      MemberExpression(path) {
        const obj = path.node.object;
        const prop = path.node.property;
        const computed = path.node.computed;

        if (!t.isIdentifier(obj)) return;
        const varName = obj.name;

        // Check array access: arr[0], arr[index]
        if (arrayMap.has(varName) && computed) {
          const arrayInfo = arrayMap.get(varName);

          // Get numeric index
          let index = null;
          if (t.isNumericLiteral(prop)) {
            index = prop.value;
          } else if (t.isUnaryExpression(prop) && prop.operator === '-' && t.isNumericLiteral(prop.argument)) {
            index = -prop.argument.value;
          }

          if (index === null || !Number.isInteger(index) || index < 0 || index >= arrayInfo.values.length) {
            return;
          }

          const value = arrayInfo.values[index];
          const newNode = cloneLiteral(value);

          if (newNode) {
            path.replaceWith(newNode);
            arrayInfo.accessCount++;
            stats.accessesInlined++;
          }
        }

        // Check object access: obj.prop or obj["prop"]
        if (objectMap.has(varName)) {
          const objInfo = objectMap.get(varName);
          
          let key = null;
          if (!computed && t.isIdentifier(prop)) {
            key = prop.name;
          } else if (computed && t.isStringLiteral(prop)) {
            key = prop.value;
          }

          if (key === null || !objInfo.properties.has(key)) return;

          const value = objInfo.properties.get(key);
          const newNode = cloneLiteral(value);

          if (newNode) {
            path.replaceWith(newNode);
            objInfo.accessCount++;
            stats.accessesInlined++;
          }
        }
      }
    });

    // Optional: remove array/object declarations if all accesses were inlined
    if (opts.removeArray) {
      for (const [varName, info] of arrayMap) {
        const binding = info.binding;
        
        // Check if all references were inlined (only declaration reference remains)
        const remainingRefs = binding.referencePaths.filter(p => {
          // Check if this reference is inside the original declaration
          let current = p;
          while (current) {
            if (current === info.declaratorPath) return false;
            current = current.parentPath;
          }
          return true;
        });

        if (remainingRefs.length === 0 || info.accessCount >= remainingRefs.length) {
          // Safe to remove
          const declPath = info.declaratorPath;
          const varDeclPath = declPath.parentPath;
          
          if (t.isVariableDeclaration(varDeclPath.node) && varDeclPath.node.declarations.length === 1) {
            varDeclPath.remove();
          } else {
            declPath.remove();
          }
          stats.arraysRemoved++;
        }
      }

      for (const [varName, info] of objectMap) {
        const binding = info.binding;
        
        const remainingRefs = binding.referencePaths.filter(p => {
          let current = p;
          while (current) {
            if (current === info.declaratorPath) return false;
            current = current.parentPath;
          }
          return true;
        });

        if (remainingRefs.length === 0 || info.accessCount >= remainingRefs.length) {
          const declPath = info.declaratorPath;
          const varDeclPath = declPath.parentPath;
          
          if (t.isVariableDeclaration(varDeclPath.node) && varDeclPath.node.declarations.length === 1) {
            varDeclPath.remove();
          } else {
            declPath.remove();
          }
          stats.arraysRemoved++;
        }
      }
    }

    return { stats };
  }
);
