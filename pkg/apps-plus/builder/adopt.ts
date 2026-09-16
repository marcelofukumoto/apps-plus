// Making a Vue app of our own behave like a page of the dashboard's.
//
// Two things this extension mounts outlive every page and so cannot be part of one: the builder
// drawer and the page-mark overlay. Each is its own `createApp` on `document.body`, and an app
// created that way knows nothing - no `t()`, no `$store`, no `$router`, and every shell
// component an unknown tag. So it borrows the dashboard's.
//
// Shared by both because getting it wrong is invisible until something specific breaks. The
// mixins are the case in point: without them a component of ours renders, and a *shell*
// component with a Nuxt-style `fetch()` - which is most of the edit pages - dies on
// `$fetchState.pending`, because `$fetchState` is supplied by a global mixin the dashboard
// installs and nothing else does.

/** The dashboard's own Vue app, or null before it has mounted. */
export function dashboardApp(): any {
  return (document.querySelector('#app') as any)?.__vue_app__ || null;
}

/**
 * Copy the dashboard's context onto an app: its components, directives, injections, global
 * mixins and globals. Answers whether there was a dashboard to copy from.
 */
export function adoptDashboardContext(app: any): boolean {
  const host = dashboardApp();

  if (!host) {
    return false;
  }

  Object.assign(app._context.components, host._context.components);
  Object.assign(app._context.directives, host._context.directives);
  Object.assign(app._context.provides, host._context.provides);
  app._context.mixins = [...host._context.mixins];
  Object.defineProperties(
    app.config.globalProperties,
    Object.getOwnPropertyDescriptors(host.config.globalProperties),
  );

  return true;
}
