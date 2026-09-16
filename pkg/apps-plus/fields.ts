// Which fields of a manifest are worth offering as parameters, and how to set one.
//
// The YAML is the source of truth and stays that way: a toggle writes `${name}` into it and a
// default into the values, and turning the toggle off puts the value back. Nothing is stored
// twice, so hand-editing the YAML and using the picker cannot disagree.
//
// Pure on purpose - no Vue, no store. What counts as a field worth suggesting is the whole
// judgement of this feature, and it should be readable without any of that. The one import is
// the list of names an installation answers for itself, which is data and lives in render.ts
// because that is what substitutes them.

import { BUILT_IN_VALUES } from './render';

/** One scalar in a manifest, addressed by the path that reaches it. */
export interface Field {
  /** `spec.template.spec.containers.0.image` */
  path: string;
  /** What a person should read: `containers[0].image`, trimmed of the noise above it. */
  label: string;
  /** The words Rancher's own form uses, when there are any. See labelFriendly. */
  friendly: string | null;
  /** The value as it stands, or the parameter name when it is already one. */
  value: string;
  /** Set when this field is already `${something}`. */
  parameter: string | null;
}

/**
 * Paths worth offering without being asked, most useful first.
 *
 * Ordered rules rather than a set, because the order is the suggestion: an image and a replica
 * count are what almost every installation changes, and a `terminationGracePeriodSeconds` is
 * what almost none of them do. The last segment of each pattern is matched against the path, so
 * `image` catches a container's image wherever the kind happens to put it.
 *
 * Everything not listed is still reachable - see `searchFields` - this only decides what is on
 * screen before anybody types.
 */
const SUGGESTED = [
  /(^|\.)image$/,
  /(^|\.)replicas$/,
  /(^|\.)host$/,
  /(^|\.)storageClassName$/,
  /(^|\.)storage$/,
  /(^|\.)cpu$/,
  /(^|\.)memory$/,
  /(^|\.)containerPort$/,
  /(^|\.)port$/,
  /(^|\.)targetPort$/,
  /(^|\.)nodePort$/,
  /(^|\.)secretName$/,
  /(^|\.)serviceAccountName$/,
  /^data\./,
  /(^|\.)env\.\d+\.value$/,
];

/**
 * Paths never worth offering.
 *
 * Two kinds. Fields the apiserver or a controller owns, which a person setting them would only
 * be fighting; and the name, which is already parameterised on import and offering again would
 * suggest it was not.
 */
const NEVER = [
  /^apiVersion$/, /^kind$/,
  /^metadata\.name$/,
  /(^|\.)creationTimestamp$/,
  /(^|\.)progressDeadlineSeconds$/,
  /(^|\.)revisionHistoryLimit$/,
  /(^|\.)terminationGracePeriodSeconds$/,
  /(^|\.)dnsPolicy$/,
  /(^|\.)restartPolicy$/,
  /(^|\.)schedulerName$/,
  /(^|\.)terminationMessage/,
  /(^|\.)imagePullPolicy$/,
  /(^|\.)protocol$/,
  /(^|\.)sessionAffinity$/,
  /(^|\.)internalTrafficPolicy$/,
  /(^|\.)ipFamil/,
  /^status(\.|$)/,
];

// No whitespace inside the braces, matching VARIABLE in render.ts: `${ name }` is a script's
// own syntax, not one of this extension's parameters, and must not present as already toggled.
const PLACEHOLDER = /^\$\{([A-Za-z0-9_.-]+)\}$/;

/**
 * The parameter name in a value, when the value is entirely one parameter *of this app*.
 *
 * The qualification is the point. A field reading `${namespace}` is not something somebody
 * declared - it is one of the names an installation supplies about itself, and it has no entry
 * in the values at all. Counted as a parameter it presented as already on, and turning it "off"
 * looked up a default that was never there and wrote the empty string over it: one click, and
 * the field is gone. Counted as a plain value it reads as off, and turning it on is reversible.
 */
