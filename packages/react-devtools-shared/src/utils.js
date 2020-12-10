/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import LRU from 'lru-cache';
import {
  isElement,
  typeOf,
  ContextConsumer,
  ContextProvider,
  ForwardRef,
  Fragment,
  Lazy,
  Memo,
  Portal,
  Profiler,
  StrictMode,
  Suspense,
} from 'react-is';
import traverse, { NodePath, Node } from '@babel/traverse';
import { parse } from '@babel/parser';
import {File} from '@babel/types';
import {SourceMapConsumer, BasicSourceMapConsumer, IndexedSourceMapConsumer} from 'source-map';

import {REACT_SUSPENSE_LIST_TYPE as SuspenseList} from 'shared/ReactSymbols';
import {
  TREE_OPERATION_ADD,
  TREE_OPERATION_REMOVE,
  TREE_OPERATION_REORDER_CHILDREN,
  TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
} from './constants';
import {ElementTypeRoot} from 'react-devtools-shared/src/types';
import {
  LOCAL_STORAGE_FILTER_PREFERENCES_KEY,
  LOCAL_STORAGE_SHOULD_BREAK_ON_CONSOLE_ERRORS,
  LOCAL_STORAGE_SHOULD_PATCH_CONSOLE_KEY,
} from './constants';
import {ComponentFilterElementType, ElementTypeHostComponent} from './types';
import {
  ElementTypeClass,
  ElementTypeForwardRef,
  ElementTypeFunction,
  ElementTypeMemo,
} from 'react-devtools-shared/src/types';
import {localStorageGetItem, localStorageSetItem} from './storage';
import {meta} from './hydration';
import type {ComponentFilter, ElementType} from './types';

const cachedDisplayNames: WeakMap<Function, string> = new WeakMap();

// On large trees, encoding takes significant time.
// Try to reuse the already encoded strings.
const encodedStringCache = new LRU({max: 1000});

export function alphaSortKeys(
  a: string | number | Symbol,
  b: string | number | Symbol,
): number {
  if (a.toString() > b.toString()) {
    return 1;
  } else if (b.toString() > a.toString()) {
    return -1;
  } else {
    return 0;
  }
}

export function getAllEnumerableKeys(
  obj: Object,
): Array<string | number | Symbol> {
  const keys = [];
  let current = obj;
  while (current != null) {
    const currentKeys = [
      ...Object.keys(current),
      ...Object.getOwnPropertySymbols(current),
    ];
    const descriptors = Object.getOwnPropertyDescriptors(current);
    currentKeys.forEach(key => {
      // $FlowFixMe: key can be a Symbol https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/getOwnPropertyDescriptor
      if (descriptors[key].enumerable) {
        keys.push(key);
      }
    });
    current = Object.getPrototypeOf(current);
  }
  return keys;
}

export function getDisplayName(
  type: Function,
  fallbackName: string = 'Anonymous',
): string {
  const nameFromCache = cachedDisplayNames.get(type);
  if (nameFromCache != null) {
    return nameFromCache;
  }

  let displayName = fallbackName;

  // The displayName property is not guaranteed to be a string.
  // It's only safe to use for our purposes if it's a string.
  // github.com/facebook/react-devtools/issues/803
  if (typeof type.displayName === 'string') {
    displayName = type.displayName;
  } else if (typeof type.name === 'string' && type.name !== '') {
    displayName = type.name;
  }

  cachedDisplayNames.set(type, displayName);
  return displayName;
}

let uidCounter: number = 0;

export function getUID(): number {
  return ++uidCounter;
}

export function utfDecodeString(array: Array<number>): string {
  return String.fromCodePoint(...array);
}

export function utfEncodeString(string: string): Array<number> {
  const cached = encodedStringCache.get(string);
  if (cached !== undefined) {
    return cached;
  }

  const encoded = new Array(string.length);
  for (let i = 0; i < string.length; i++) {
    encoded[i] = string.codePointAt(i);
  }
  encodedStringCache.set(string, encoded);
  return encoded;
}

export function printOperationsArray(operations: Array<number>) {
  // The first two values are always rendererID and rootID
  const rendererID = operations[0];
  const rootID = operations[1];

  const logs = [`operations for renderer:${rendererID} and root:${rootID}`];

  let i = 2;

  // Reassemble the string table.
  const stringTable = [
    null, // ID = 0 corresponds to the null string.
  ];
  const stringTableSize = operations[i++];
  const stringTableEnd = i + stringTableSize;
  while (i < stringTableEnd) {
    const nextLength = operations[i++];
    const nextString = utfDecodeString(
      (operations.slice(i, i + nextLength): any),
    );
    stringTable.push(nextString);
    i += nextLength;
  }

  while (i < operations.length) {
    const operation = operations[i];

    switch (operation) {
      case TREE_OPERATION_ADD: {
        const id = ((operations[i + 1]: any): number);
        const type = ((operations[i + 2]: any): ElementType);

        i += 3;

        if (type === ElementTypeRoot) {
          logs.push(`Add new root node ${id}`);

          i++; // supportsProfiling
          i++; // hasOwnerMetadata
        } else {
          const parentID = ((operations[i]: any): number);
          i++;

          i++; // ownerID

          const displayNameStringID = operations[i];
          const displayName = stringTable[displayNameStringID];
          i++;

          i++; // key

          logs.push(
            `Add node ${id} (${displayName || 'null'}) as child of ${parentID}`,
          );
        }
        break;
      }
      case TREE_OPERATION_REMOVE: {
        const removeLength = ((operations[i + 1]: any): number);
        i += 2;

        for (let removeIndex = 0; removeIndex < removeLength; removeIndex++) {
          const id = ((operations[i]: any): number);
          i += 1;

          logs.push(`Remove node ${id}`);
        }
        break;
      }
      case TREE_OPERATION_REORDER_CHILDREN: {
        const id = ((operations[i + 1]: any): number);
        const numChildren = ((operations[i + 2]: any): number);
        i += 3;
        const children = operations.slice(i, i + numChildren);
        i += numChildren;

        logs.push(`Re-order node ${id} children ${children.join(',')}`);
        break;
      }
      case TREE_OPERATION_UPDATE_TREE_BASE_DURATION:
        // Base duration updates are only sent while profiling is in progress.
        // We can ignore them at this point.
        // The profiler UI uses them lazily in order to generate the tree.
        i += 3;
        break;
      default:
        throw Error(`Unsupported Bridge operation ${operation}`);
    }
  }

  console.log(logs.join('\n  '));
}

