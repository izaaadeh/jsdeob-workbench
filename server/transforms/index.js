/**
 * Built-in Transforms Loader
 * 
 * Loads all transforms from the builtins/ folder.
 * Each file should export a single transform function created with createASTTransform().
 * 
 * To add a new built-in transform:
 *   1. Create a new .js file in server/transforms/builtins/
 *   2. Export a transform using createASTTransform() from helpers.js
 *   3. Restart the server - it will be auto-loaded
 */

/**
 * @typedef {Object} TransformMeta
 * @property {string} name - Display name of the transform
 * @property {string} description - What the transform does
 * @property {string} category - Category for grouping (e.g., 'Simplification')
 * @property {Object[]} [config] - Optional config schema
 * @property {string} [exampleCode] - Example input code
 */

/**
 * @typedef {Function} TransformFunction
 * @property {TransformMeta} meta - Transform metadata
 */

/**
 * @typedef {Object<string, TransformFunction>} TransformMap
 */

const fs = require('fs');
const path = require('path');

// Directory for built-in transforms
const BUILTINS_DIR = path.join(__dirname, 'builtins');

/**
 * Load all transforms from a directory
 * @param {string} dir - Directory path to scan for .js files
 * @returns {TransformMap} Map of transformId -> transformFn
 */
/** @type {Object<string, string>} Map of transformId -> file path */
const filePathMap = {};

function loadTransformsFromDir(dir) {
  /** @type {TransformMap} */
  const transforms = {};
  
  if (!fs.existsSync(dir)) {
    return transforms;
  }
  
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    
    const filePath = path.join(dir, file);
    
    try {
      // Clear require cache to allow hot-reloading
      delete require.cache[require.resolve(filePath)];
      
      const transform = require(filePath);
      
      if (typeof transform === 'function') {
        // Convert filename to camelCase ID
        // e.g., "constant-folding.js" -> "constantFolding"
        const baseName = file.replace('.js', '');
        const id = baseName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        
        transforms[id] = transform;
        filePathMap[id] = filePath; // Track file path for source inspection
        
        // Log loaded transform
        const name = transform.meta?.name || baseName;
        console.log('  + Loaded: ' + name + ' (' + id + ')');
      }
    } catch (error) {
      console.error('  x Failed to load ' + file + ': ' + error.message);
    }
  }
  
  return transforms;
}

/**
 * Load all built-in transforms
 * @returns {TransformMap} All loaded transforms
 */
function loadAllTransforms() {
  console.log('\nLoading built-in transforms...');
  const builtins = loadTransformsFromDir(BUILTINS_DIR);
  
  console.log('\nTotal transforms loaded: ' + Object.keys(builtins).length + '\n');
  
  return builtins;
}

// Load transforms on module load
/** @type {TransformMap} */
const transforms = loadAllTransforms();

// Export all transforms
module.exports = transforms;

// Export file path map for source inspection
module.exports.__filePaths = filePathMap;

// Also export a reload function for development
/** @type {() => TransformMap} */
module.exports.__reload = loadAllTransforms;
