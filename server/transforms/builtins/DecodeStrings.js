/**
 * Decode Strings Transform
 * 
 * Decodes various string encoding/obfuscation techniques commonly used in obfuscated JavaScript.
 * 
 * BEHAVIOR:
 * - By default: nothing is decoded (must explicitly select options)
 * - If `all: true`: enables ALL decoding methods
 * - If specific methods enabled (e.g., decodeBase64: true): ONLY uses those methods
 * 
 * This allows:
 *   {} → does nothing
 *   { all: true } → tries everything
 *   { decodeBase64: true } → only decodes base64
 *   { decodeBase64: true, decodeCharCode: true } → only those two
 */

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'DecodeStrings',
    description: 'Decodes obfuscated strings (base64, hex, unicode, char codes, etc.)',
    category: 'Deobfuscation',
    config: {
      all: { type: 'boolean', default: true, description: 'Enable ALL decoding methods' },
      decodeHex: { type: 'boolean', default: false, description: 'Decode hex escape sequences in string literals (\\x41 → A)' },
      decodeUnicode: { type: 'boolean', default: false, description: 'Decode unicode escapes in string literals (\\u0041 → A)' },
      decodeBase64: { type: 'boolean', default: false, description: 'Decode atob() and Buffer.from base64 calls' },
      decodeCharCode: { type: 'boolean', default: false, description: 'Decode String.fromCharCode() calls' },
      decodeCharAt: { type: 'boolean', default: false, description: 'Decode charAt/charCodeAt on string literals' },
      decodeReverse: { type: 'boolean', default: false, description: 'Decode reversed strings (split+reverse+join)' },
      decodeSplit: { type: 'boolean', default: false, description: 'Decode split().join() patterns' },
      decodeReplace: { type: 'boolean', default: false, description: 'Simplify string.replace() with literals' },
      maxStringLength: { type: 'number', default: 50000, description: 'Max decoded string length to inline' }
    }
  },
  async (ast, config = {}) => {
    /**
     * String Decoding Transform
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * BEHAVIOR:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Default (no config):
     *     Does nothing - must explicitly select options
     * 
     *   { all: true }:
     *     Enables ALL decoding methods
     * 
     *   Specific config (e.g., { decodeBase64: true }):
     *     ONLY uses the specified decoding methods
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WHAT IT DECODES:
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     *   Hex escapes (in StringLiteral nodes):
     *     "\x48\x65\x6c\x6c\x6f"           → "Hello"
     * 
     *   Unicode escapes (in StringLiteral nodes):
     *     "\u0048\u0065\u006c\u006c\u006f" → "Hello"
     * 
     *   String.fromCharCode():
     *     String.fromCharCode(72, 101, 108, 108, 111)  → "Hello"
     * 
     *   Base64 decoding:
     *     atob("SGVsbG8=")                 → "Hello"
     *     Buffer.from("SGVsbG8=", "base64").toString()  → "Hello"
     * 
     *   Reversed strings:
     *     "olleH".split("").reverse().join("")  → "Hello"
     * 
     *   CharAt operations:
     *     "Hello".charCodeAt(0)            → 72
     *     "Hello".charAt(1)                → "e"
     *     "Hello"[2]                       → "l"
     * 
     *   Split/Join patterns:
     *     "H|e|l|l|o".split("|").join("")  → "Hello"
     * 
     *   String.replace with literals:
     *     "HXllX".replace(/X/g, "e")       → "Hello"
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    
    const maxStringLength = config.maxStringLength || 50000;
    const enableAll = config.all === true;
    
    // If `all` is true, enable everything. Otherwise, only enable what's explicitly set.
    const opts = {
      decodeHex: enableAll || config.decodeHex === true,
      decodeUnicode: enableAll || config.decodeUnicode === true,
      decodeBase64: enableAll || config.decodeBase64 === true,
      decodeCharCode: enableAll || config.decodeCharCode === true,
      decodeCharAt: enableAll || config.decodeCharAt === true,
      decodeReverse: enableAll || config.decodeReverse === true,
      decodeSplit: enableAll || config.decodeSplit === true,
      decodeReplace: enableAll || config.decodeReplace === true,
    };
    
    let stats = {
      hexDecoded: 0,
      unicodeDecoded: 0,
      base64Decoded: 0,
      charCodeDecoded: 0,
      charAtDecoded: 0,
      reverseDecoded: 0,
      splitJoinDecoded: 0,
      replaceSimplified: 0
    };
    
    // Helper: Decode base64
    function decodeBase64Str(str) {
      try {
        return Buffer.from(str, 'base64').toString('utf8');
      } catch (e) {
        return null;
      }
    }
    
    // Helper: Check if all arguments are numeric literals
    function allNumericLiterals(args) {
      return args.every(arg => t.isNumericLiteral(arg));
    }
    
    // Helper: Check if a string is valid
    function isValidString(str) {
      if (!str || typeof str !== 'string') return false;
      if (str.length > maxStringLength) return false;
      return true;
    }
    
    // Helper: Try to decode hex escapes from the raw string representation
    function tryDecodeHexUnicode(node) {
      if (!node.extra || !node.extra.raw) return null;
      
      const raw = node.extra.raw;
      // Remove quotes
      let str = raw.slice(1, -1);
      let changed = false;
      
      // Decode hex escapes: \x41 → A
      if (opts.decodeHex && /\\x[0-9a-fA-F]{2}/.test(str)) {
        str = str.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => {
          changed = true;
          return String.fromCharCode(parseInt(hex, 16));
        });
      }
      
      // Decode unicode escapes: \u0041 → A
      if (opts.decodeUnicode && /\\u[0-9a-fA-F]{4}/.test(str)) {
        str = str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
          changed = true;
          return String.fromCharCode(parseInt(hex, 16));
        });
      }
      
      // Decode octal escapes: \101 → A
      if (/\\[0-7]{1,3}/.test(str)) {
        str = str.replace(/\\([0-7]{1,3})/g, (_, oct) => {
          changed = true;
          return String.fromCharCode(parseInt(oct, 8));
        });
      }
      
      // Handle other common escapes
      if (changed) {
        str = str
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\'/g, "'")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      
      return changed ? str : null;
    }
    
    traverse(ast, {
      // Decode StringLiteral nodes with hex/unicode escapes
      StringLiteral(path) {
        if (!opts.decodeHex && !opts.decodeUnicode) return;
        
        const { node } = path;
        const decoded = tryDecodeHexUnicode(node);
        
        if (decoded !== null && isValidString(decoded)) {
          // Check what type of decoding happened for stats
          if (node.extra && node.extra.raw) {
            if (/\\x[0-9a-fA-F]{2}/.test(node.extra.raw)) stats.hexDecoded++;
            if (/\\u[0-9a-fA-F]{4}/.test(node.extra.raw)) stats.unicodeDecoded++;
          }
          
          // Replace with a clean string literal (no extra.raw)
          const newNode = t.stringLiteral(decoded);
          path.replaceWith(newNode);
        }
      },
      
      CallExpression(path) {
        const { node } = path;
        const { callee, arguments: args } = node;
        
        // String.fromCharCode(...numbers) → "string"
        if (opts.decodeCharCode) {
          if (t.isMemberExpression(callee) &&
              t.isIdentifier(callee.object, { name: 'String' })) {
            
            const propName = t.isIdentifier(callee.property) ? callee.property.name :
                            (t.isStringLiteral(callee.property) ? callee.property.value : null);
            
            if (propName === 'fromCharCode' && allNumericLiterals(args)) {
              const decoded = String.fromCharCode(...args.map(a => a.value));
              if (isValidString(decoded)) {
                path.replaceWith(t.stringLiteral(decoded));
                stats.charCodeDecoded++;
                return;
              }
            }
          }
        }
        
        // atob("base64string") → decoded
        if (opts.decodeBase64) {
          if (t.isIdentifier(callee, { name: 'atob' }) && 
              args.length === 1 && 
              t.isStringLiteral(args[0])) {
            const decoded = decodeBase64Str(args[0].value);
            if (decoded && isValidString(decoded)) {
              path.replaceWith(t.stringLiteral(decoded));
              stats.base64Decoded++;
              return;
            }
          }
          
          // Buffer.from("...", "base64").toString()
          if (t.isMemberExpression(callee) &&
              t.isIdentifier(callee.property, { name: 'toString' }) &&
              t.isCallExpression(callee.object)) {
            const innerCall = callee.object;
            if (t.isMemberExpression(innerCall.callee) &&
                t.isIdentifier(innerCall.callee.object, { name: 'Buffer' }) &&
                t.isIdentifier(innerCall.callee.property, { name: 'from' }) &&
                innerCall.arguments.length >= 2 &&
                t.isStringLiteral(innerCall.arguments[0]) &&
                t.isStringLiteral(innerCall.arguments[1]) &&
                innerCall.arguments[1].value === 'base64') {
              const decoded = decodeBase64Str(innerCall.arguments[0].value);
              if (decoded && isValidString(decoded)) {
                path.replaceWith(t.stringLiteral(decoded));
                stats.base64Decoded++;
                return;
              }
            }
          }
        }
        
        // "string".charCodeAt(index) → number
        if (opts.decodeCharAt) {
          if (t.isMemberExpression(callee) &&
              t.isStringLiteral(callee.object) &&
              t.isIdentifier(callee.property, { name: 'charCodeAt' }) &&
              args.length === 1 &&
              t.isNumericLiteral(args[0])) {
            const str = callee.object.value;
            const idx = args[0].value;
            if (idx >= 0 && idx < str.length) {
              path.replaceWith(t.numericLiteral(str.charCodeAt(idx)));
              stats.charAtDecoded++;
              return;
            }
          }
          
          // "string".charAt(index) → "char"
          if (t.isMemberExpression(callee) &&
              t.isStringLiteral(callee.object) &&
              t.isIdentifier(callee.property, { name: 'charAt' }) &&
              args.length === 1 &&
              t.isNumericLiteral(args[0])) {
            const str = callee.object.value;
            const idx = args[0].value;
            if (idx >= 0 && idx < str.length) {
              path.replaceWith(t.stringLiteral(str.charAt(idx)));
              stats.charAtDecoded++;
              return;
            }
          }
        }
        
        // "string".split("").reverse().join("") → reversed string
        if (opts.decodeReverse) {
          if (t.isMemberExpression(callee) &&
              t.isIdentifier(callee.property, { name: 'join' }) &&
              args.length === 1 &&
              t.isStringLiteral(args[0]) &&
              args[0].value === '') {
            
            const reverseCall = callee.object;
            if (t.isCallExpression(reverseCall) &&
                t.isMemberExpression(reverseCall.callee) &&
                t.isIdentifier(reverseCall.callee.property, { name: 'reverse' }) &&
                reverseCall.arguments.length === 0) {
              
              const splitCall = reverseCall.callee.object;
              if (t.isCallExpression(splitCall) &&
                  t.isMemberExpression(splitCall.callee) &&
                  t.isIdentifier(splitCall.callee.property, { name: 'split' }) &&
                  splitCall.arguments.length === 1 &&
                  t.isStringLiteral(splitCall.arguments[0]) &&
                  splitCall.arguments[0].value === '' &&
                  t.isStringLiteral(splitCall.callee.object)) {
                
                const original = splitCall.callee.object.value;
                const reversed = original.split('').reverse().join('');
                if (isValidString(reversed)) {
                  path.replaceWith(t.stringLiteral(reversed));
                  stats.reverseDecoded++;
                  return;
                }
              }
            }
          }
        }
        
        // "a|b|c".split("|").join("") → "abc"
        if (opts.decodeSplit) {
          if (t.isMemberExpression(callee) &&
              t.isIdentifier(callee.property, { name: 'join' }) &&
              args.length === 1 &&
              t.isStringLiteral(args[0])) {
            
            const joinDelim = args[0].value;
            const splitCall = callee.object;
            
            if (t.isCallExpression(splitCall) &&
                t.isMemberExpression(splitCall.callee) &&
                t.isIdentifier(splitCall.callee.property, { name: 'split' }) &&
                splitCall.arguments.length === 1 &&
                t.isStringLiteral(splitCall.arguments[0]) &&
                t.isStringLiteral(splitCall.callee.object)) {
              
              const str = splitCall.callee.object.value;
              const splitDelim = splitCall.arguments[0].value;
              const result = str.split(splitDelim).join(joinDelim);
              
              if (isValidString(result)) {
                path.replaceWith(t.stringLiteral(result));
                stats.splitJoinDecoded++;
                return;
              }
            }
          }
        }
        
        // "string".replace(/pattern/g, "replacement") with literals
        if (opts.decodeReplace) {
          if (t.isMemberExpression(callee) &&
              t.isIdentifier(callee.property, { name: 'replace' }) &&
              t.isStringLiteral(callee.object) &&
              args.length === 2 &&
              t.isStringLiteral(args[1])) {
            
            const str = callee.object.value;
            const replacement = args[1].value;
            
            if (t.isRegExpLiteral(args[0])) {
              try {
                const regex = new RegExp(args[0].pattern, args[0].flags);
                const result = str.replace(regex, replacement);
                if (isValidString(result)) {
                  path.replaceWith(t.stringLiteral(result));
                  stats.replaceSimplified++;
                  return;
                }
              } catch (e) {
                // Invalid regex, skip
              }
            }
            
            if (t.isStringLiteral(args[0])) {
              const result = str.replace(args[0].value, replacement);
              if (isValidString(result)) {
                path.replaceWith(t.stringLiteral(result));
                stats.replaceSimplified++;
                return;
              }
            }
          }
        }
      },
      
      // "string"[index] → "char"
      MemberExpression(path) {
        if (!opts.decodeCharAt) return;
        
        const { node } = path;
        if (t.isStringLiteral(node.object) &&
            node.computed &&
            t.isNumericLiteral(node.property)) {
          const str = node.object.value;
          const idx = node.property.value;
          if (idx >= 0 && idx < str.length) {
            path.replaceWith(t.stringLiteral(str[idx]));
            stats.charAtDecoded++;
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
