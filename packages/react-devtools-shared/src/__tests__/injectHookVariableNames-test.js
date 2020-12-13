/**
 * @flow
 */

import {parse} from '@babel/parser';
import {
  getHookVariableName,
  getPotentialHookDeclarationsFromAST,
  checkNodeLocation,
  isConfirmedHookDeclaration,
  getFilteredHookASTNodes,
} from 'react-devtools-shared/src/utils';

describe('injectHookVariableNamesFunction', () => {
  it('should identify variable names in destructed syntax', async done => {
    const jsxCode = `
            const Example = () => {
                const [count, setCount] = React.useState(1);
                return count;
            };
        `;

    const ast = parse(jsxCode, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript'],
    });
    const hookAstNodes = getPotentialHookDeclarationsFromAST(ast);

    // Only one hook node is present in the source code
    expect(hookAstNodes).toHaveLength(1);

    const hookName = getHookVariableName(hookAstNodes[0]);
    expect(hookName).toBe('count');
    done();
  });

  it('should identify variable names in direct assignment', async done => {
    const jsxCode = `
            const Example = () => {
                const count = React.useState(1);
                return count;
            };
        `;

    const ast = parse(jsxCode, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript'],
    });
    const hookAstNodes = getPotentialHookDeclarationsFromAST(ast);

    // Only one hook node is present in the source code
    expect(hookAstNodes).toHaveLength(1);

    const hookName = getHookVariableName(hookAstNodes[0]);
    expect(hookName).toBe('count');
    done();
  });

  it('should identify variable names in case of destructured assignment', async done => {
    const jsxCode = `
            const Example = () => {
                const count = React.useState(1);
                const [x, setX] = count;
                return count;
            };
        `;

    const ast = parse(jsxCode, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript'],
    });
    const hookAstNodes = getPotentialHookDeclarationsFromAST(ast);
    // This line number corresponds to where the hook is present
    const lineNumber = 3;

    // Isolate the Hook AST Node
    const potentialReactHookASTNode = hookAstNodes.find(
      node =>
        checkNodeLocation(node, lineNumber) && isConfirmedHookDeclaration(node),
    );
    // Find the nodes that are associated with the React Hook found - in this case we obtain the [x, setX] line
    const nodesAssociatedWithReactHookASTNode = getFilteredHookASTNodes(
      potentialReactHookASTNode,
      hookAstNodes,
      'example-app',
      new Map(),
    );

    // Only one node should be found here
    expect(nodesAssociatedWithReactHookASTNode).toHaveLength(1);
    const relatedNode = nodesAssociatedWithReactHookASTNode[0];

    // The [x,setX] destructuring is on line 4
    expect(relatedNode.node.loc.start.line).toBe(4);

    const hookName = getHookVariableName(relatedNode);
    expect(hookName).toBe('x');
    done();
  });

  it('should identify variable names for multiple hooks in one app', async done => {
    const jsxCode = `
        const Example = () => {
            const count = React.useState(1);
            const [x, setX] = count;
            const [count1, setCount1] = useState(0);
            return count;
            };
        `;

    done();
  });
});
