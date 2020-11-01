// @flow

import {createContext} from 'react';
import type {InjectHookVariableNamesFunction} from '../DevTools';

export type Context = {|
    injectHookVariableNamesFunction: InjectHookVariableNamesFunction | null,
  |};

const InjectHookVariableNamesFunctionContext = createContext<Context>(((null: any): Context));
InjectHookVariableNamesFunctionContext.displayName = 'InjectHookVariableNamesFunctionContext';
export default InjectHookVariableNamesFunctionContext;
