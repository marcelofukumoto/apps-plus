// Which box on Rancher's own edit page edits which path of the manifest.
//
// The page-mark overlay (components/PageMarks.vue) works this out by experiment: write a
// sentinel through the input and watch which path of the bound model moved. That cannot work on
// a form rendered in view mode - every input is disabled, and nothing can be written through a
// disabled input - so the form sheet answers the same question from a table instead.
//
// A table is the honest shape for it anyway. Two kinds are wired here, Deployment and ConfigMap,
// and each line says "the box Rancher labels X edits path Y". Adding a Service or a StatefulSet
// is adding lines, not writing code.
//
// Pure DOM + data, like probe.ts: no Vue, no store. `t` is passed in because the wiring is keyed
// by the i18n keys Rancher's own form uses - matching the words rather than the key would break
// in every language but English, and matching a CSS selector would break on every refactor.

/** One input on the rendered form, and the manifest path it edits. */
export interface WiredInput {
  /** Stable across re-scans, so the switch does not remount every tick. */
  id: string;
  /** The field's own box, which is what decides whether the switch is on screen at all. */
  el: HTMLElement;
  /**
   * What the switch sits beside: the field's label where it has one, and the key box on a
   * key/value row, which is that row's label in everything but name. Never the field itself -
   * a switch over an input covers the value somebody is deciding about.
   */
  anchor: HTMLElement;
  /** The path in the manifest that box edits. */
  path: string;
}

/** One line of the table. */
interface Wire {
  /** The i18n key of the label Rancher puts on the box... */
  labelKey?: string;
  /** ...or the `data-testid` it carries, for the boxes whose label is not unique. */
  testid?: string;
  /**
   * The path it edits. `{container}` stands for the container whose panel the box is in - the
   * form draws one panel per container and they all use the same labels, so the path is only
   * complete once the panel is known. `{row}` is the index of the repeated row it is in.
   */
  path: string;
}

/**
 * A Deployment's form, field by field.
 *
 * Only the fields an installation plausibly sets. The form has a hundred more - node
 * scheduling, tolerations, security context - and a switch on every one of them would be a
 * page of switches rather than an answer to "what can somebody change when they install this".
 *
 * The four resource boxes are matched by `data-testid` because ContainerResourceLimit renders
 * them through UnitInput, whose label carries the unit ("CPU Reservation" beside a box that
 * shows mCPUs); the testids are what that component itself uses in Rancher's own tests.
 */
const DEPLOYMENT: Wire[] = [
  { labelKey: 'workload.replicas', path: 'spec.replicas' },
  { labelKey: 'workload.container.containerName', path: '{container}.name' },
  { labelKey: 'workload.container.image', path: '{container}.image' },
  // Rendered inside each container's panel, but it belongs to the pod - so no `{container}`,
  // and a two-container Deployment gets the same path offered from either panel.
  { labelKey: 'workload.serviceAccountName.label', path: 'spec.template.spec.serviceAccountName' },
  { testid: 'cpu-reservation', path: '{container}.resources.requests.cpu' },
  { testid: 'memory-reservation', path: '{container}.resources.requests.memory' },
  { testid: 'cpu-limit', path: '{container}.resources.limits.cpu' },
  { testid: 'memory-limit', path: '{container}.resources.limits.memory' },
];

/** The boxes in one row of the ports table, inside a container's panel. */
const DEPLOYMENT_PORT_ROW: Wire[] = [
  { labelKey: 'workload.container.ports.name', path: '{container}.ports.{row}.name' },
  { labelKey: 'workload.container.ports.containerPort', path: '{container}.ports.{row}.containerPort' },
  { labelKey: 'workload.container.ports.protocol', path: '{container}.ports.{row}.protocol' },
  { labelKey: 'workload.container.ports.hostPort', path: '{container}.ports.{row}.hostPort' },
  { labelKey: 'workload.container.ports.hostIP', path: '{container}.ports.{row}.hostIP' },
];

/**
 * A provisioning Cluster's form.
 *
 * The three at the top of Cluster Configuration are what an installation of an app that
 * provisions its own cluster would plausibly want to decide - which Kubernetes, which CNI,
 * which cloud provider - and the pool fields are how big it is. Everything else on that form
 * belongs to the shape of the cluster rather than to the installation.
 */
const CLUSTER: Wire[] = [
  { labelKey: 'cluster.kubernetesVersion.label', path: 'spec.kubernetesVersion' },
  { labelKey: 'cluster.rke2.cni.label', path: 'spec.rkeConfig.machineGlobalConfig.cni' },
  { labelKey: 'cluster.rke2.cloudProvider.label', path: 'spec.rkeConfig.machineGlobalConfig.cloud-provider-name' },
];