function ourParameter(value: unknown): string | null {
  const match = PLACEHOLDER.exec(String(value ?? ''));

  return match && !BUILT_IN_VALUES.includes(match[1]) ? match[1] : null;
}

/**
 * What a field is called on Rancher's own form for it.
 *
 * The point of the picker is that somebody should not have to read YAML to find the three
 * fields that matter, and `spec.template.spec.containers.0.image` is YAML with the punctuation
 * changed. These are the words the resource's own edit page uses, which is what somebody is
 * looking for.
 *
 * Matched on the path's tail so one entry covers every kind that has the field, and the raw
 * path is still shown underneath - the label is for finding it, the path is for being sure.
 *
 * Every pattern in SUGGESTED must be covered here, which is what the generic entries at the
 * bottom are for. A promoted field with no label renders its raw JSONPath as a title, which is
 * exactly the thing the labels exist to spare people - so a new suggestion comes with a label
 * or it inherits a generic one, never neither.
 */
const LABELS: [RegExp, string][] = [
  [/(^|\.)containers\.\d+\.image$/, 'Container Image'],
  [/(^|\.)image$/, 'Image'],
  [/(^|\.)replicas$/, 'Replicas'],
  [/(^|\.)containers\.\d+\.ports\.\d+\.containerPort$/, 'Container Port'],
  [/(^|\.)containerPort$/, 'Container Port'],
  [/(^|\.)targetPort$/, 'Target Port'],
  [/(^|\.)nodePort$/, 'Node Port'],
  [/(^|\.)ports\.\d+\.port$/, 'Service Port'],
  // Probe ports before the generic port: a probe's port usually holds the same value as the
  // container port beside it, and two rows that only differ in a JSONPath read as duplicates.
  [/(^|\.)livenessProbe\.\w+\.port$/, 'Liveness Probe Port'],
  [/(^|\.)readinessProbe\.\w+\.port$/, 'Readiness Probe Port'],
  [/(^|\.)startupProbe\.\w+\.port$/, 'Startup Probe Port'],
  [/(^|\.)host$/, 'Host'],
  [/(^|\.)storageClassName$/, 'Storage Class'],
  [/(^|\.)requests\.storage$/, 'Storage Size'],
  [/(^|\.)limits\.cpu$/, 'CPU Limit'],
  [/(^|\.)requests\.cpu$/, 'CPU Reservation'],
  [/(^|\.)limits\.memory$/, 'Memory Limit'],
  [/(^|\.)requests\.memory$/, 'Memory Reservation'],
  [/(^|\.)secretName$/, 'Secret Name'],
  [/(^|\.)serviceAccountName$/, 'Service Account'],
  [/(^|\.)env\.\d+\.value$/, 'Environment Variable'],
  [/^data\./, 'Data'],
  // Promoted by the form wiring rather than by SUGGESTED (see builder/form-wiring), and they
  // need labels for the same reason: a parameter with none wears its raw JSONPath on the
  // install form.
  [/(^|\.)containers\.\d+\.name$/, 'Container Name'],
  [/(^|\.)ports\.\d+\.name$/, 'Port Name'],
  [/(^|\.)hostPort$/, 'Host Port'],
  [/(^|\.)hostIP$/, 'Host IP'],
  // The safety net for SUGGESTED: anything promoted without a more specific label above still
  // gets a readable title rather than its path.
  [/(^|\.)port$/, 'Port'],
  [/(^|\.)storage$/, 'Storage Size'],
  [/(^|\.)cpu$/, 'CPU'],
  [/(^|\.)memory$/, 'Memory'],
];

/** The words for a path, or null when there are none worth inventing. */
export function labelFriendly(path: string): string | null {
  const hit = LABELS.find(([pattern]) => pattern.test(path));

  if (!hit) {
    return null;
  }

  // `data.index.html` is "Data: index.html" - the key is the useful half, not the word Data.
  if (hit[1] === 'Data') {
    return `Data: ${ path.slice('data.'.length) }`;
  }

  return hit[1];
}

