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

export function fetchFileFromURL(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    fetch(url).then((res) => {
      if (res.ok) {
        res.text().then((text) => {
          resolve(text)
        }).catch((err) => {
          reject(null)
        })
      } else {
        reject(null)
      }
    })
  })
}

export function isValidUrl(possibleURL) {
  try {
    new URL(possibleURL);
  } catch (_) {
    return false;  
  }
  return true;
}

// type Details = {
//   line: number, 
//   column: number,
//   source: string
// }

// export function presentInHookSpace(nodePath: NodePath, details: Details): boolean {
//   const bufferLineSpace = 1
//   const {line} = details
//   const locationOfNode = nodePath.node.loc
//   return locationOfNode.start.line >= (line-bufferLineSpace) && locationOfNode.end.line <= (line+bufferLineSpace)
// }