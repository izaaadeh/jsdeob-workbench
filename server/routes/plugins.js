const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const transformRunner = require('../transforms/runner');

// Get base path (supports packaged exe)
const getBasePath = () => global.DATA_BASE_PATH || path.join(__dirname, '../..');

// Root plugins directory - each subfolder becomes a category
const getPluginsRoot = () => path.join(getBasePath(), 'plugins');
// User-saved plugins (JSON metadata files)
const getUserPluginsDir = () => path.join(getBasePath(), 'data/plugins');

/**
 * Extract config parameter hints from plugin code comments
 * Looks for patterns like:
 * // CONFIG PARAMETERS:
 * // - paramName: description
 */
function extractConfigHints(code) {
  const hints = {};
  // Match CONFIG PARAMETERS section - capture all following comment lines
  const configSection = code.match(/\/\/\s*CONFIG\s*PARAMETERS:\s*\n((?:\s*\/\/[^\n]*\n)*)/i);
  
  if (configSection) {
    const lines = configSection[1].split('\n');
    for (const line of lines) {
      // Match lines like: // - paramName: description
      const match = line.match(/\/\/\s*-\s*(\w+):\s*(.+)/);
      if (match) {
        const paramName = match[1];
        const description = match[2].trim();
        
        hints[paramName] = {
          description: description,
          type: 'string',
          default: ''
        };
        
        // Try to detect type from description
        const desc = description.toLowerCase();
        if (desc.includes('array')) {
          hints[paramName].type = 'array';
          hints[paramName].default = [];
        } else if (desc.includes('number') || desc.includes('index')) {
          hints[paramName].type = 'number';
          hints[paramName].default = 0;
        } else if (desc.includes('boolean') || desc.includes('true/false')) {
          hints[paramName].type = 'boolean';
          hints[paramName].default = false;
        } else if (desc.includes('object')) {
          hints[paramName].type = 'object';
          hints[paramName].default = {};
        }
      }
    }
  }
  
  return hints;
}

/**
 * Convert filename to readable name
 * e.g., "decode-string-array.js" -> "Decode String Array"
 */