/** A path a person can read: the array indices kept, the long prefix dropped. */
function labelFor(path: string): string {
  const parts = path.split('.');
  const short = parts.length > 3 ? parts.slice(-3) : parts;

  return short
    .reduce((out, part) => (/^\d+$/.test(part) ? `${ out }[${ part }]` : `${ out }${ out ? '.' : '' }${ part }`), '');
}

const ENV_VALUE = /(^|\.)env\.\d+\.value$/;
const CONTAINER_IMAGE = /(^|\.)containers\.\d+\.image$/;

/**
 * The label for one field, given the whole manifest to look around in.
 *
 * Env values and container images need the manifest: three rows all reading "Container Image"
 * cannot be told apart without decoding the JSONPath under them, and the sibling `name` key is
 * sitting right beside the value - so the label borrows it and reads "Container Image: nginx",
 * "Environment Variable: PORT".
 */
function friendlyFor(path: string, root: any): string | null {
  const friendly = labelFriendly(path);
  // A sibling name that is itself a parameter is a placeholder, not a name worth borrowing:
  // "Container Image: ${name}" reads as a bug, not a label.
  const usable = (name: any) => name && !PLACEHOLDER.test(String(name));

  if (friendly === 'Environment Variable' && ENV_VALUE.test(path)) {
    const name = readAt(root, path.replace(/value$/, 'name'));

    if (usable(name)) {
      return `Environment Variable: ${ name }`;
    }
  }

  if (friendly === 'Container Image' && CONTAINER_IMAGE.test(path)) {
    const name = readAt(root, path.replace(/image$/, 'name'));

    if (usable(name)) {
      return `Container Image: ${ name }`;
    }
  }

  return friendly;
}

/** Every scalar in the manifest, with the path that reaches it. */
export function leafFields(manifest: any, prefix = '', root: any = manifest): Field[] {
  if (manifest === null || manifest === undefined) {
    return [];
  }

  if (Array.isArray(manifest)) {
    return manifest.flatMap((item, i) => leafFields(item, prefix ? `${ prefix }.${ i }` : `${ i }`, root));
  }

  if (typeof manifest === 'object') {
    return Object.entries(manifest)
      .flatMap(([key, value]) => leafFields(value, prefix ? `${ prefix }.${ key }` : key, root));
  }

  const value = String(manifest);

  return [{
    path:      prefix,
    label:     labelFor(prefix),
    friendly:  friendlyFor(prefix, root),
    value,
    parameter: ourParameter(value),
  }];
}

/** Paths that must never be offered as parameters, wherever the offer would come from. */
export function isNever(path: string): boolean {
  return NEVER.some((pattern) => pattern.test(path));
}

/**
 * What to show before anybody searches: what is already a parameter, then the suggestions.
 *
 * A field that is already `${something}` comes first whatever it is - somebody chose it, and a
 * list that hid their choice below a suggestion would be a list they had to search to audit.
 */
export function suggestedFields(manifest: any): Field[] {
  const all = leafFields(manifest).filter((field) => !isNever(field.path));
  const chosen = all.filter((field) => field.parameter);
  const rest = all.filter((field) => !field.parameter);
  const suggested: Field[] = [];

  SUGGESTED.forEach((pattern) => {
    rest.forEach((field) => {
      if (pattern.test(field.path) && !suggested.includes(field)) {
        suggested.push(field);
      }
    });
  });

  return [...chosen, ...suggested];
}

/** Anything matching what was typed, for the fields the suggestions do not cover. */
export function searchFields(manifest: any, query: string): Field[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [];
  }

  return leafFields(manifest)
    .filter((field) => !isNever(field.path))
    .filter((field) => field.path.toLowerCase().includes(needle) || field.value.toLowerCase().includes(needle))
    .slice(0, 40);
}