export function getDefaultComponentFilters(): Array<ComponentFilter> {
  return [
    {
      type: ComponentFilterElementType,
      value: ElementTypeHostComponent,
      isEnabled: true,
    },
  ];
}

export function getSavedComponentFilters(): Array<ComponentFilter> {
  try {
    const raw = localStorageGetItem(LOCAL_STORAGE_FILTER_PREFERENCES_KEY);
    if (raw != null) {
      return JSON.parse(raw);
    }
  } catch (error) {}
  return getDefaultComponentFilters();
}

export function saveComponentFilters(
  componentFilters: Array<ComponentFilter>,
): void {
  localStorageSetItem(
    LOCAL_STORAGE_FILTER_PREFERENCES_KEY,
    JSON.stringify(componentFilters),
  );
}

export function getAppendComponentStack(): boolean {
  try {
    const raw = localStorageGetItem(LOCAL_STORAGE_SHOULD_PATCH_CONSOLE_KEY);
    if (raw != null) {
      return JSON.parse(raw);
    }
  } catch (error) {}
  return true;
}

export function setAppendComponentStack(value: boolean): void {
  localStorageSetItem(
    LOCAL_STORAGE_SHOULD_PATCH_CONSOLE_KEY,
    JSON.stringify(value),
  );
}

export function getBreakOnConsoleErrors(): boolean {
  try {
    const raw = localStorageGetItem(
      LOCAL_STORAGE_SHOULD_BREAK_ON_CONSOLE_ERRORS,
    );
    if (raw != null) {
      return JSON.parse(raw);
    }
  } catch (error) {}
  return false;
}

export function setBreakOnConsoleErrors(value: boolean): void {
  localStorageSetItem(
    LOCAL_STORAGE_SHOULD_BREAK_ON_CONSOLE_ERRORS,
    JSON.stringify(value),
  );
}

export function separateDisplayNameAndHOCs(
  displayName: string | null,
  type: ElementType,
): [string | null, Array<string> | null] {
  if (displayName === null) {
    return [null, null];
  }

  let hocDisplayNames = null;

  switch (type) {
    case ElementTypeClass:
    case ElementTypeForwardRef:
    case ElementTypeFunction:
    case ElementTypeMemo:
      if (displayName.indexOf('(') >= 0) {
        const matches = displayName.match(/[^()]+/g);
        if (matches != null) {
          displayName = matches.pop();
          hocDisplayNames = matches;
        }
      }
      break;
    default:
      break;
  }

  if (type === ElementTypeMemo) {
    if (hocDisplayNames === null) {
      hocDisplayNames = ['Memo'];
    } else {
      hocDisplayNames.unshift('Memo');
    }
  } else if (type === ElementTypeForwardRef) {
    if (hocDisplayNames === null) {
      hocDisplayNames = ['ForwardRef'];
    } else {
      hocDisplayNames.unshift('ForwardRef');
    }
  }

  return [displayName, hocDisplayNames];
}

// Pulled from react-compat
// https://github.com/developit/preact-compat/blob/7c5de00e7c85e2ffd011bf3af02899b63f699d3a/src/index.js#L349
export function shallowDiffers(prev: Object, next: Object): boolean {
  for (const attribute in prev) {
    if (!(attribute in next)) {
      return true;
    }
  }
  for (const attribute in next) {
    if (prev[attribute] !== next[attribute]) {
      return true;
    }
  }
  return false;
}

export function getInObject(object: Object, path: Array<string | number>): any {
  return path.reduce((reduced: Object, attr: any): any => {
    if (reduced) {
      if (hasOwnProperty.call(reduced, attr)) {
        return reduced[attr];
      }
      if (typeof reduced[Symbol.iterator] === 'function') {
        // Convert iterable to array and return array[index]
        //
        // TRICKY
        // Don't use [...spread] syntax for this purpose.
        // This project uses @babel/plugin-transform-spread in "loose" mode which only works with Array values.
        // Other types (e.g. typed arrays, Sets) will not spread correctly.
        return Array.from(reduced)[attr];
      }
    }

    return null;
  }, object);
}

export function deletePathInObject(
  object: Object,
  path: Array<string | number>,
) {
  const length = path.length;
  const last = path[length - 1];
  if (object != null) {
    const parent = getInObject(object, path.slice(0, length - 1));
    if (parent) {
      if (Array.isArray(parent)) {
        parent.splice(((last: any): number), 1);
      } else {
        delete parent[last];
      }
    }
  }
}

export function renamePathInObject(
  object: Object,
  oldPath: Array<string | number>,
  newPath: Array<string | number>,
) {
  const length = oldPath.length;
  if (object != null) {
    const parent = getInObject(object, oldPath.slice(0, length - 1));
    if (parent) {
      const lastOld = oldPath[length - 1];
      const lastNew = newPath[length - 1];
      parent[lastNew] = parent[lastOld];
      if (Array.isArray(parent)) {
        parent.splice(((lastOld: any): number), 1);
      } else {
        delete parent[lastOld];
      }
    }
  }
}

export function setInObject(
  object: Object,
  path: Array<string | number>,
  value: any,
) {
  const length = path.length;
  const last = path[length - 1];
  if (object != null) {
    const parent = getInObject(object, path.slice(0, length - 1));
    if (parent) {
      parent[last] = value;
    }
  }
}