/** The boxes in one machine pool's own tab. */
const CLUSTER_POOL: Wire[] = [
  { labelKey: 'cluster.machinePool.name.label', path: '{pool}.name' },
  { labelKey: 'cluster.machinePool.quantity.label', path: '{pool}.quantity' },
];

/** The kinds this file knows the form of. Everything else renders its page without switches. */
export function isWired(kind: string): boolean {
  return kind === 'Deployment' || kind === 'ConfigMap' || kind === 'Cluster';
}

export type Translate = (key: string) => string;

/**
 * Every input on the rendered form that a path is known for.
 *
 * `host` is the element the edit page was rendered into, `manifest` the staged template it was
 * rendered from - needed because a container is addressed by index in the YAML and by name on
 * the form, and the ports table has no name at all, only an order.
 */
export function wiredInputs(kind: string, host: HTMLElement, manifest: any, t: Translate): WiredInput[] {
  if (kind === 'Deployment') {
    return deploymentInputs(host, manifest, t);
  }

  if (kind === 'ConfigMap') {
    return configMapInputs(host);
  }

  if (kind === 'Cluster') {
    return clusterInputs(host, manifest, t);
  }

  return [];
}

// ------------------------------------------------------------------ finding boxes

interface Box {
  el: HTMLElement;
  /** The `<label>` itself, kept so a switch can be put beside the words rather than the input. */
  labelEl: HTMLElement;
  label: string;
}

/**
 * Every labelled box under an element, with the words on its label.
 *
 * The label has to be the box's own: LabeledSelect nests one a level down, and a component that
 * wraps a labelled box in another would otherwise answer for both.
 */
function labelledBoxes(host: HTMLElement): Box[] {
  return Array.from(host.querySelectorAll<HTMLElement>('.labeled-input, .labeled-select'))
    .map((el) => {
      const label = el.querySelector('label');

      if (!label || label.closest('.labeled-input, .labeled-select') !== el) {
        return null;
      }

      // The required marker is a `<span>*</span>` inside the label, and it is not part of what
      // the field is called.
      return { el, labelEl: label as HTMLElement, label: (label.textContent || '').replace(/\*\s*$/, '').trim() };
    })
    .filter((box): box is Box => !!box);
}

/** The box a `data-testid` names, normalised to the labelled box that contains it. */
function testidBoxes(host: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(`[data-testid="${ testid }"]`))
    .map((el) => (el.closest('.labeled-input, .labeled-select') as HTMLElement) || el);
}

/** Resolve one line of the table against a scope, at a path with the placeholders filled in. */
function match(wire: Wire, scope: HTMLElement, path: string, t: Translate, out: WiredInput[]): void {
  const found: Box[] = wire.testid ?
    testidBoxes(scope, wire.testid).map(withLabel) :
    labelledBoxes(scope).filter((box) => box.label === t(wire.labelKey as string));

  found.forEach((box) => out.push({
    id: `${ path }@${ out.length }`, el: box.el, anchor: box.labelEl, path,
  }));
}

/** A box found by testid, paired with its own label so the switch has something to sit beside. */
function withLabel(el: HTMLElement): Box {
  const label = el.querySelector('label');
  const own = label && label.closest('.labeled-input, .labeled-select') === el ? label as HTMLElement : el;

  return { el, labelEl: own, label: (own.textContent || '').replace(/\*\s*$/, '').trim() };
}

// ------------------------------------------------------------------ Deployment

/**
 * The container panels on a workload form, each with the container it is showing.
 *
 * Rancher draws one tab per container and every panel uses the same labels, so a box's path is
 * only decidable once you know which panel it is in. The panels are found through the one box
 * that identifies them - the container's Name - and the container is then looked up in the
 * manifest by that name rather than by tab order, because `allContainers` on the form is init
 * containers followed by ordinary ones and the YAML holds them in two separate lists.
 */
function containerPanels(host: HTMLElement, manifest: any, t: Translate): { panel: HTMLElement; path: string }[] {
  const nameLabel = t('workload.container.containerName');

  return labelledBoxes(host)
    .filter((box) => box.label === nameLabel)
    .map((box) => {
      const input = box.el.querySelector('input');
      // The Name box sits in the container's "General" tab, which sits in the container's own
      // tab: one panel up from the innermost one.
      const inner = box.el.closest('section[role="tabpanel"]');
      const panel = inner?.parentElement?.closest('section[role="tabpanel"]') as HTMLElement | null;
      const path = input ? containerPath(manifest, input.value) : null;

      return panel && path ? { panel, path } : null;
    })
    .filter((found): found is { panel: HTMLElement; path: string } => !!found);
}

