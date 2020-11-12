/* global chrome */
// import { NodePath } from "@babel/core";

const IS_CHROME = navigator.userAgent.indexOf('Firefox') < 0;

export type BrowserName = 'Chrome' | 'Firefox';

export function getBrowserName(): BrowserName {
  return IS_CHROME ? 'Chrome' : 'Firefox';
}

export type BrowserTheme = 'dark' | 'light';

export function getBrowserTheme(): BrowserTheme {
  if (IS_CHROME) {
    // chrome.devtools.panels added in Chrome 18.
    // chrome.devtools.panels.themeName added in Chrome 54.
    return chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';
  } else {
    // chrome.devtools.panels.themeName added in Firefox 55.
    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/devtools.panels/themeName
    if (chrome.devtools && chrome.devtools.panels) {
      switch (chrome.devtools.panels.themeName) {
        case 'dark':
          return 'dark';
        default:
          return 'light';
      }
    }
  }
}

// TODO: JSDOC for utils below

/**
* url: url to fetch
* text: stringified response of fetch()
*/
export function fetchFileFromURL(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    fetch(url).then((res) => {
      if (res.ok) {
        res.text().then((text) => {
          resolve({data: {
            url, text
          }})
        }).catch((err) => {
          reject(null)
        })
      } else {
        reject(null)
      }
    })
  })
}

function isValidUrl(possibleURL) {
  try {
    new URL(possibleURL);
  } catch (_) {
    return false;  
  }
  return true;
}

export function getSourceMapURL(url: string, urlResponse: string): string {
  const sourceMappingUrlRegExp = /\/\/[#@] ?sourceMappingURL=([^\s'"]+)\s*$/mg
  const sourceMappingURLInArray = urlResponse.match(sourceMappingUrlRegExp);
  if (sourceMappingURLInArray.length > 1) {
    // More than one source map URL cannot be detected
    return; 
  }
  // The match will look like sourceMapURL=main.chunk.js, so we want the second element
  const sourceMapURL = sourceMappingURLInArray[0].split('=')[1];
  const baseURL = url.slice(0, url.lastIndexOf('/'));
  const completeSourceMapURL = `${baseURL}/${sourceMapURL}`;
  if (isValidUrl(completeSourceMapURL)) {
    return completeSourceMapURL;
  }
}

export function presentInHookSpace(nodePath: NodePath, lineNumber: number, columnNumber: number): boolean {
  const bufferLineSpace = 0;
  const locationOfNode = nodePath.node.loc;
  console.log(lineNumber, locationOfNode);
  return (locationOfNode.start.line >= (lineNumber-bufferLineSpace) && locationOfNode.end.line <= (lineNumber+bufferLineSpace));
}

export function isHookDeclaration(path, supportedHooks) {
  const nodePathInit = path.node.init;
  if (nodePathInit.type === 'CallExpression') {
    const callee = nodePathInit.callee;

    if (callee.type === 'Identifier') {
      return supportedHooks.includes(callee.name);
    } else if (callee.type === 'MemberExpression') {
      return callee.object.name === 'React' && supportedHooks.includes(callee.property.name);
    }
  } else if (nodePathInit.type === 'MemberExpression') {
    return true;
  }
  return false;
}

export function nodePathIdType(path) {
  return path.node.id.type;
}

export function nodePathInitType(path) {
  return path.node.init.type;
}

export function isReactHook(path, supportedHooks) {
  const pathInitType = nodePathInitType(path);

  if (pathInitType !== 'CallExpression') {
    return false;
  }
  const callee = path.node.init.callee;
  
  if (callee.type === 'Identifier') {
    return supportedHooks.includes(callee.name);
  } else if (callee.type === 'MemberExpression') {
    return callee.object.name === 'React' && supportedHooks.includes(callee.property.name);
  }
  return false;
}

export function nodeLocation(path, line) {
  return (line === path.node.loc.start.line);
}

export function isStateOrReducerHook(path) {
  const sampleSpace = ['useState', 'useReducer'];
  const callee = path.node.init.callee;
  
  if (callee.type === 'Identifier') {
    return sampleSpace.includes(callee.name);
  } else if (callee.type === 'MemberExpression') {
    return callee.object.name === 'React' && sampleSpace.includes(callee.property.name);
  }
  return false; 
}