export type DataType =
  | 'array'
  | 'array_buffer'
  | 'bigint'
  | 'boolean'
  | 'data_view'
  | 'date'
  | 'function'
  | 'html_all_collection'
  | 'html_element'
  | 'infinity'
  | 'iterator'
  | 'opaque_iterator'
  | 'nan'
  | 'null'
  | 'number'
  | 'object'
  | 'react_element'
  | 'regexp'
  | 'string'
  | 'symbol'
  | 'typed_array'
  | 'undefined'
  | 'unknown';

/**
 * Get a enhanced/artificial type string based on the object instance
 */
export function getDataType(data: Object): DataType {
  if (data === null) {
    return 'null';
  } else if (data === undefined) {
    return 'undefined';
  }

  if (isElement(data)) {
    return 'react_element';
  }

  if (typeof HTMLElement !== 'undefined' && data instanceof HTMLElement) {
    return 'html_element';
  }

  const type = typeof data;
  switch (type) {
    case 'bigint':
      return 'bigint';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'number':
      if (Number.isNaN(data)) {
        return 'nan';
      } else if (!Number.isFinite(data)) {
        return 'infinity';
      } else {
        return 'number';
      }
    case 'object':
      if (Array.isArray(data)) {
        return 'array';
      } else if (ArrayBuffer.isView(data)) {
        return hasOwnProperty.call(data.constructor, 'BYTES_PER_ELEMENT')
          ? 'typed_array'
          : 'data_view';
      } else if (data.constructor && data.constructor.name === 'ArrayBuffer') {
        // HACK This ArrayBuffer check is gross; is there a better way?
        // We could try to create a new DataView with the value.
        // If it doesn't error, we know it's an ArrayBuffer,
        // but this seems kind of awkward and expensive.
        return 'array_buffer';
      } else if (typeof data[Symbol.iterator] === 'function') {
        return data[Symbol.iterator]() === data
          ? 'opaque_iterator'
          : 'iterator';
      } else if (data.constructor && data.constructor.name === 'RegExp') {
        return 'regexp';
      } else {
        const toStringValue = Object.prototype.toString.call(data);
        if (toStringValue === '[object Date]') {
          return 'date';
        } else if (toStringValue === '[object HTMLAllCollection]') {
          return 'html_all_collection';
        }
      }
      return 'object';
    case 'string':
      return 'string';
    case 'symbol':
      return 'symbol';
    case 'undefined':
      if (
        Object.prototype.toString.call(data) === '[object HTMLAllCollection]'
      ) {
        return 'html_all_collection';
      }
      return 'undefined';
    default:
      return 'unknown';
  }
}

export function getDisplayNameForReactElement(
  element: React$Element<any>,
): string | null {
  const elementType = typeOf(element);
  switch (elementType) {
    case ContextConsumer:
      return 'ContextConsumer';
    case ContextProvider:
      return 'ContextProvider';
    case ForwardRef:
      return 'ForwardRef';
    case Fragment:
      return 'Fragment';
    case Lazy:
      return 'Lazy';
    case Memo:
      return 'Memo';
    case Portal:
      return 'Portal';
    case Profiler:
      return 'Profiler';
    case StrictMode:
      return 'StrictMode';
    case Suspense:
      return 'Suspense';
    case SuspenseList:
      return 'SuspenseList';
    default:
      const {type} = element;
      if (typeof type === 'string') {
        return type;
      } else if (typeof type === 'function') {
        return getDisplayName(type, 'Anonymous');
      } else if (type != null) {
        return 'NotImplementedInDevtools';
      } else {
        return 'Element';
      }
  }
}

const MAX_PREVIEW_STRING_LENGTH = 50;

function truncateForDisplay(
  string: string,
  length: number = MAX_PREVIEW_STRING_LENGTH,
) {
  if (string.length > length) {
    return string.substr(0, length) + '…';
  } else {
    return string;
  }
}

