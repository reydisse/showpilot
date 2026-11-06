import type { AnyRoute } from '@tanstack/react-router';

export const ROUTE_LOAD_TIMEOUT_MS = 12_000;

/** A child controller keeps a timeout distinct from a router navigation cancel. */
export function runRouteLoad<T>(
  operation: (controller: AbortController) => T,
  parent?: AbortSignal,
  timeoutMs = ROUTE_LOAD_TIMEOUT_MS,
): Promise<Awaited<T>> {
  const controller = new AbortController();
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (reason: unknown) => {
      reject(reason);
      controller.abort(reason);
    };
    cancel = () => stop(parent?.reason ?? new DOMException('Navigation cancelled', 'AbortError'));
    timer = setTimeout(() => stop(new Error('Page loading timed out.')), timeoutMs);
    if (parent?.aborted) cancel();
    else parent?.addEventListener('abort', cancel, { once: true });
  });
  const result = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return operation(controller);
  });
  // Settling the wrapper also ignores transports/imports that cannot be aborted.
  return Promise.race([result, interrupted]).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
  });
}

// Route definitions are shared by SSR requests. Only wrapper identity is shared;
// controllers, deadlines and results belong to each individual invocation.
const wrapped = new WeakSet<object>();

function boundHook<T extends { abortController: AbortController }, R>(hook: (context: T) => R, timeoutMs: number) {
  if (wrapped.has(hook)) return hook;
  const bounded = (context: T) => runRouteLoad(
    controller => hook({ ...context, abortController: controller }),
    context.abortController.signal,
    timeoutMs,
  );
  wrapped.add(bounded);
  return bounded;
}

function boundOptions(options: Partial<AnyRoute['options']>, timeoutMs: number) {
  if (options.beforeLoad) options.beforeLoad = boundHook(options.beforeLoad, timeoutMs);
  if (typeof options.loader === 'function') options.loader = boundHook(options.loader, timeoutMs);
  else if (options.loader) options.loader = { ...options.loader, handler: boundHook(options.loader.handler, timeoutMs) };

  for (const component of [options.component, options.pendingComponent, options.errorComponent, options.notFoundComponent]) {
    if (!component || !('preload' in component) || typeof component.preload !== 'function' || wrapped.has(component.preload)) continue;
    const preload = component.preload;
    const bounded = () => runRouteLoad(() => preload(), undefined, timeoutMs);
    wrapped.add(bounded);
    component.preload = bounded;
  }
}

/** Apply through public route options, including options loaded by route.lazy(). */
export function installRouteLoadDeadlines(route: AnyRoute, timeoutMs = ROUTE_LOAD_TIMEOUT_MS): void {
  boundOptions(route.options, timeoutMs);
  const lazy = route.lazyFn;
  if (lazy && !wrapped.has(lazy)) {
    const bounded = () => runRouteLoad(async () => {
      const loaded = await lazy();
      boundOptions(loaded.options, timeoutMs);
      return loaded;
    }, undefined, timeoutMs);
    wrapped.add(bounded);
    route.lazyFn = bounded;
  }
  for (const child of route.children ?? []) installRouteLoadDeadlines(child, timeoutMs);
}
