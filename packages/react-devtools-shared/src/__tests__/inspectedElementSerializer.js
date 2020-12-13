function serializeHookSourceFileNames(hooks) {
  if (!hooks.length) return
  hooks.forEach(hook => {
    if (!hook.hookSource) return
    const filename = hook.hookSource.fileName
    const truncateIdx = filename.lastIndexOf('/react-devtools-shared/')
    hook.hookSource.fileName = filename.substring(truncateIdx + 1)
    if (hook.subHooks && hook.subHooks.length)
      serializeHookSourceFileNames(hook.subHooks)
  })
}

// test() is part of Jest's serializer API
export function test(maybeInspectedElement) {
  if (
    maybeInspectedElement !== null &&
    typeof maybeInspectedElement === 'object' &&
    maybeInspectedElement.hasOwnProperty('hooks') &&
    maybeInspectedElement.hooks != null
  )
    serializeHookSourceFileNames(maybeInspectedElement.hooks)
  return (
    maybeInspectedElement !== null &&
    typeof maybeInspectedElement === 'object' &&
    maybeInspectedElement.hasOwnProperty('canEditFunctionProps') &&
    maybeInspectedElement.hasOwnProperty('canEditHooks') &&
    maybeInspectedElement.hasOwnProperty('canToggleSuspense') &&
    maybeInspectedElement.hasOwnProperty('canViewSource')
  );
}

// print() is part of Jest's serializer API
export function print(inspectedElement, serialize, indent) {
  return JSON.stringify(
    {
      id: inspectedElement.id,
      owners: inspectedElement.owners,
      context: inspectedElement.context,
      events: inspectedElement.events,
      hooks: inspectedElement.hooks,
      props: inspectedElement.props,
      state: inspectedElement.state,
    },
    null,
    2,
  );
}