// Attempts to mimic Chrome's inline preview for values.
// For example, the following value...
//   {
//      foo: 123,
//      bar: "abc",
//      baz: [true, false],
//      qux: { ab: 1, cd: 2 }
//   };
//
// Would show a preview of...
//   {foo: 123, bar: "abc", baz: Array(2), qux: {…}}
//
// And the following value...
//   [
//     123,
//     "abc",
//     [true, false],
//     { foo: 123, bar: "abc" }
//   ];
//
// Would show a preview of...
//   [123, "abc", Array(2), {…}]
export function formatDataForPreview(
  data: any,
  showFormattedValue: boolean,
): string {
  if (data != null && hasOwnProperty.call(data, meta.type)) {
    return showFormattedValue
      ? data[meta.preview_long]
      : data[meta.preview_short];
  }

  const type = getDataType(data);

  switch (type) {
    case 'html_element':
      return `<${truncateForDisplay(data.tagName.toLowerCase())} />`;
    case 'function':
      return truncateForDisplay(
        `ƒ ${typeof data.name === 'function' ? '' : data.name}() {}`,
      );
    case 'string':
      return `"${data}"`;
    case 'bigint':
      return truncateForDisplay(data.toString() + 'n');
    case 'regexp':
      return truncateForDisplay(data.toString());
    case 'symbol':
      return truncateForDisplay(data.toString());
    case 'react_element':
      return `<${truncateForDisplay(
        getDisplayNameForReactElement(data) || 'Unknown',
      )} />`;
    case 'array_buffer':
      return `ArrayBuffer(${data.byteLength})`;
    case 'data_view':
      return `DataView(${data.buffer.byteLength})`;
    case 'array':
      if (showFormattedValue) {
        let formatted = '';
        for (let i = 0; i < data.length; i++) {
          if (i > 0) {
            formatted += ', ';
          }
          formatted += formatDataForPreview(data[i], false);
          if (formatted.length > MAX_PREVIEW_STRING_LENGTH) {
            // Prevent doing a lot of unnecessary iteration...
            break;
          }
        }
        return `[${truncateForDisplay(formatted)}]`;
      } else {
        const length = hasOwnProperty.call(data, meta.size)
          ? data[meta.size]
          : data.length;
        return `Array(${length})`;
      }
    case 'typed_array':
      const shortName = `${data.constructor.name}(${data.length})`;
      if (showFormattedValue) {
        let formatted = '';
        for (let i = 0; i < data.length; i++) {
          if (i > 0) {
            formatted += ', ';
          }
          formatted += data[i];
          if (formatted.length > MAX_PREVIEW_STRING_LENGTH) {
            // Prevent doing a lot of unnecessary iteration...
            break;
          }
        }
        return `${shortName} [${truncateForDisplay(formatted)}]`;
      } else {
        return shortName;
      }
    case 'iterator':
      const name = data.constructor.name;

      if (showFormattedValue) {
        // TRICKY
        // Don't use [...spread] syntax for this purpose.
        // This project uses @babel/plugin-transform-spread in "loose" mode which only works with Array values.
        // Other types (e.g. typed arrays, Sets) will not spread correctly.
        const array = Array.from(data);

        let formatted = '';
        for (let i = 0; i < array.length; i++) {
          const entryOrEntries = array[i];

          if (i > 0) {
            formatted += ', ';
          }

          // TRICKY
          // Browsers display Maps and Sets differently.
          // To mimic their behavior, detect if we've been given an entries tuple.
          //   Map(2) {"abc" => 123, "def" => 123}
          //   Set(2) {"abc", 123}
          if (Array.isArray(entryOrEntries)) {
            const key = formatDataForPreview(entryOrEntries[0], true);
            const value = formatDataForPreview(entryOrEntries[1], false);
            formatted += `${key} => ${value}`;
          } else {
            formatted += formatDataForPreview(entryOrEntries, false);
          }

          if (formatted.length > MAX_PREVIEW_STRING_LENGTH) {
            // Prevent doing a lot of unnecessary iteration...
            break;
          }
        }

        return `${name}(${data.size}) {${truncateForDisplay(formatted)}}`;
      } else {
        return `${name}(${data.size})`;
      }
    case 'opaque_iterator': {
      return data[Symbol.toStringTag];
    }
    case 'date':
      return data.toString();
    case 'object':
      if (showFormattedValue) {
        const keys = getAllEnumerableKeys(data).sort(alphaSortKeys);

        let formatted = '';
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (i > 0) {
            formatted += ', ';
          }
          formatted += `${key.toString()}: ${formatDataForPreview(
            data[key],
            false,
          )}`;
          if (formatted.length > MAX_PREVIEW_STRING_LENGTH) {
            // Prevent doing a lot of unnecessary iteration...
            break;
          }
        }
        return `{${truncateForDisplay(formatted)}}`;
      } else {
        return '{…}';
      }
    case 'boolean':
    case 'number':
    case 'infinity':
    case 'nan':
    case 'null':
    case 'undefined':
      return data;
    default:
      try {
        return truncateForDisplay('' + data);
      } catch (error) {
        return 'unserializable';
      }
  }
}


// Code added for InjectHookVariableNamesFunction

type HookSource = {
  lineNumber: number | null,
  columnNumber: number | null,
  fileName: string | null,
  functionName: string | null,
}
type HooksNode = {
  id: number | null,
  isStateEditable: boolean,
  name: string,
  value: mixed,
  subHooks: Array<HooksNode>,
  hookSource: HookSource,
  ...
};

type HooksTree = Array<HooksNode>;

type DownloadedFile = {
  data: {
    url: string, 
    text: string
  }
}

type SourceConsumer = BasicSourceMapConsumer | IndexedSourceMapConsumer;

type SourceFileASTWithHookDetails = {
  sourceFileAST: File, 
  line: number,
  source: string
};

type FileMappings = Map <string, string>;

const AST_NODE_TYPES = Object.freeze({
  CALL_EXPRESSION: 'CallExpression',
  MEMBER_EXPRESSION: 'MemberExpression',
  ARRAY_PATTERN: 'ArrayPattern',
  IDENTIFIER: 'Identifier',
  NUMERIC_LITERAL: 'NumericLiteral'
})

/**
 * Used to obtain the source filenames of Hooks
 * @param {HooksTree} hookLog The hook tree returned by the React Application 
 * @returns {string[]} Filenames
 */
function getUniqueFileNames(hookLog: HooksTree): string[] {
  if (hookLog.length <= 0) {
    return []
  }

  let uniqueFileNames: Set<string> = new Set()
  hookLog.forEach(({hookSource, subHooks}) => {
    const {fileName} = hookSource
    if (fileName) {
      uniqueFileNames.add(fileName)
    }

    if (subHooks.length > 0) {
      uniqueFileNames = new Set([...uniqueFileNames, ...getUniqueFileNames(subHooks)])
    }
  })
  return Array.from(uniqueFileNames)
}

/**
 * Perform a GET request on the URL and return a promise of type DownloadedFile
 * @param {string} url
 * @returns Promisfied URL and its contents
 */
function fetchFile(url: string): Promise<DownloadedFile> {
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
};


/**
 * Check if the URL is a valid one
 * @param {string} possibleURL Url to check
 * @returns {boolean} Is the URL indeed a valid URL
 */
function isValidUrl(possibleURL: string): boolean {
  try {
    new URL(possibleURL);
  } catch (_) {
    return false;  
  }
  return true;
}

/**
 * Obtain the source map URL given the file contents and the url of the file
 * @param {string} url 
 * @param {string} urlResponse 
 */
