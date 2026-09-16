// Rendering an App's templates for one instance.
//
// Deliberately not Helm. A chart's templating is a whole language with a runtime, and the
// point here is that a template is a YAML file you can read: the only substitution is
// `${name}`, for the names the app declares in `spec.values` and the built-ins below. Anything
// else is left exactly as written rather than blanked, so a `${...}` that belongs to whatever
// the YAML configures - a script in a ConfigMap, an nginx config - survives being rendered.

import { DEFAULT_CLUSTER_VALUES } from './config/cluster-template';

export interface Template {
  name: string;
  content: string;
}

// No whitespace inside the braces, deliberately. Everything this extension writes is `${name}`
// exactly, while `${ name }` is how JavaScript template literals and shell scripts breathe - and
// a ConfigMap holding a script is an ordinary thing to template. The spacing is the one reliable
// tell between "ours" and "the file's own syntax", so a spaced form is left alone.
const VARIABLE = /\$\{([A-Za-z0-9_.-]+)\}/g;

/**
 * Values nobody has to supply: four the app and installation know about themselves, the id of a
 * cloud credential (resolved from the ones Rancher has, see cloudCredentialId on the model),
 * plus whatever the built-in cluster template defaults. A template using these is satisfied by
 * definition.
 *
 * `instance` is the old name for `install` and is last on purpose: it still resolves, so an app
 * written before the rename keeps working, but it is not offered anywhere.
 */
export const BUILT_IN_VALUES = ['app', 'install', 'cluster', 'namespace', 'cloudCredential', 'instance'];

/**
 * The built-ins worth telling somebody about, and what each one is.
 *
 * A subset of BUILT_IN_VALUES rather than the same list, because two of those are not things to
 * put in front of a person: `instance` is the old name for `install` and only exists so that
 * apps written before the rename still render, and `cloudCredential` belongs to the cluster
 * template rather than to a resource template. Both still resolve; neither is advertised.
 *
 * Kept here, beside the list it is a subset of, so a new built-in is one edit rather than two.
 */
export const DOCUMENTED_VALUES: { name: string; what: string }[] = [
  { name: 'app', what: 'the name of this app' },
  { name: 'install', what: 'the name of the installation being deployed' },
  { name: 'cluster', what: 'the cluster it is going to' },
  { name: 'namespace', what: 'the namespace the resources land in' },
];

/**
 * Names nobody has to supply, given how the installation deploys.
 *
 * The cluster defaults only answer when a cluster template is actually rendered - syncCluster
 * substitutes them in, and nothing else does. Counting them unconditionally meant an app could
 * declare `region` with no default and every non-provisioning installation was told it owed
 * nothing, right up until the deployed YAML said `${region}`.
 */
function autoSatisfied(includeCluster: boolean): string[] {
  return includeCluster ? [...BUILT_IN_VALUES, ...Object.keys(DEFAULT_CLUSTER_VALUES)] : BUILT_IN_VALUES;
}

/** A value counts as supplied only if it is actually set to something. */
export function isSet(bag: Record<string, unknown> | undefined, key: string): boolean {
  const value = bag?.[key];

  return value !== undefined && value !== null && `${ value }`.trim() !== '';
}

/** Every `${...}` a piece of template text refers to, in order of first appearance. */
export function referencedVariables(source: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(VARIABLE.source, 'g');
  let match = pattern.exec(source || '');

  while (match !== null) {
    found.add(match[1]);
    match = pattern.exec(source || '');
  }

  return [...found];
}

