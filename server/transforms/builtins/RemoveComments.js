const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createASTTransform } = require('../helpers');

module.exports = createASTTransform(
  {
    name: 'Remove Comments',
    description: 'Removes all comments (line and block) from the code',
    category: 'Cleanup',
    config: {
      removeLineComments: { type: 'boolean', default: true, description: 'Remove single-line comments (//)' },
      removeBlockComments: { type: 'boolean', default: true, description: 'Remove block comments (/* */)' },
      preserveJSDoc: { type: 'boolean', default: false, description: 'Preserve JSDoc comments (/** */)' },
      preservePatterns: { type: 'string', default: '', description: 'Regex pattern for comments to preserve (matched against comment text)' }
    }
  },
  async (ast, config = {}) => {
    /**
     * Remove Comments Transform
     * Strips all comments from the code
     */
    const opts = {
      removeLineComments: config.removeLineComments !== false,
      removeBlockComments: config.removeBlockComments !== false,
      preserveJSDoc: config.preserveJSDoc === true,
      preservePatterns: config.preservePatterns || ''
    };

    const stats = {
      lineCommentsRemoved: 0,
      blockCommentsRemoved: 0,
      totalRemoved: 0
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
     * Check if a comment should be preserved
     */
    function shouldPreserve(comment) {
      // Check JSDoc
      if (opts.preserveJSDoc && comment.type === 'CommentBlock' && comment.value.startsWith('*')) {
        return true;
      }
      
      // Check pattern
      if (preserveRegex && preserveRegex.test(comment.value)) {
        return true;
      }
      
      return false;
    }

    /**
     * Filter comments array
     */
    function filterComments(comments) {
      if (!comments) return null;
      
      const filtered = comments.filter(comment => {
        if (shouldPreserve(comment)) return true;
        
        if (comment.type === 'CommentLine' && opts.removeLineComments) {
          stats.lineCommentsRemoved++;
          stats.totalRemoved++;
          return false;
        }
        
        if (comment.type === 'CommentBlock' && opts.removeBlockComments) {
          stats.blockCommentsRemoved++;
          stats.totalRemoved++;
          return false;
        }
        
        return true;
      });
      
      return filtered.length > 0 ? filtered : null;
    }

    // Remove comments from all nodes
    traverse(ast, {
      enter(path) {
        const node = path.node;
        
        if (node.leadingComments) {
          node.leadingComments = filterComments(node.leadingComments);
        }
        
        if (node.trailingComments) {
          node.trailingComments = filterComments(node.trailingComments);
        }
        
        if (node.innerComments) {
          node.innerComments = filterComments(node.innerComments);
        }
      }
    });

    // Also remove from program's comments array if present
    if (ast.comments) {
      ast.comments = ast.comments.filter(comment => {
        if (shouldPreserve(comment)) return true;
        
        if (comment.type === 'CommentLine' && opts.removeLineComments) {
          return false;
        }
        
        if (comment.type === 'CommentBlock' && opts.removeBlockComments) {
          return false;
        }
        
        return true;
      });
    }

    return { stats };
  }
);