function getSourceMapURL(url: string, urlResponse: string): string {
  const sourceMappingUrlRegExp = /\/\/[#@] ?sourceMappingURL=([^\s'"]+)\s*$/mg
  const sourceMappingURLInArray = urlResponse.match(sourceMappingUrlRegExp);
  if (sourceMappingURLInArray && sourceMappingURLInArray.length > 1) {
    // More than one source map URL cannot be detected
    throw new Error('More than source map detected in the source file') 
  }
  // The match will look like sourceMapURL=main.chunk.js, so we want the second element
  const sourceMapURL = sourceMappingURLInArray[0].split('=')[1];
  const baseURL = url.slice(0, url.lastIndexOf('/'));
  const completeSourceMapURL = `${baseURL}/${sourceMapURL}`;
  if (!isValidUrl(completeSourceMapURL)) {
    throw new Error('Invalid URL created')
  }
  return completeSourceMapURL
};


/**
 * TODO: Bundle WASM in extension static files and use those instead of versioned URLs
 */
function initialiseSourceMaps() {
  const wasmFileName = 'mappings.wasm'
  const wasmMappingsURL = chrome.extension.getURL(wasmFileName);
  SourceMapConsumer.initialize({ 'lib/mappings.wasm': wasmMappingsURL });
}

/**
 * Add the variable names by parsing source maps
 * @param {HookTree} hookLog The hook tree returned by the React Application 
 * @param {*} sourceMaps SourceMaps of all the files referenced in the hookLog
 */
function modifyHooksToAddVariableNames(hookLog: HooksTree, sourceMaps: DownloadedFile[], sourceMapUrls: FileMappings, sourceFileUrls: FileMappings): Promise<HooksTree> {
  initialiseSourceMaps()

  // For each sourceMapFile, we can now obtain the 
  return Promise.all(sourceMaps.map(sourceMap => {
    // Obtain contents and URL of the source map
    const { url, text } = sourceMap.data;
    const sourceMapAsJSON = JSON.parse(text);

    // This map consists of all the AST Nodes that COULD be hooks
    const potentialHooksOfFile: Map<string, Array<NodePath>> = new Map();
    const astForSourceFiles: Map<string, File> = new Map();

    return SourceMapConsumer.with(sourceMapAsJSON, null, (consumer: SourceConsumer) => {
      const sourceUrl = sourceFileUrls.get(url);
      if (!sourceUrl) {
        throw new Error(`Could not find source url for the map url ${url}`)
      }
      // TODO: We need to recursively obtain all the hooks in the
      const relevantHooks = getRelevantHooksForFile(hookLog, sourceUrl);
      return relevantHooks.map((hook) => {
        const {id} = hook;
        const isCustomHook = id === null;

        const {lineNumber, columnNumber} = hook.hookSource;
        if (!(lineNumber && columnNumber)) {
          throw new Error(`Line and Column Numbers could not be found for hook`)
        }
        const {sourceFileAST, line, source} = getASTFromSourceFile(consumer, lineNumber, columnNumber, astForSourceFiles);
        
        let potentialHooksFound: NodePath[] = potentialHooksOfFile.get(source) || [];

        if (!(potentialHooksFound && potentialHooksFound.length > 0)) {
          potentialHooksFound = getPotentialHookDeclarationsFromAST(sourceFileAST);

          // TODO: handle mismatch in number of hooks (conditional hook case?) - Cannot check relevantHooks.length count to match
          // as relevantHooks point to hooks for min file 'main.chunk.js' while hookDeclarationCount points to hooks of source file 'App.js'
          // const hookDeclarationsCount = getHookDeclarationsCountInFile(potentialHooksFound);
          // if (relevantHooks.length !== hookDeclarationsCount) {
          //   // throw error, escape the promise chain
          //   throw new Error('Hooks found in source do not match hooks found in component');
          // }
          // hash potentialHooks array for current source to prevent parsing in following iterations
          potentialHooksOfFile.set(source, potentialHooksFound);
        }

        // Iterate through potential hooks and try to find the current hook.
        // potentialReactHookASTNode will contain declarations of the form const X = useState(0);
        // where X could be an identifier or an array pattern (destructuring syntax)
        const potentialReactHookASTNode: NodePath = potentialHooksFound
          .find(node => checkNodeLocation(node, line) && isConfirmedHookDeclaration(node));

        if (!potentialReactHookASTNode) {
          // Custom hooks and primitive hooks that aren't assigned any variables, don't have any corresponding AST nodes
          if (!isCustomHook && !isNonDeclarativePrimitiveHook(hook)) {
            throw new Error(`No Potential React Hook found at line ${line}`);
          }
          if (isCustomHook) {
            // If the customHook is not assigned to any variable, its variable declarator AST node also cannot be found.
            // For such cases, we inject variable names for subhooks.
            injectSubHooksWithVariableNames(hook, sourceMaps, sourceMapUrls, sourceFileUrls);
          }
          // Return original hook object for primitive and custom hooks that are not assigned to any variables.
          // eg. useEffect, useLayoutEffect etc.
          return hook;
        }

        // nodesAssociatedWithReactHookASTNode could directly be a used to obtain the hook variable name
        // depending on the type of potentialReactHookASTNode
        try {
          const nodesAssociatedWithReactHookASTNode: NodePath[] = getFilteredHookASTNodes(potentialReactHookASTNode, potentialHooksFound, source, potentialHooksOfFile);

          const newHook: HooksNode = getHookNodeWithInjectedVariableName(hook, nodesAssociatedWithReactHookASTNode, potentialReactHookASTNode);
          
          if (newHook.subHooks.length > 0) {
          // Inject variable names recursively in sub hooks
            injectSubHooksWithVariableNames(newHook, sourceMaps, sourceMapUrls, sourceFileUrls);
          }
          return newHook;

        } catch (e) {
          console.log('error: ', e, ' hook: ', hook);
          return hook;
        }
      });
    });
  }));
}



/**
 * Catch all identifiers that begin with "use" followed by an uppercase Latin
 * character to exclude identifiers like "user".
 * 
 * @param{string} name
 * @return {boolean}
 */
function isHookName(name: string): boolean {
  return /^use[A-Z0-9].*$/.test(name);
}

/**
 * We consider hooks to be a hook name identifier or a member expression
 * containing a hook name.
 * 
 * @param {Node} node
 * @return {boolean}
 */
function isHook(node: Node): boolean {
  if (node.type === AST_NODE_TYPES.IDENTIFIER) {
    return isHookName(node.name);
  } else if (
    node.type === AST_NODE_TYPES.MEMBER_EXPRESSION &&
    !node.computed &&
    isHook(node.property)
  ) {
    const obj = node.object;
    const isPascalCaseNameSpace = /^[A-Z].*/;
    return obj.type === AST_NODE_TYPES.IDENTIFIER && isPascalCaseNameSpace.test(obj.name);
  } else {
    return false;
  }
}

/**
 * Check whether 'node' is hook decalration of form useState(0); OR React.useState(0);
 *
 * @param {Node} node
 * @param {string} functionName
 * @return {boolean}
 */
function isReactFunction(node: Node, functionName: string): boolean {
  return (
    node.name === functionName ||
    (node.type === 'MemberExpression' &&
      node.object.name === 'React' &&
      node.property.name === functionName)
  );
}

/**
 * Returns an AST for the source file contents
 *
 * @param {string} fileContents
 * @return {*} 
 */
function getASTFromSourceFileContents(fileContents: string) {
  return parse(fileContents, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript']});
}

/**
 * Check if 'path' contains declaration of the form const X = useState(0);
 *
 * @param {NodePath} path
 * @return {boolean}
 */
function isConfirmedHookDeclaration(path: NodePath): boolean {
  const node = path.node.init;
  if (node.type !== AST_NODE_TYPES.CALL_EXPRESSION) {
    return false;
  }
  const callee = node.callee;
  return isHook(callee);
}

/**
 * Check if line number obtained from source map and the line number in hook node match
 * 
 * @param {NodePath} path AST NodePath
 * @param {number} line The line number provided by source maps
 */
function checkNodeLocation(path: NodePath, line: number): boolean {
  const locationOfNode = path.node.loc;
  return (line === locationOfNode.start.line);
}

/**
 * Check if 'path' is either State or Reducer hook
 * 
 * @param {NodePath} path
 * @return {boolean}
 */
function isStateOrReducerHook(path: NodePath): boolean { 
  const callee = path.node.init.callee;
  return isReactFunction(callee, 'useState') ||
    isReactFunction(callee, 'useReducer');
}

/**
 * Used to calculate the possible number of hooks in a File
 * 
 * @param {NodePath[]} potentialHooks AST nodes that COULD be React Hooks
 * @return {number}
 */
function getHookDeclarationsCountInFile(potentialHooks: NodePath[]): number {
  let hookDeclarationsCount = 0;
  potentialHooks.forEach(path => {
    if (
      path.node.init.type === AST_NODE_TYPES.CALL_EXPRESSION &&
      isHook(path.node.init.callee)
    ) {
      hookDeclarationsCount += 1;
    }
  });
  return hookDeclarationsCount;
}

/**
 * @param {File} sourceAST
 * @return {NodePath[]}
 */
function getPotentialHookDeclarationsFromAST(sourceAST: File): NodePath[] {
  const potentialHooksFound: NodePath[] = [];
  traverse(sourceAST, {
    enter(path) {
      if (
          path.isVariableDeclarator() &&
          isPotentialHookDeclaration(path)
      ) {
          potentialHooksFound.push(path);
      }
    }
  });
  return potentialHooksFound;
}

/**
 * Check if the AST Node COULD be a React Hook
 * 
 * @param {NodePath} path An AST Node
 * @return {boolean}
 */
function isPotentialHookDeclaration(path: NodePath): boolean {
  // The array potentialHooksFound will contain all potential hook declaration cases we support
  const nodePathInit = path.node.init;
  if (nodePathInit.type === AST_NODE_TYPES.CALL_EXPRESSION) {
    // CASE: CallExpression
    // 1. const [count, setCount] = useState(0); -> destructured pattern
    // 2. const [A, setA] = useState(0), const [B, setB] = useState(0); -> multiple inline declarations
    // 3. const [
    //      count,
    //      setCount
    //    ] = useState(0); -> multiline hook declaration
    // 4. const ref = useRef(null); -> generic hooks
    const callee = nodePathInit.callee;
    return isHook(callee);
  } else if (
    nodePathInit.type === AST_NODE_TYPES.MEMBER_EXPRESSION ||
    nodePathInit.type === AST_NODE_TYPES.IDENTIFIER
  ) {
    // CASE: MemberExpression
    //    const countState = React.useState(0);
    //    const count = countState[0];
    //    const setCount = countState[1]; -> Accessing members following hook declaration

    // CASE: Identifier
    //    const countState = React.useState(0);
    //    const [count, setCount] = countState; ->  destructuring syntax following hook declaration
    return true;
  }
  return false;
}

/**
 * Determines whether incoming hook is a primitive hook that gets assigned to variables.
 *
 * @param {HooksNode} hook - Original hook object
 * @return {boolean} - Returns true for primitive hooks that are not assigned to variables.
 */
function isNonDeclarativePrimitiveHook(hook: HooksNode) {
  return ['Effect', 'ImperativeHandle', 'LayoutEffect', 'DebugValue'].includes(hook.name);
}

/**
 * Check whether hookNode of a declaration contains obvious variable name
 * 
 * @param {NodePath} hookNode 
 * @return {boolean}
 */
function nodeContainsHookVariableName(hookNode: NodePath): boolean {
  // We determine cases where variable names are obvious in declarations. Examples:
  // const [tick, setTick] = useState(1); OR const ref = useRef(null);
  // Here tick/ref are obvious hook variables in the hook declaration node itself
  // 1. True for satisfying above cases
  // 2. False for everything else. Examples:
  //    const countState = React.useState(0);
  //    const count = countState[0];
  //    const setCount = countState[1]; -> not obvious, hook variable can't be determined
  //                                       from the hook declaration node alone
  // 3. For custom hooks we force pass true since we are only concerned with the AST node 
  //    regardless of how it is accessed in source code. (See: getHookVariableName)

    const node = hookNode.node.id;
    if (
      (
        node.type === AST_NODE_TYPES.ARRAY_PATTERN
      ) || (
        node.type === AST_NODE_TYPES.IDENTIFIER &&
        !isStateOrReducerHook(hookNode)
      )
    ) {
        return true;
    }
    return false;
}

/**
 * Returns all AST Nodes associated with 'potentialReactHookASTNode'
 *
 * @param {NodePath} potentialReactHookASTNode
 * @param {NodePath[]} potentialHooksFound
 * @param {string} source
 * @param {Map<string, Array<NodePath>>} potentialHooksOfFile
 * @return {NodePath[]}  nodesAssociatedWithReactHookASTNode
 */
function getFilteredHookASTNodes(potentialReactHookASTNode: NodePath, potentialHooksFound: NodePath[], source: string, potentialHooksOfFile: Map<string, Array<NodePath>>): NodePath[] {
  // Remove targetHook from potentialHooks array since its purpose is served. 
  // Also to clean the potentialHooks array for further filtering member nodes down the line.
  const hookIdx = potentialHooksFound.indexOf(potentialReactHookASTNode);
  if (hookIdx !== -1) {
    potentialHooksFound.splice(hookIdx, 1);
    potentialHooksOfFile.set(source, potentialHooksFound);
  }

  let nodesAssociatedWithReactHookASTNode: NodePath[] = [];
  if (nodeContainsHookVariableName(potentialReactHookASTNode)) { // made custom hooks to enter this, always
    // Case 1.
    // Directly usable Node -> const ref = useRef(null);
    //                      -> const [tick, setTick] = useState(1);
    // Case 2.
    // Custom Hooks -> const someVariable = useSomeCustomHook();
    //              -> const [someVariable, someFunction] = useAnotherCustomHook();
    nodesAssociatedWithReactHookASTNode.unshift(potentialReactHookASTNode);
  } else {
    // Case 3.
    // Indirectly usable Node -> const tickState = useState(1);
    //                           [tick, setTick] = tickState;
    //                        -> const tickState = useState(1);
    //                           const tick = tickState[0];
    //                           const setTick = tickState[1];
    nodesAssociatedWithReactHookASTNode = potentialHooksFound
      .filter(hookNode => filterMemberNodesOfTargetHook(potentialReactHookASTNode, hookNode));
  }
  return nodesAssociatedWithReactHookASTNode;
}

/**
 * checks whether hookNode is a member of targetHookNode
 *
 * @param {NodePath} targetHookNode
 * @param {NodePath} hookNode
 * @return {boolean} 
 */
function filterMemberNodesOfTargetHook(targetHookNode: NodePath, hookNode: NodePath): boolean {
    const targetHookName = targetHookNode.node.id.name;
    return targetHookName === hookNode.node.init.object?.name ||
        targetHookName === hookNode.node.init.name;
}

/**
 * Returns Hook Node with injected variable name
 *
 * @param {HooksNode} originalHook
 * @param {NodePath[]} nodesAssociatedWithReactHookASTNode
 * @param {NodePath} potentialReactHookASTNode
 * @return {HooksNode} new hook with variable name injected
 */
function getHookNodeWithInjectedVariableName(originalHook: HooksNode, nodesAssociatedWithReactHookASTNode: NodePath[], potentialReactHookASTNode: NodePath): HooksNode {
  let hookVariableName: string | null;
  const isCustomHook = originalHook.id === null;

  switch (nodesAssociatedWithReactHookASTNode.length) {
    case 1:
      // CASE 1A (nodesAssociatedWithReactHookASTNode[0] !== potentialReactHookASTNode): 
      // const flagState = useState(true); -> later referenced as 
      // const [flag, setFlag] = flagState;
      //
      // CASE 1B (nodesAssociatedWithReactHookASTNode[0] === potentialReactHookASTNode):
      // const [flag, setFlag] = useState(true); -> we have access to the hook variable straight away
      //
      // CASE 1C (isCustomHook && nodesAssociatedWithReactHookASTNode[0] === potentialReactHookASTNode):
      // const someVariable = useSomeCustomHook(); -> we have access to hook variable straight away
      // const [someVariable, someFunction] = useAnotherCustomHook(); -> we ignore variable names in this case
      //                                                                 as it is unclear what variable name to show
      if (
        isCustomHook &&
        (nodesAssociatedWithReactHookASTNode[0] === potentialReactHookASTNode)
      ) {
        hookVariableName = getHookVariableName(potentialReactHookASTNode, isCustomHook);
        break;
      }
      hookVariableName = getHookVariableName(nodesAssociatedWithReactHookASTNode[0]);
      break;
  
    case 2:
      // const flagState = useState(true); -> later referenced as 
      // const flag = flagState[0];
      // const setFlag = flagState[1];
      nodesAssociatedWithReactHookASTNode = nodesAssociatedWithReactHookASTNode
        .filter(hookPath => filterMemberWithHookVariableName(hookPath));
      
      if (nodesAssociatedWithReactHookASTNode.length !== 1) {
        // Something went wrong, only a single desirable hook should remain here
        throw new Error('Couldn\'t isolate AST Node containing hook variable.');
      }
      hookVariableName = getHookVariableName(nodesAssociatedWithReactHookASTNode[0]);
      break;
    
    default:
      // Case 0:
      // const flagState = useState(true); -> which is not accessed anywhere
      //
      // Case > 2 (fallback):
      // const someState = React.useState(() => 0)
      //
      // const stateVariable = someState[0]
      // const setStateVariable = someState[1]
      //
      // const [number2, setNumber2] = state
      //
      // We assign the state variable for 'someState' to multiple variables,
      // and hence cannot isolate a unique variable name. In such cases,
      // default to showing 'someState'

      hookVariableName = getHookVariableName(potentialReactHookASTNode);
      break;
  }

  return {...originalHook, hookVariableName};
}

/**
 * Calls modifyHooksToAddVariableNames for sub hooks of the hook node passed as argument and injects variable names in sub hook nodes
 *
 * @param {HooksTree} hook
 * @param {DownloadedFile[]} sourceMaps
 * @param {FileMappings} sourceMapUrls
 * @param {FileMappings} sourceFileUrls
 */
function injectSubHooksWithVariableNames(hook: HooksTree, sourceMaps: DownloadedFile[], sourceMapUrls: FileMappings, sourceFileUrls: FileMappings): void {
  modifyHooksToAddVariableNames(hook.subHooks, sourceMaps, sourceMapUrls, sourceFileUrls)
    .then((subHooksLog: HooksTree) => {
      const modifiedSubHooks: HooksNode[] = [];
      subHooksLog.forEach(subHook => modifiedSubHooks.push(...subHook));
      hook.subHooks = modifiedSubHooks;
    })
}

/**
 * Checks whether hook is the first member node of a state variable declaration node
 *
 * @param {NodePath} hook The AST Node Path for the concerned hook
 * @return {boolean}
 */
function filterMemberWithHookVariableName(hook: NodePath): boolean {
    return hook.node.init.property.type === AST_NODE_TYPES.NUMERIC_LITERAL &&
        hook.node.init.property.value === 0;
}

/**
 * Extracts the variable name from hook node path
 *
 * @param {NodePath} hook The AST Node Path for the concerned hook
 * @return {string} The variable name to be injected 
 */
function getHookVariableName(hook: NodePath, isCustomHook: boolean = false): string {
    const nodeType = hook.node.id.type;
    switch (nodeType) {
      case AST_NODE_TYPES.ARRAY_PATTERN:
        return !isCustomHook ? hook.node.id.elements[0].name : '';

      case AST_NODE_TYPES.IDENTIFIER:
        return hook.node.id.name;
    
      default:
        throw new Error(`Invalid node type: ${nodeType}`);
    }
}


/**
 * Returns all the hooks with a common source URL
 * 
 * @param {HooksTree} hookLog The hook tree returned by the React Application 
 * @param {string} sourceUrl Filename to compare to
 */
function getRelevantHooksForFile(hookLog: HooksTree, sourceUrl: string): HooksNode[] {
  // TODO: Should we be processing flat nodes rather than nested nodes? 
  // If so, what can be a method to recreate the hookLog given this flat nodes structure (see CustomHook case)
  if (hookLog.length <= 0) {
    return [];
  }
  const relevantHooks: HooksNode[] = [];
  hookLog.forEach((hook) => {
    const {hookSource} = hook;
    if (hookSource.fileName && hookSource.fileName === sourceUrl) {
      relevantHooks.push(hook)
    }
  })
  return relevantHooks;
};

/**
 * Provides the AST of the hook's source file
 * 
 * @param {SourceMapConsumer} consumer An object provided by the 'source-map' library to read source maps
 * @param {number} lineNumber The line number given in the hook source
 * @param {number} columnNumber The column number given in the hook source
 * @param {Map<string, File>} astCache Cache of ASTs of a file with source as key
 */
function getASTFromSourceFile(consumer: SourceConsumer, lineNumber: number, columnNumber: number, astCache: Map<string, File>): SourceFileASTWithHookDetails {
  // A check added to prevent parsing large files
  const FAIL_SAFE_CHECK = 100000;
  
  const { line, source } = consumer.originalPositionFor({line: lineNumber, column: columnNumber});

  if (line > FAIL_SAFE_CHECK) {
    throw new Error(`Source File: ${source} is too big`)
  }

  if (astCache.has(source)) {
    const sourceFileAST = astCache.get(source)
    return {line, source, sourceFileAST};
  }
  const sourceFileContent = consumer.sourceContentFor(source, true);
  const sourceFileAST = getASTFromSourceFileContents(sourceFileContent);
  return {line, source, sourceFileAST};
};

/**
 * Shallow merge the names of the variables with the old hook log
 * @param {HooksTree} oldHookLog Hooklog without the variable names
 * @param {HooksTree} newHookLog Hooklog with variable names
 */
export function mergeVariableNamesIntoHookLog(oldHookLog: HooksTree, newHookLog: HooksTree): void {
  oldHookLog.forEach((hook, idx) => {
    const modifiedHookFromNewHookLog = newHookLog[idx];
    if (hook.id === modifiedHookFromNewHookLog.id) {
      hook.hookVariableName = modifiedHookFromNewHookLog.hookVariableName;
      if (hook.subHooks.length > 0 && hook.subHooks.length === modifiedHookFromNewHookLog.subHooks.length) {
        mergeVariableNamesIntoHookLog(hook.subHooks, modifiedHookFromNewHookLog.subHooks)
      }
    }
  })
};

export function injectHookVariableNamesFunction(hookLog: HooksTree): Promise<HooksTree> {
  console.log('injectHookVariableNamesFunction called with', hookLog);
  const uniqueFilenames = getUniqueFileNames(hookLog);
  
  // To create a one-to-one mapping b/w source map URLs and source file URLs.
  const sourceMapURLs = new Map();
  const sourceFileURLs = new Map();
  // Obtain source content of all the unique files
  return Promise.all(
    uniqueFilenames.map((fileName) => fetchFile(fileName))
  )
  .then((downloadedFiles) => {
    downloadedFiles.forEach((file) => {
      const {url, text} = file.data;
      const sourceMapURL = getSourceMapURL(url, text);
      sourceMapURLs.set(url, sourceMapURL);
      sourceFileURLs.set(sourceMapURL, url);
    });
    
    return Promise.all(
      Array.from(sourceMapURLs.values()).map(fetchFile)
    );
  })
  .then((sourceMaps) => modifyHooksToAddVariableNames(
      hookLog, sourceMaps, sourceMapURLs, sourceFileURLs
    ))
  .then(data => {
    const newHookLog = []
    data.forEach((hooksOfBundledFile) => {
      newHookLog.push(...hooksOfBundledFile)
    })
    return newHookLog
  })
  .catch(e => {
    if (__DEV__) {
      console.warn(e);
    }
    return Promise.resolve(hookLog);
  });
}