/**
 * Every variable an app answers for: the ones its definer declared, plus the built-ins.
 *
 * Declared, not scraped. The parameters of an app are exactly the keys in `spec.values` -
 * FieldPicker and the importer write one there for every field they parameterise - so the app
 * already knows its own set. Scanning the template bodies for `${...}` instead is how a
 * ConfigMap holding a shell script or a JS file turns into a form demanding `${TOKEN}` and
 * `${response.status}`: file contents get to use that syntax for themselves.
 *
 * The cluster template is still scanned, and only when it is going to be rendered. It is not
 * built by the picker, so scanning is the only way to learn what a hand-written one asks for -
 * and it is a provisioning manifest, not a file body, so the syntax is not shared with anything.
 * An instance that deploys to clusters that already exist never renders it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appVariables(app: any, includeCluster = false): string[] {
  const found = new Set<string>(Object.keys(app?.spec?.values || {}));

  BUILT_IN_VALUES.forEach((name) => found.add(name));

  if (includeCluster) {
    referencedVariables(app?.spec?.clusterTemplate || '').forEach((name) => found.add(name));
  }

  return [...found];
}

/** One template's `${...}` uses that the app does not answer. */
export interface UndeclaredReference {
  /** The template's file name, so the message can say where. */
  file: string;
  names: string[];
}

/**
 * `${...}` in an app's templates that neither the app nor the built-ins answer.
 *
 * The complement of the declared model. Parameters are exactly the keys in `spec.values`, and
 * scraping template bodies must never feed `substitute` - but an app authored by hand or by
 * kubectl can write `${maxmemory}` in a template and declare nothing, and then every screen
 * that trusts the declaration says "no values" while the rendered YAML says otherwise. Whether
 * that `${...}` is a forgotten parameter or a script's own syntax is not decidable here, so
 * this names it and the screens warn: it deploys as written unless somebody declares it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function undeclaredReferences(app: any): UndeclaredReference[] {
  const declared = new Set([...Object.keys(app?.spec?.values || {}), ...BUILT_IN_VALUES]);

  return (app?.spec?.templates || [])
    .map((template: Template, i: number) => ({
      file:  template?.name || `resource-${ i }.yaml`,
      names: referencedVariables(template?.content || '').filter((name) => !declared.has(name)),
    }))
    .filter((reference: UndeclaredReference) => reference.names.length);
}

/**
 * The same references shaped for the warning banner - four surfaces show one, and the shape
 * has to match the l10n message everywhere, so the mapping lives beside the scan rather than
 * being repeated at each of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function undeclaredWarnings(app: any): { file: string; count: number; refs: string }[] {
  return undeclaredReferences(app).map(({ file, names }) => ({
    file,
    count: names.length,
    refs:  names.map((name) => `\${${ name }}`).join(', '),
  }));
}

/**
 * The variables an app cannot answer itself, so every instance of it has to supply them.
 *
 * This is what makes a template change safe or unsafe. Declaring `replicas` with a default
 * changes nothing for existing instances; declaring it with an empty one means none of them
 * can be rendered until somebody says what replicas is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requiredValues(app: any, includeCluster = false): string[] {
  return appVariables(app, includeCluster)
    .filter((name) => !autoSatisfied(includeCluster).includes(name))
    .filter((name) => !isSet(app?.spec?.values, name));
}

/** What this instance still owes its app before it can be rendered at all. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function missingValues(app: any, instance: any): string[] {
  const includeCluster = !!instance?.spec?.provisionCluster?.enabled;

  return requiredValues(app, includeCluster)
    .filter((name) => !isSet(instance?.spec?.values, name));
}

/**
 * A line that is one placeholder and nothing else, in a position where a YAML scalar goes:
 * `key: ${name}`, `- key: ${name}`, or a `- ${name}` sequence item.
 *
 * Captured in three parts - the indentation, everything up to the value, and the name - because
 * putting a value there is not always a matter of writing it out. See substituteScalar.
 */
