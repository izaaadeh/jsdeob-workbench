/**
 * Bracket to Dot Notation
 * Changes things like  console["log"] to console.log
 * 
 * Category: utilities
 */

// Script Editor - Ctrl+Enter to run, Ctrl+E to close
// Use traverse(visitor) to modify the AST
// Access 't' for Babel types

traverse({
  MemberExpression(path) {
    if(path.node.computed === true){
      // this is the bracket notation
      
      prop = path.node.property
      if(t.isStringLiteral(prop)  &&
          /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(prop.value)
       ){

        path.node.computed = false; // step 1

      // step 2 change literal to identifier
        path.node.property = t.identifier(prop.value)
      

      }
    }
  }

});
