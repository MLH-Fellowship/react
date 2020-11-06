/* global chrome */

// const fs = require('fs-extra');
// const readline = require('readline');

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

/**
 * Util to read file as stream and resolve the desired line number.
 * Redundant, doesn't work in its current state.
 */
export function extractLinefromSourceFile(
  lineNumber: number,
  filepath: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    let cursor = 0
    const inputStream = fs.createReadStream(filepath)
    const lineReader = readline.createInterface({ inputStream })

    lineReader.on('line', function(line) {
      if (cursor++ === lineNumber) {
        lineReader.close()
        inputStream.close()
        resolve(line)
      }
    })
    lineReader.on('error', reject)
    inputStream.on('end', function() {
      reject(new RangeError(
        `Line ${lineNumber} doesn't exist in ${filepath}`
      ))
    })
  })
}

export function parseLine(line: string): string {
  const whitespaceRegex = /^\s+|\s+$/g;
  return line.replace(whitespaceRegex, '');
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