const WHOLE_SCALAR = /^([ \t]*)((?:[^\s#][^:\n]*:[ \t]+)|(?:- ))\$\{([A-Za-z0-9_.-]+)\}[ \t]*\r?$/;

/**
 * The header of a literal or folded block: `key: |`, `- >-`, `data: |2`.
 *
 * Everything indented under one of these is a file, not YAML, and must be left to the plain
 * substitution however much it looks like a mapping. A ConfigMap holding an nginx config or a
 * .env file has lines that read exactly like `key: ${value}`, and rewriting one as a YAML
 * scalar - quoting it, or spreading it over several lines - edits somebody's file.
 */
const BLOCK_HEADER = /^([ \t]*)((?:- )*)([^\s#][^:\n]*:[ \t]*)?[|>][-+]?\d*[ \t]*(?:#.*)?\r?$/;

/**
 * The indentation a block's content has to beat, which is the header's *node*, not its line.
 *
 * `- key: |` puts the mapping two columns in from the dash, so its siblings are indented two
 * further than the line the header is on - and measuring from the line swallowed them as file
 * content, which turned a valid template into invalid YAML. A bare `- |` has no key, so there
 * the sequence itself is the node and the line's own indentation is right.
 */
function blockIndent(header: RegExpExecArray): number {
  return header[1].length + (header[3] ? header[2].length : 0);
}

/**
 * Values a plain YAML scalar cannot hold as written.
 *
 * Empty, or padded with whitespace YAML would eat; or holding `: ` or ` #`, which start a
 * mapping and a comment; or opening with an indicator character, which makes it an anchor, an
 * alias, a tag, a flow collection or a comment rather than a string; or being nothing but an
 * indicator. A number, and anything else that is only letters and digits, is deliberately not
 * here - `replicas: '2'` is rejected by the apiserver, so quoting must be the exception rather
 * than the safe default.
 */
const NEEDS_QUOTES = /^$|^\s|\s$|: | #|^[?:-]\s|^[?:-]$|^[,[\]{}#&*!|>'"%@`]/;

/**
 * Values that stop being strings when written bare.
 *
 * The apiserver reads YAML 1.1, where `true`, `yes`, `off` and `null` are booleans and null,
 * `0755` is 493, `1:30` is 90 and a bare date is a timestamp. So a ConfigMap key whose value is
 * the text `true` deployed as the boolean `true` and was rejected with `cannot unmarshal bool
 * into Go struct field ConfigMap.data of type string`.
 *
 * Applied only to a value that is still a string by the time it gets here, and that is the whole
 * of the judgement - see mergeValues. A field parameterised from a number or a boolean stores
 * one, and an installation's override is given the type of the default it overrides, so anything
 * still a string is a string the app declared as one. Deciding this from the *type* is what
 * replaced three rounds of guessing at it from the text.
 */
const NOT_A_STRING = [
  /^(?:y|n|yes|no|true|false|on|off|null|~)$/i,
  /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/,
  /^0o?[0-7]+$/i,
  /^[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.\d*)?$/,
  /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ].*)?$/,
];

/**
 * Write one value into the scalar position a placeholder occupied.
 *
 * The reason this is not `String(value)` is the case this whole feature is built around: a
 * ConfigMap key holding a file. Its default *is* the file - several lines of HTML or nginx
 * config - and pasting that after `index.html: ` produces a template that is no longer YAML.
 * It is not a preview problem, though that is where it shows: renderTemplates substitutes the
 * same way, so the Bundle carried the same broken text to the cluster.
 *
 * So a multi-line value becomes a literal block, indented under its key, chomped to keep
 * exactly the trailing newlines it had and carrying an explicit indentation indicator so that a
 * value whose own first line is indented still says what it says. A single-line value that a
 * plain scalar cannot hold, or that would stop being a string, is quoted.
 */
function substituteScalar(indent: string, prefix: string, value: unknown, declaredString: boolean): string {
  const text = String(value);
  const head = `${ indent }${ prefix }`;

  if (!text.includes('\n')) {
    // Quoted because YAML would otherwise not read it back as a value at all, or because the
    // app says this parameter is a string and writing it bare would change its type. Not
    // quoted on suspicion: a parameter the app declares no default for has no type to go on,
    // and `replicas: '3'` for an installation that supplied 3 is the wrong kind of guess.
    const quote = NEEDS_QUOTES.test(text) ||
      (declaredString && NOT_A_STRING.some((pattern) => pattern.test(text)));

    return head + (quote ? `'${ text.replace(/'/g, "''") }'` : text);
  }

  // Deeper than the node the value belongs to, which for a sequence item is two further in than
  // the dash. The indicator is that depth measured from the parent node, which is the dash for
  // a bare item and the key for everything else - so 4 in the one case and 2 in the other.
  const inSequence = prefix.startsWith('- ');
  const body = indent + (inSequence ? '    ' : '  ');
  const indicator = prefix === '- ' ? 4 : 2;
  const trailing = (/\n+$/.exec(text) || [''])[0].length;
  const chomp = trailing === 0 ? '-' : (trailing === 1 ? '' : '+');
  const lines = text.replace(/\n+$/, '').split('\n');
  // `|+` keeps every trailing newline, so the ones stripped above are written back as blanks.
  const extra = trailing > 1 ? new Array(trailing - 1).fill('') : [];

  return [`${ head }|${ indicator }${ chomp }`, ...lines.map((line) => (line ? body + line : '')), ...extra].join('\n');
}

/**
 * The parameters the app declares a string default for.
 *
 * The only record of what a field is. An installation's values all arrive as text, so by the
 * time they are being written back into YAML nothing else can tell `replicas` from a ConfigMap
 * key that happens to hold digits - and getting that wrong sends `replicas: '3'` or `port: 8080`
 * to the apiserver, which refuses both. A blank default is not a declaration of anything: it is
 * the required-value case, and there is nothing to learn from it.
 */
function declaredStrings(values: Record<string, unknown> | undefined): Set<string> {
  // The built-ins are seeded rather than looked up, because they are appended to the bag after
  // the declarations are read and so were never in it. All five are names - `no`, `on` and `y`
  // are legal RFC1123 labels, and so is `123` - and a namespace written bare as a boolean or a
  // number is rejected by the apiserver.
  return new Set([...BUILT_IN_VALUES, ...Object.entries(values || {})
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([key]) => key)]);
}

/** Every `${name}` in a line, replaced from the bag and otherwise left alone. */
function plain(line: string, values: Record<string, unknown>): string {
  return line.replace(VARIABLE, (match, key) => {
    const value = values[key];

    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Replace `${name}` for the names in the bag, and nothing else.
 *
 * The bag is the declared values plus the built-ins (see mergeValues), which is what makes this
 * safe to run over a template whose file bodies use `${...}` for their own purposes: an
 * entrypoint script's `${SA}` is not in the bag, so it survives rendering exactly as written.
 *
 * Line by line, because a placeholder that is a whole value is a different thing from one
 * embedded in a string: only the first can be given a block scalar, and only the first knows
 * what it is indented under. A placeholder inside a longer string, or anywhere inside a block
 * scalar - which is a file rather than YAML - gets the plain substitution, which is all that
 * can be done for it.
 */
export function substitute(source: string, values: Record<string, unknown>, declared?: Record<string, unknown>): string {
  const strings = declaredStrings(declared === undefined ? values : declared);
  let block: number | null = null;

  return (source || '').split('\n').map((line) => {
    const indent = (/^[ \t]*/.exec(line) as RegExpExecArray)[0].length;

    // A blank line neither ends a block nor starts one; inside a block it is part of the file.
    if (block !== null && (!line.trim() || indent > block)) {
      return plain(line, values);
    }

    const header = BLOCK_HEADER.exec(line);

    block = header ? blockIndent(header) : null;

    const whole = header ? null : WHOLE_SCALAR.exec(line);
    const value = whole ? values[whole[3]] : undefined;

    if (whole && value !== undefined && value !== null) {
      return substituteScalar(whole[1], whole[2], value, strings.has(whole[3]));
    }

    return plain(line, values);
  }).join('\n');
}

/**
 * The values one instance renders with: the App's defaults, the instance's overrides on top,
 * and three the pair always knows about themselves.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeValues(app: any, instance: any): Record<string, unknown> {
  const namespace = instance?.spec?.namespace || 'default';
  const declared = app?.spec?.values || {};

  return {
    ...declared,
    ...typedOverrides(declared, instance?.spec?.values),
    app:      app?.metadata?.name || instance?.spec?.app || '',
    install:  instance?.metadata?.name || '',
    // The name this had before installations were called installations. Kept because the
    // substitution leaves an unmatched `${...}` exactly as written rather than blanking it, so
    // dropping it would not fail an app that still uses it - it would deploy a resource
    // literally named `${instance}-hello`. It costs one line and it is in BUILT_IN_VALUES, so
    // nothing asks anybody to supply it.
    instance: instance?.metadata?.name || '',
    // The cluster an instance provisions, so one app's resource templates and its cluster
    // template can both refer to it by the same name.
    cluster:  instance?.clusterName || instance?.spec?.provisionCluster?.name || instance?.metadata?.name || '',
    namespace,
  };
}

/** What YAML 1.1 reads as a boolean, which is what an installation may type into one. */
const BOOLEAN_WORDS: Record<string, boolean> = {
  true: true, yes: true, on: true, y: true, false: false, no: false, off: false, n: false,
};

/**
 * Values given the type of the declaration they answer to.
 *
 * Every value that reaches this has been through a form input, so it is a string - including the
 * ones for fields that are numbers and booleans. The declared default is the only record of what
 * the field actually is, and losing it is what sends `replicas: '3'` or a ConfigMap's
 * `port: 8080` to an apiserver that refuses both.
 *
 * Used on both sides on purpose. An installation's overrides are typed against the app's
 * defaults here; the app's own Default Values table types its edits against what it already
 * holds (see ValuesEditor), because that table is a text widget and would otherwise downgrade a
 * number to a string on the first keystroke - quietly, since nothing fails until an installation
 * will not apply. The two sides being one function is what stops them drifting apart again.
 *
 * The two sides agree about types and disagree about blank, which is the one seam between them
 * and so the one thing this takes an argument for. Blank on an installation means "leave it to
 * the app default" - the form says so - and the override is dropped, because `''` in an int32 is
 * rejected and neither zero nor false is what was meant. Blank on the app's own table means the
 * opposite: this parameter is required and every installation has to answer it, which is what
 * `isSet` reads and `requiredValues` reports, so the key stays with nothing in it. Dropping it
 * there deleted the parameter, left the template saying a literal `${replicas}`, and let an
 * installation save that nothing would block.
 *
 * A value the declaration says nothing about is left exactly as typed - inventing a type for it
 * would be the same guess in a different place.
 */
export function typedOverrides(
  declared: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
  blankDeclaresRequired = false,
): Record<string, unknown> {
  return Object.entries(overrides || {}).reduce((out: Record<string, unknown>, [key, value]) => {
    const base = declared[key];
    const typed = typeof base === 'number' || typeof base === 'boolean';
    const text = typeof value === 'string' ? value.trim() : '';

    if (typed && typeof value === 'string' && text === '') {
      if (blankDeclaresRequired) {
        out[key] = value;
      }

      return out;
    }

    if (typeof base === 'number' && text !== '' && !isNaN(Number(text))) {
      out[key] = Number(text);
    } else if (typeof base === 'boolean' && BOOLEAN_WORDS[text.toLowerCase()] !== undefined) {
      out[key] = BOOLEAN_WORDS[text.toLowerCase()];
    } else {
      out[key] = value;
    }

    return out;
  }, {});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderTemplates(app: any, instance: any): Template[] {
  const values = mergeValues(app, instance);

  return (app?.spec?.templates || []).map((template: Template, i: number) => ({
    name:    substitute(template?.name || `resource-${ i }.yaml`, values, app?.spec?.values),
    content: substitute(template?.content || '', values, app?.spec?.values),
  }));
}
