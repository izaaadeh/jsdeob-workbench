/**
 * Simplify Literals Transform
 * 
 * Simplifies obfuscated literal patterns to their readable equivalents.
 * 
 * Examples:
 *   !0 → true
 *   !1 → false
 *   void 0 → undefined
 *   0x10 + 0x20 → 48
 *   !![] → true
 *   +!![] → 1
 */

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'SimplifyLiterals',
    description: 'Simplifies !0→true, !1→false, void 0→undefined, hex numbers, etc.',
    category: 'Simplification',
    config: {
      simplifyBooleans: { type: 'boolean', default: true, description: 'Convert !0→true, !1→false, !!x patterns' },
      simplifyVoid: { type: 'boolean', default: true, description: 'Convert void 0 → undefined' },
      simplifyHex: { type: 'boolean', default: true, description: 'Convert hex numbers like 0x10 to decimal in output' },
      simplifyInfinity: { type: 'boolean', default: true, description: 'Simplify 1/0→Infinity, -1/0→-Infinity' },
      simplifyNaN: { type: 'boolean', default: true, description: 'Simplify 0/0→NaN, NaN checks' },
      simplifyTypeof: { type: 'boolean', default: true, description: 'Simplify typeof on literals' },
      convertToIdentifier: { type: 'boolean', default: true, description: 'Use identifier true/false/undefined instead of literals where valid' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Literal Simplification Transform
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT SIMPLIFIES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Boolean patterns:
     *     !0              → true
     *     !1              → false
     *     ![]             → false
     *     !""             → true
     *     !!x             → Boolean(x) or just the truthy check
     *     !![]            → true
     *     !!0             → false
     *     !!1             → true
     * 
     *   Void patterns:
     *     void 0          → undefined
     *     void(0)         → undefined
     *     void ""         → undefined
     * 
     *   Numeric patterns:
     *     0x10            → 16 (in generated output)
     *     1e3             → 1000
     *     1/0             → Infinity
     *     -1/0            → -Infinity
     *     0/0             → NaN
     * 
     *   Typeof on literals:
     *     typeof "hello"  → "string"
     *     typeof 123      → "number"
     *     typeof true     → "boolean"
     *     typeof undefined→ "undefined"
     *     typeof null     → "object"
     *     typeof []       → "object"
     *     typeof {}       → "object"
     *     typeof function(){}  → "function"
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * CONFIG OPTIONS:
     *   - simplifyBooleans: true    → Convert !0, !1, !! patterns
     *   - simplifyVoid: true        → Convert void 0 to undefined
     *   - simplifyHex: true         → Normalize hex to decimal
     *   - simplifyInfinity: true    → Convert 1/0 to Infinity
     *   - simplifyNaN: true         → Convert 0/0 to NaN
     *   - simplifyTypeof: true      → Evaluate typeof on literals
     *   - convertToIdentifier: true → Use true/false/undefined identifiers
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    
    const opts = {
      simplifyBooleans: config.simplifyBooleans !== false,
      simplifyVoid: config.simplifyVoid !== false,
      simplifyHex: config.simplifyHex !== false,
      simplifyInfinity: config.simplifyInfinity !== false,
      simplifyNaN: config.simplifyNaN !== false,
      simplifyTypeof: config.simplifyTypeof !== false,
      convertToIdentifier: config.convertToIdentifier !== false
    };
    
    let stats = {
      booleansSimplified: 0,
      voidSimplified: 0,
      hexNormalized: 0,
      infinitySimplified: 0,
      nanSimplified: 0,
      typeofSimplified: 0
    };
    
    // Helper: Check if a value is falsy in JavaScript
    function isFalsyLiteral(node) {
      if (t.isNumericLiteral(node) && node.value === 0) return true;
      if (t.isStringLiteral(node) && node.value === '') return true;
      if (t.isBooleanLiteral(node) && node.value === false) return true;
      if (t.isNullLiteral(node)) return true;
      if (t.isIdentifier(node) && node.name === 'undefined') return true;
      if (t.isIdentifier(node) && node.name === 'NaN') return true;
      return false;
    }
    
    // Helper: Check if a value is truthy literal
    function isTruthyLiteral(node) {
      if (t.isNumericLiteral(node) && node.value !== 0) return true;
      if (t.isStringLiteral(node) && node.value !== '') return true;
      if (t.isBooleanLiteral(node) && node.value === true) return true;
      if (t.isArrayExpression(node)) return true; // [] is truthy
      if (t.isObjectExpression(node)) return true; // {} is truthy
      if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
      return false;
    }
    
    // Helper: Create boolean node
    function createBoolean(value) {
      if (opts.convertToIdentifier) {
        return t.identifier(value ? 'true' : 'false');
      }
      return t.booleanLiteral(value);
    }
    
    // Helper: Create undefined node
    function createUndefined() {
      if (opts.convertToIdentifier) {
        return t.identifier('undefined');
      }
      return t.unaryExpression('void', t.numericLiteral(0));
    }
    
    traverse(ast, {
      // Handle !0, !1, !"", ![], etc.
      UnaryExpression(path) {
        const { node } = path;
        
        // Boolean negation: !x
        if (opts.simplifyBooleans && node.operator === '!') {
          const arg = node.argument;
          
          // !0 → true
          if (t.isNumericLiteral(arg) && arg.value === 0) {
            path.replaceWith(createBoolean(true));
            stats.booleansSimplified++;
            return;
          }
          
          // !1 → false (and any non-zero number)
          if (t.isNumericLiteral(arg) && arg.value !== 0) {
            path.replaceWith(createBoolean(false));
            stats.booleansSimplified++;
            return;
          }
          
          // !"" → true
          if (t.isStringLiteral(arg) && arg.value === '') {
            path.replaceWith(createBoolean(true));
            stats.booleansSimplified++;
            return;
          }
          
          // !"non-empty" → false
          if (t.isStringLiteral(arg) && arg.value !== '') {
            path.replaceWith(createBoolean(false));
            stats.booleansSimplified++;
            return;
          }
          
          // ![] → false (arrays are truthy)
          if (t.isArrayExpression(arg)) {
            path.replaceWith(createBoolean(false));
            stats.booleansSimplified++;
            return;
          }
          
          // !{} → false (objects are truthy)
          if (t.isObjectExpression(arg)) {
            path.replaceWith(createBoolean(false));
            stats.booleansSimplified++;
            return;
          }
          
          // !true → false, !false → true
          if (t.isBooleanLiteral(arg)) {
            path.replaceWith(createBoolean(!arg.value));
            stats.booleansSimplified++;
            return;
          }
          
          // !null → true
          if (t.isNullLiteral(arg)) {
            path.replaceWith(createBoolean(true));
            stats.booleansSimplified++;
            return;
          }
          
          // !undefined → true
          if (t.isIdentifier(arg, { name: 'undefined' })) {
            path.replaceWith(createBoolean(true));
            stats.booleansSimplified++;
            return;
          }
          
          // !!x where x is a literal - double negation
          if (t.isUnaryExpression(arg) && arg.operator === '!') {
            const innerArg = arg.argument;
            
            if (isFalsyLiteral(innerArg)) {
              path.replaceWith(createBoolean(false));
              stats.booleansSimplified++;
              return;
            }
            
            if (isTruthyLiteral(innerArg)) {
              path.replaceWith(createBoolean(true));
              stats.booleansSimplified++;
              return;
            }
          }
        }
        
        // void 0 → undefined
        if (opts.simplifyVoid && node.operator === 'void') {
          // void with any literal argument evaluates to undefined
          if (t.isLiteral(node.argument) || 
              t.isIdentifier(node.argument) ||
              t.isNumericLiteral(node.argument)) {
            path.replaceWith(createUndefined());
            stats.voidSimplified++;
            return;
          }
        }
        
        // typeof on literals
        if (opts.simplifyTypeof && node.operator === 'typeof') {
          const arg = node.argument;
          let typeStr = null;
          
          if (t.isStringLiteral(arg)) typeStr = 'string';
          else if (t.isNumericLiteral(arg)) typeStr = 'number';
          else if (t.isBooleanLiteral(arg)) typeStr = 'boolean';
          else if (t.isNullLiteral(arg)) typeStr = 'object'; // typeof null === "object"
          else if (t.isIdentifier(arg, { name: 'undefined' })) typeStr = 'undefined';
          else if (t.isArrayExpression(arg)) typeStr = 'object';
          else if (t.isObjectExpression(arg)) typeStr = 'object';
          else if (t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)) typeStr = 'function';
          else if (t.isRegExpLiteral(arg)) typeStr = 'object';
          else if (t.isBigIntLiteral && t.isBigIntLiteral(arg)) typeStr = 'bigint';
          
          if (typeStr) {
            path.replaceWith(t.stringLiteral(typeStr));
            stats.typeofSimplified++;
            return;
          }
        }
      },
      
      // Handle numeric literals - normalize hex to decimal
      NumericLiteral(path) {
        if (!opts.simplifyHex) return;
        
        const { node } = path;
        // If the raw value contains hex notation, the output will be decimal anyway
        // This is more about tracking - Babel generates decimal by default
        if (node.extra && node.extra.raw && /^0[xXoObB]/.test(node.extra.raw)) {
          // Remove extra.raw to ensure decimal output
          delete node.extra.raw;
          delete node.extra.rawValue;
          stats.hexNormalized++;
        }
      },
      
      // Handle division patterns: 1/0 → Infinity, 0/0 → NaN
      BinaryExpression(path) {
        const { node } = path;
        
        if (node.operator === '/') {
          const left = node.left;
          const right = node.right;
          
          // x/0 patterns
          if (t.isNumericLiteral(right) && right.value === 0) {
            // 0/0 → NaN
            if (opts.simplifyNaN && t.isNumericLiteral(left) && left.value === 0) {
              path.replaceWith(t.identifier('NaN'));
              stats.nanSimplified++;
              return;
            }
            
            // positive/0 → Infinity
            if (opts.simplifyInfinity && t.isNumericLiteral(left) && left.value > 0) {
              path.replaceWith(t.identifier('Infinity'));
              stats.infinitySimplified++;
              return;
            }
            
            // negative/0 → -Infinity
            if (opts.simplifyInfinity && t.isNumericLiteral(left) && left.value < 0) {
              path.replaceWith(t.unaryExpression('-', t.identifier('Infinity')));
              stats.infinitySimplified++;
              return;
            }
            
            // -x/0 where x is positive
            if (opts.simplifyInfinity && 
                t.isUnaryExpression(left) && 
                left.operator === '-' && 
                t.isNumericLiteral(left.argument) && 
                left.argument.value > 0) {
              path.replaceWith(t.unaryExpression('-', t.identifier('Infinity')));
              stats.infinitySimplified++;
              return;
            }
          }
        }
      }
    });
    
    const totalChanges = Object.values(stats).reduce((a, b) => a + b, 0);
    
    return {
      stats: {
        changes: totalChanges,
        ...stats
      }
    };
  }
);