/**
 * A parameter name for a field, not already taken.
 *
 * The last readable segment of the path, so `containers[0].image` is `image` and
 * `resources.limits.memory` is `memory` - which is what somebody would have typed. An index is
 * skipped rather than included: `image` reads better than `image0`, and the second one only
 * needs a suffix because the first one took the name.
 */
export function parameterNameFor(path: string, taken: Iterable<string>): string {
  const parts = path.split('.').filter((part) => !/^\d+$/.test(part));
  const base = parts[parts.length - 1] || 'value';
  // The built-ins are taken too, and by somebody who will not give them back. A label keyed
  // `app` or a `metadata.namespace` derives exactly those names, and minting one produced a
  // field that could not be turned off again: the YAML said `${app}`, ourParameter refused to
  // call that a parameter of this app, so the switch read as off and pressing it went round
  // the on branch a second time - `${app2}` defaulting to the literal text `${app}`, with the
  // real value lost. The name is the whole of the fix; ourParameter is right to refuse.
  const used = new Set([...taken, ...BUILT_IN_VALUES]);

  if (!used.has(base)) {
    return base;
  }

  for (let i = 2; ; i++) {
    if (!used.has(`${ base }${ i }`)) {
      return `${ base }${ i }`;
    }
  }
}

/**
 * Paths where a bare string default should be read back as the number or boolean it spells.
 *
 * An allowlist, and short on purpose. A default that still carries its own type is written back
 * as it is and never reaches this, so the only thing left to guess about is a default somebody
 * typed into a form - which arrives as a string whatever the field underneath it is.
 *
 * This used to be the other way round: coerce, unless the path is on a list of fields that are
 * strings in the schema. A denylist has to be complete to be safe and never was - a ConfigMap
 * key, a container's `args`, a Service's `selector`, a toleration's `value` are all `string`,
 * and every one it missed was a manifest that stopped applying with `cannot unmarshal number
 * into Go struct field ... of type string`. Inverted, a miss is a quoted number in a numeric
 * field: smaller, rarer, and it only happens to somebody who hand-edited that default.
 */
const TYPED = [
  /(^|\.)replicas$/,
  /(^|\.)containerPort$/,
  /(^|\.)hostPort$/,
  /(^|\.)nodePort$/,
  /(^|\.)ports\.\d+\.port$/,
  // IntOrString: a numeric string is rejected as "must contain at least one letter", so these
  // have to come back as numbers. Both are offered by the picker without anybody searching.
  /(^|\.)targetPort$/,
  /(^|\.)httpGet\.port$/,
  /(^|\.)tcpSocket\.port$/,
  /(^|\.)grpc\.port$/,
  // `replicas` above does not match these two, which is exactly the kind of gap this list is
  // for: their neighbour is covered and they read as if they were.
  /(^|\.)minReplicas$/,
  /(^|\.)maxReplicas$/,
  /(^|\.)runAsUser$/,
  /(^|\.)runAsGroup$/,
  /(^|\.)fsGroup$/,
  /(^|\.)backoffLimit$/,
  /(^|\.)parallelism$/,
  /(^|\.)completions$/,
  /(^|\.)activeDeadlineSeconds$/,
  /(^|\.)defaultMode$/,
  /(^|\.)minReadySeconds$/,
  /(^|\.)periodSeconds$/,
  /(^|\.)initialDelaySeconds$/,
  /(^|\.)timeoutSeconds$/,
  /(^|\.)failureThreshold$/,
  /(^|\.)successThreshold$/,
  /(^|\.)hostNetwork$/,
  /(^|\.)privileged$/,
  /(^|\.)allowPrivilegeEscalation$/,
  /(^|\.)readOnlyRootFilesystem$/,
  /(^|\.)runAsNonRoot$/,
  /(^|\.)suspend$/,
];

/**
 * The value to put back at a path, given the default that was stored for it.
 *
 * A default that is not a string still has the type it was taken out of the YAML with and goes
 * straight back, which is every ordinary round trip and is exact for all of them. A string
 * either was a string or is one because a form gave it back; only the list above can tell those
 * apart, and everywhere else a string is what a string was.
 */
