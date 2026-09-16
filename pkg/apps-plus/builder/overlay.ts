// Mounting the builder drawer, and giving Rancher's layout back the room it takes.
//
// The drawer has to outlive every page, so it cannot be part of any of them. It is its own Vue
// app on `document.body`, built once and told to open and close - the same arrangement the
// Extension Studio's terminal uses, and for the same reason: there is no slot in the dashboard
// to put a persistent panel in.
//
// It adopts the dashboard's Vue context rather than standing one up, so that `t()`, the store
// and every registered component work inside it exactly as they do on a page. Constructing a
// second store would give a panel that renders and knows about nobody.

import { createApp } from 'vue';
import BuilderPanel from '../components/BuilderPanel.vue';
import { builder } from './state';
import { adoptDashboardContext, dashboardApp } from './adopt';

/** Where the panel is mounted. Identified so a second bundle load finds it instead of stacking. */
const HOST_ID = 'apps-plus-builder';

/** The stylesheet that gives the drawer its room. See reserve(). */
const RESERVATION_ID = 'apps-plus-builder-reservation';

let panel: any = null;

/**
 * Take the drawer's width out of the dashboard rather than covering it.
 *
 * `.dashboard-root` is the element Rancher sizes to the viewport on every layout it has, and
 * everything else divides up what is inside it - so padding it is the whole reservation, and the
 * header, the nav and the scrolling main area do the arithmetic themselves.
 *
 * Not Rancher's own `--wm-vl-width`: only the default layout consumes it, so a drawer would go on
 * covering the Home page, and it belongs to the window manager, which has its own docked shells
 * to place.
 */
function reserve(): void {
  let sheet = document.getElementById(RESERVATION_ID);

  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = RESERVATION_ID;
    document.head.appendChild(sheet);
  }

  // Rancher's slide-in panel is fixed and anchored right, so it knows nothing about the
  // padding above and slides underneath the drawer - taking its title, its close button and the
  // left edge of whatever it is showing with it. Reserved the same way, in the same sheet.
  sheet.textContent = builder.open ? `
    .dashboard-root { padding-left: ${ builder.width }px; }
    #slides .slide-in { max-width: calc(100vw - ${ builder.width }px); }
    #slides .slide-in-glass { left: ${ builder.width }px; width: calc(100vw - ${ builder.width }px); }
  ` : '';
}

/** The panel, made the first time it is wanted. */
function panelInstance(): any {
  if (panel) {
    return panel;
  }

  const host = document.createElement('div');

  host.id = HOST_ID;
  document.body.appendChild(host);

  const app = createApp(BuilderPanel);

  adoptDashboardContext(app);
  panel = app.mount(host);

  return panel;
}

/**
 * Open the drawer, build it if it is not built yet, and keep the reservation in step.
 *
 * Exported rather than kept private because two things open it: the flask in the header, and an
 * "Add to Application" on a page where nobody has chosen an app yet.
 */
export function openBuilder(): void {
  panelInstance();
  builder.open = true;
  reserve();
}

export function toggleBuilder(): void {
  if (builder.open) {
    builder.open = false;
    reserve();

    return;
  }

  openBuilder();
}

export function closeBuilder(): void {
  builder.open = false;
  reserve();
}

/** Called by the panel while its edge is being dragged. */
export function resizeBuilder(width: number): void {
  builder.width = width;
  reserve();
}

/**
 * Put the drawer back as this browser left it, once the dashboard exists to put it beside.
 *
 * A cold load evaluates this bundle before Vue has mounted `#app`, so there is nothing to adopt a
 * context from yet and the panel would come up inert. Polling is the honest answer: the dashboard
 * does not announce itself, and the wait is a few hundred milliseconds on a page that is still
 * painting.
 */
export function restoreBuilder(): void {
  if (!builder.open) {
    return;
  }

  const attempt = (left: number) => {
    if (dashboardApp()) {
      openBuilder();

      return;
    }

    if (left > 0) {
      setTimeout(() => attempt(left - 1), 250);
    }
  };

  attempt(40);
}