function fileNameToReadable(filename) {
  return filename
    .replace('.js', '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Scan a folder and return all .js plugins
 */
async function scanPluginFolder(folderPath, category) {
  const plugins = [];
  try {
    const files = await fs.readdir(folderPath);
    for (const file of files) {
      if (file.endsWith('.js') && !file.startsWith('DEMO')) {
        const code = await fs.readFile(path.join(folderPath, file), 'utf-8');
        const name = fileNameToReadable(file);
        const configHints = extractConfigHints(code);
        
        plugins.push({
          id: `${category}-${file.replace('.js', '')}`,
          name: name,
          description: `${category}: ${name}`,
          code: code,
          config: configHints,
          type: 'folder',
          category: category,
          folder: category,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    }
  } catch (err) {
    // Folder doesn't exist or can't be read
  }
  return plugins;
}

// Get all plugins organized by category/folder
router.get('/', async (req, res) => {
  try {
    const categories = [];
    const allPlugins = [];
    
    // Scan plugins root for subfolders (each folder = category)
    const entries = await fs.readdir(getPluginsRoot(), { withFileTypes: true }).catch(() => []);
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const categoryName = entry.name;
        const folderPath = path.join(getPluginsRoot(), categoryName);
        const plugins = await scanPluginFolder(folderPath, categoryName);
        
        if (plugins.length > 0) {
          categories.push({
            id: categoryName,
            name: fileNameToReadable(categoryName),
            folder: categoryName,
            count: plugins.length
          });
          allPlugins.push(...plugins);
        }
      }
    }
    
    // Also load user-saved plugins from data/plugins (JSON files)
    const userFiles = await fs.readdir(getUserPluginsDir()).catch(() => []);
    const userPlugins = [];
    
    for (const file of userFiles) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(getUserPluginsDir(), file), 'utf-8');
        const plugin = JSON.parse(content);
        plugin.type = 'user';
        plugin.category = 'user-saved';
        userPlugins.push(plugin);
      }
    }
    
    if (userPlugins.length > 0) {
      categories.push({
        id: 'user-saved',
        name: 'User Saved',
        folder: null,
        count: userPlugins.length
      });
      allPlugins.push(...userPlugins);
    }
    
    res.json({ 
      success: true, 
      plugins: allPlugins,
      categories: categories
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single plugin
router.get('/:id', async (req, res) => {
  try {
    const pluginId = req.params.id;
    
    // Check if it's a folder-based plugin (format: category-filename)
    const dashIndex = pluginId.indexOf('-');
    if (dashIndex > 0) {
      const category = pluginId.substring(0, dashIndex);
      const filename = pluginId.substring(dashIndex + 1) + '.js';
      const folderPath = path.join(getPluginsRoot(), category, filename);
      
      try {
        const code = await fs.readFile(folderPath, 'utf-8');
        const name = fileNameToReadable(filename);
        const configHints = extractConfigHints(code);
        
        const plugin = {
          id: pluginId,
          name: name,
          description: `${category}: ${name}`,
          code: code,
          config: configHints,
          type: 'folder',
          category: category,
          folder: category,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        
        return res.json({ success: true, plugin });
      } catch (err) {
        // Not found in folder, continue to check user plugins
      }
    }
    
    // Otherwise look in data/plugins (user-saved)
    const pluginPath = path.join(getUserPluginsDir(), `${pluginId}.json`);
    const content = await fs.readFile(pluginPath, 'utf-8');
    const plugin = JSON.parse(content);
    res.json({ success: true, plugin });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Plugin not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Create new plugin
router.post('/', async (req, res) => {
  try {
    const { name, description, code, config = {}, folder } = req.body;
    
    if (!name || !code) {
      return res.status(400).json({ success: false, error: 'Name and code are required' });
    }
    
    // Validate the code
    const validation = transformRunner.validateTransform(code);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    
    // If folder is specified, save as a .js file in the plugins folder
    if (folder) {
      // Sanitize folder name
      const sanitizedFolder = folder.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      const folderPath = path.join(getPluginsRoot(), sanitizedFolder);
      
      // Create folder if it doesn't exist
      await fs.mkdir(folderPath, { recursive: true });
      
      // Sanitize filename from plugin name
      const filename = name.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase() + '.js';
      const filePath = path.join(folderPath, filename);
      
      // Add header comment with metadata
      const fileContent = `/**
 * ${name}
 * ${description || 'No description'}
 * 
 * Category: ${sanitizedFolder}
 */

${code}`;
      
      await fs.writeFile(filePath, fileContent, 'utf-8');
      
      const plugin = {
        id: `${sanitizedFolder}-${filename.replace('.js', '')}`,
        name,
        description: description || '',
        code,
        config,
        type: 'folder',
        category: sanitizedFolder,
        folder: sanitizedFolder,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      return res.json({ success: true, plugin });
    }
    
    // Otherwise save as JSON in data/plugins (Saved Scripts)
    const id = uuidv4();
    const plugin = {
      id,
      name,
      description: description || '',
      code,
      config,
      type: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(getUserPluginsDir(), `${id}.json`),
      JSON.stringify(plugin, null, 2)
    );
    
    res.json({ success: true, plugin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update plugin
router.put('/:id', async (req, res) => {
  try {
    const pluginPath = path.join(getUserPluginsDir(), `${req.params.id}.json`);
    
    // Check if exists
    const existingContent = await fs.readFile(pluginPath, 'utf-8');
    const existing = JSON.parse(existingContent);
    
    const { name, description, code, config } = req.body;
    
    // Validate new code if provided
    if (code) {
      const validation = transformRunner.validateTransform(code);
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.error });
      }
    }
    
    const updated = {
      ...existing,
      name: name || existing.name,
      description: description !== undefined ? description : existing.description,
      code: code || existing.code,
      config: config || existing.config,
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(pluginPath, JSON.stringify(updated, null, 2));
    
    res.json({ success: true, plugin: updated });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Plugin not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Delete plugin
router.delete('/:id', async (req, res) => {
  try {
    const pluginPath = path.join(getUserPluginsDir(), `${req.params.id}.json`);
    await fs.unlink(pluginPath);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Plugin not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Validate plugin code
router.post('/validate', (req, res) => {
  try {
    const { code } = req.body;
    const result = transformRunner.validateTransform(code);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Import plugin from file
router.post('/import', async (req, res) => {
  try {
    const { plugin } = req.body;
    
    if (!plugin || !plugin.name || !plugin.code) {
      return res.status(400).json({ success: false, error: 'Invalid plugin format' });
    }
    
    // Validate the code
    const validation = transformRunner.validateTransform(plugin.code);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    
    const id = uuidv4();
    const newPlugin = {
      id,
      name: plugin.name,
      description: plugin.description || '',
      code: plugin.code,
      config: plugin.config || {},
      type: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(getUserPluginsDir(), `${id}.json`),
      JSON.stringify(newPlugin, null, 2)
    );
    
    res.json({ success: true, plugin: newPlugin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export plugin
router.get('/:id/export', async (req, res) => {
  try {
    const pluginPath = path.join(getUserPluginsDir(), `${req.params.id}.json`);
    const content = await fs.readFile(pluginPath, 'utf-8');
    const plugin = JSON.parse(content);
    
    // Remove internal fields for export
    const exportData = {
      name: plugin.name,
      description: plugin.description,
      code: plugin.code,
      config: plugin.config
    };
    
    res.json({ success: true, plugin: exportData });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Plugin not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

module.exports = router;