/**
 * Where the container with this name lives in the manifest.
 *
 * Null when the name is not unique across the two lists, rather than the first one that matches.
 * Kubernetes requires container names to be unique and Rancher's form does not enforce it, so a
 * template can hold two called `web` - and answering with the first would put a switch on the
 * second tab that quietly parameterises the first container. No switches is the right answer to
 * a question that has no answer.
 */
function containerPath(manifest: any, name: string): string | null {
  const pod = manifest?.spec?.template?.spec || {};
  const containers = pod.containers || [];
  const initContainers = pod.initContainers || [];
  const matches = (list: any[]) => list.filter((container: any) => container?.name === name).length;

  if (matches(containers) + matches(initContainers) !== 1) {
    return null;
  }

  const at = containers.findIndex((container: any) => container?.name === name);

  if (at !== -1) {
    return `spec.template.spec.containers.${ at }`;
  }

  return `spec.template.spec.initContainers.${ initContainers.findIndex((container: any) => container?.name === name) }`;
}

function deploymentInputs(host: HTMLElement, manifest: any, t: Translate): WiredInput[] {
  const out: WiredInput[] = [];
  const panels = containerPanels(host, manifest, t);

  DEPLOYMENT.filter((wire) => !wire.path.includes('{container}'))
    .forEach((wire) => match(wire, host, wire.path, t, out));

  panels.forEach(({ panel, path: container }) => {
    DEPLOYMENT.filter((wire) => wire.path.includes('{container}'))
      .forEach((wire) => match(wire, panel, wire.path.replace('{container}', container), t, out));

    // The ports table has no identity of its own - a row is its position - so the rows are
    // matched by the order Rancher renders them in, which is the order they are in the YAML.
    Array.from(panel.querySelectorAll<HTMLElement>('.ports-row')).forEach((row, i) => {
      DEPLOYMENT_PORT_ROW.forEach((wire) => {
        match(wire, row, wire.path.replace('{container}', container).replace('{row}', String(i)), t, out);
      });
    });
  });

  return out;
}

// ------------------------------------------------------------------ Cluster

/**
 * Where the machine pool with this name lives in the manifest.
 *
 * The same shape as containerPath, and null for the same reason when a name is not unique: a
 * switch that cannot say which pool it means must not be offered.
 */
function poolPath(manifest: any, name: string): string | null {
  const pools = manifest?.spec?.rkeConfig?.machinePools || [];

  if (pools.filter((pool: any) => pool?.name === name).length !== 1) {
    return null;
  }

  return `spec.rkeConfig.machinePools.${ pools.findIndex((pool: any) => pool?.name === name) }`;
}

function clusterInputs(host: HTMLElement, manifest: any, t: Translate): WiredInput[] {
  const out: WiredInput[] = [];

  CLUSTER.forEach((wire) => match(wire, host, wire.path, t, out));

  // One tab per pool, identified the way a container's panel is - by the one box that names it.
  labelledBoxes(host)
    .filter((box) => box.label === t('cluster.machinePool.name.label'))
    .forEach((box) => {
      const panel = box.el.closest('section[role="tabpanel"]') as HTMLElement | null;
      const path = poolPath(manifest, box.el.querySelector('input')?.value || '');

      if (panel && path) {
        CLUSTER_POOL.forEach((wire) => match(wire, panel, wire.path.replace('{pool}', path), t, out));
      }
    });

  return out;
}

// ------------------------------------------------------------------ ConfigMap

/**
 * A ConfigMap's data keys.
 *
 * Nothing here is labelled - it is a key/value table - so the rows are read through the testids
 * KeyValue puts on them, and each row's path is `data.<whatever the key box says>`. The Binary
 * Data tab is deliberately not wired: its values are base64 blobs, and an installation typing
 * one in is not a thing to offer.
 *
 * The switch goes on the value cell rather than the key: parameterising `data.index.html` lets
 * an installation supply the file, and renaming the file is a different resource.
 */
function configMapInputs(host: HTMLElement): WiredInput[] {
  // Tabbed gives each panel the tab's own name as its id.
  const panel = host.querySelector<HTMLElement>('#data[role="tabpanel"]');

  if (!panel) {
    return [];
  }

  const out: WiredInput[] = [];

  for (let i = 0; ; i++) {
    const key = panel.querySelector<HTMLInputElement>(`[data-testid="input-kv-item-key-${ i }"]`);
    const value = panel.querySelector<HTMLElement>(`[data-testid="kv-item-value-${ i }"]`);

    if (!key || !value) {
      break;
    }

    // KeyValue always keeps one empty row for typing into. It names nothing.
    if (key.value) {
      out.push({
        id: `data.${ key.value }@${ i }`, el: value, anchor: key, path: `data.${ key.value }`,
      });
    }
  }

  return out;
}