function restore(path: string, previous: unknown): unknown {
  if (typeof previous !== 'string' || !TYPED.some((pattern) => pattern.test(path))) {
    return previous;
  }

  if (/^-?\d+$/.test(previous)) {
    return Number(previous);
  }

  if (previous === 'true' || previous === 'false') {
    return previous === 'true';
  }

  return previous;
}

/**
 * Turn the field at a path into a parameter, or turn it back into a value.
 *
 * On: the current value becomes the default and the field becomes `${name}`. Off: the default
 * is written back into the YAML and dropped from the values, because a default for a parameter
 * nothing refers to is exactly what the stale marker in the values editor complains about.
 *
 * The manifest is mutated in place; the returned values and labels are fresh objects. Shared by
 * both places a field can be toggled - the Customizable list and the Configure form - so the two
 * can never disagree about what a toggle means.
 */
export function applyToggle(
  manifest: any,
  path: string,
  values: Record<string, unknown>,
  labels: Record<string, string>,
): { values: Record<string, unknown>; labels: Record<string, string> } {
  const current = readAt(manifest, path);
  const parameter = ourParameter(current);
  const nextValues = { ...values };
  const nextLabels = { ...labels };

  if (parameter) {
    const previous = nextValues[parameter];

    writeAt(manifest, path, previous === undefined ? '' : restore(path, previous));
    delete nextValues[parameter];
    delete nextLabels[parameter];
  } else {
    const name = parameterNameFor(path, Object.keys(nextValues));

    // Stored with its type, not stringified: the default *is* the value that came out of the
    // YAML, and a `replicas` that goes in as the number 2 comes back as the number 2 without
    // anybody having to work out that it should.
    nextValues[name] = current ?? '';
    nextLabels[name] = friendlyFor(path, manifest) || labelFor(path);
    writeAt(manifest, path, `\${${ name }}`);
  }

  return { values: nextValues, labels: nextLabels };
}

/** The parameter name at a path, when the field there is one of this app's `${something}`. */
export function parameterAt(manifest: any, path: string): string | null {
  return ourParameter(readAt(manifest, path));
}

/**
 * The object a path ends in, and the key it ends at.
 *
 * Not a plain `split('.')`: a ConfigMap's keys are file names, so `data.index.html` is two keys
 * and not three, and reading it a segment at a time reaches `undefined` and offers no toggle on
 * the one field a ConfigMap has. So at every step the longest run of segments that is actually a
 * key of the node in hand wins, which resolves a dotted key wherever one appears and is exactly
 * `split('.')` everywhere else - `spec.template.spec` has no key called `template.spec` to find.
 *
 * The last segment is allowed not to exist yet, so writeAt can create one; an intermediate that
 * does not exist is a path into nothing, and answers null.
 */
function locate(manifest: any, path: string): { holder: any; key: string } | null {
  const parts = path.split('.');
  let node = manifest;
  let at = 0;

  while (at < parts.length) {
    if (node === null || node === undefined || typeof node !== 'object') {
      return null;
    }

    let key = '';
    let taken = 0;

    for (let end = parts.length; end > at; end--) {
      const candidate = parts.slice(at, end).join('.');

      if (Object.prototype.hasOwnProperty.call(node, candidate)) {
        key = candidate;
        taken = end - at;
        break;
      }
    }

    if (!taken) {
      return at === parts.length - 1 ? { holder: node, key: parts[at] } : null;
    }

    if (at + taken === parts.length) {
      return { holder: node, key };
    }

    node = node[key];
    at += taken;
  }

  return null;
}

/** Read the scalar at a path. */
export function readAt(manifest: any, path: string): any {
  const found = locate(manifest, path);

  return found ? found.holder[found.key] : undefined;
}

/** Write a scalar at a path, in place. */
export function writeAt(manifest: any, path: string, value: unknown): void {
  const found = locate(manifest, path);

  if (found && found.holder && typeof found.holder === 'object') {
    found.holder[found.key] = value;
  }
}
