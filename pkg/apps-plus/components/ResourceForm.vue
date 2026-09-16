<script>
import jsyaml from 'js-yaml';
import { markRaw } from 'vue';
import { Banner } from '@components/Banner';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import { builder } from '../builder/state';
import { steveTypeFor } from '../probe';
import {
  readAt, applyToggle, parameterAt, isNever
} from '../fields';
import { substitute } from '../render';
import { dumpTemplate } from '../import-resource';
import { wiredInputs, isWired } from '../builder/form-wiring';

// The switch's footprint after the scale below: ToggleSwitch is 48x24, and 0.55 of that is a
// control small enough to sit beside a field's label rather than on top of the field.
const MARK_SCALE = 0.7;
const MARK_HEIGHT = Math.round(24 * MARK_SCALE);
// How far after the label's last word the switch starts.
const MARK_GAP = 6;
// What the scaled switch occupies, for the rows where it has to be tucked inside its anchor.
const MARK_WIDTH = Math.round((48 + 6) * MARK_SCALE);

/**
 * The id Steve would give this object.
 *
 * A small fiction - the resource has not been created - and the same one as rendering its edit
 * page at all. It earns its place because "has an id" is how a form tells an existing resource
 * from one being created, and some of them decide what to show on exactly that: the cluster
 * form only works out its own provider `if (value?.id)`, and without one it stops and asks
 * which kind of cluster you would like to make. There is nothing to make.
 */
function idFor(manifest) {
  const name = manifest?.metadata?.name || '';
  const namespace = manifest?.metadata?.namespace || '';

  return namespace ? `${ namespace }/${ name }` : name;
}

/**
 * Where an anchor's words actually are.
 *
 * A `.labeled-input`'s `<label>` is a block, so its box is the full width of the field and
 * "beside the label" put the switch out at the field's right edge, level with nothing. A range
 * over the label's contents measures the text instead, which is what somebody means by beside.
 */
function textRect(el) {
  if (el.tagName === 'LABEL') {
    const range = document.createRange();

    range.selectNodeContents(el);

    const rect = range.getBoundingClientRect();

    range.detach?.();

    if (rect.width > 0) {
      return rect;
    }
  }

  return el.getBoundingClientRect();
}

/**
 * A staged resource's own edit page, read-only, with a switch on every field an installation
 * could be allowed to set.
 *
 * The drawer already had two ways to look at a staged template: a list of the fields worth
 * parameterising, and the YAML. Neither is the page somebody knows. This is that page - the
 * component Rancher itself renders for the type, asked for by type rather than imported, so a
 * Deployment gets the workload form with its container tabs and a ConfigMap gets the key/value
 * table, and an extension that registers an edit page for its own CRD gets that.
 *
 * Rendered in view mode, which is what makes it safe to show a resource that does not exist:
 * there is nothing to save, no Save button, and every input is disabled. The switches are the
 * only controls on it, and each one marks a field on the *staged template* - `${param}` goes
 * into the YAML with the value on screen as its default - through the same applyToggle the
 * drawer's Customizable list and the page marks use, so none of the three can disagree.
 *
 * The model the form is bound to is built from the staged template, not fetched: the whole
 * point is that this app has not been installed anywhere yet. `${...}` is substituted first, so
 * the page shows the values an installation would get rather than the placeholders.
 */
export default {
  name: 'ResourceForm',

  // The slide-in panel binds every one of its own options onto this component, so `width`,
  // `height` and the rest would otherwise land as attributes on the root div.
  inheritAttrs: false,

  components: { Banner, ToggleSwitch },

  props: {
    /** The staged template to render. See StagedTemplate in builder/state. */
    template: {
      type:     Object,
      required: true,
    },
  },

  data() {
    return {
      builder,
      component: null,
      model:     null,
      /** The Steve type the page was asked for, e.g. `apps.deployment`. See settleSubtype. */
      steveType: '',
      /**
       * The manifest the model on screen was built from, taken once.
       *
       * A snapshot rather than the live `rendered`, because the form is built once and does not
       * follow the values afterwards - so the wiring must not either. Editing a parameter's
       * default in the drawer while this page is open changes `rendered` and nothing on screen,
       * and resolving the container panels against the new one found no container by the name
       * the page is still showing: every switch in that panel disappeared.
       */
      manifest:  null,
      error:     '',
      /** A reason there is no page that is not a failure - see the multi-document case. */
      notice:    '',
      // { id, path, top, left, visible }
      marks:     [],
    };
  },

  computed: {
    /**
     * Whether this kind's form has been wired up to manifest paths (see builder/form-wiring).
     * An unwired kind still gets its page - the page is worth having on its own - it just has
     * no switches on it, and says so rather than looking like a page whose switches failed.
     *
     * The YAML's kind, not the card's. The card's is what the resource was when it was staged
     * and it is never revised; the page on screen is built from the YAML as it stands, so a
     * card whose file has been edited into a Secret must not be told the ConfigMap story.
     */
    isWiredKind() {
      return isWired(this.kind);
    },

    /** The kind actually on screen, which is the YAML's and not the card's. */
    kind() {
      return this.manifest?.kind || this.template.kind || '';
    },

    /**
     * Which provider a staged Cluster is for, read out of its own machine pools.
     *
     * The model answers this from `mgmt.machineProvider` - the management cluster paired with a
     * real one - so for a template it answers nothing. The manifest knows: a pool's
     * `machineConfigRef.kind` is `Amazonec2Config` for the driver `amazonec2`, and a cluster
     * with no pools at all is the custom kind, where the nodes are registered by hand.
     */
    clusterProvider() {
      if (this.kind !== 'Cluster') {
        return '';
      }

      const pools = this.manifest?.spec?.rkeConfig?.machinePools || [];
      const ref = pools.find((pool) => pool?.machineConfigRef?.kind)?.machineConfigRef?.kind || '';

      return ref ? ref.replace(/Config$/, '').toLowerCase() : 'custom';
    },

    /** The staged YAML as it stands, which is where a switch's on/off state is read from. */
    raw() {
      try {
        return jsyaml.load(this.template.content) || null;
      } catch {
        return null;
      }
    },

    /**
     * The values the page is rendered with: the app's, plus stand-ins for the four an
     * installation supplies about itself. Without them the name box reads `${install}-hello`,
     * which is the placeholder rather than the page.
     */
    previewValues() {
      return {
        app:       this.builder.app || 'app',
        install:   'install',
        instance:  'install',
        cluster:   'cluster',
        namespace: 'default',
        ...this.builder.values,
      };
    },

    /**
     * The manifest the page is showing: the staged YAML with `${...}` substituted.
     *
     * The wiring is resolved against this rather than against `raw`, because the wiring's job
     * is to say what the boxes *on screen* edit, and a box shows a substituted value. It
     * matters for the one wired field that is also an identity: parameterising a container's
     * Name puts `${name}` in the YAML while the tab still says `sidecar`, and looking that up
     * in `raw` finds nothing - which silently took every switch in that container's panel away,
     * including the one just turned on.
     */
    rendered() {
      return this.documents.length === 1 ? this.documents[0] : null;
    },

    /**
     * The resources this file holds, with `${...}` substituted.
     *
     * `loadAll` rather than `load`, because a template written by hand is often several
     * resources separated by `---` and `load` throws on those - which read as "this template is
     * not valid YAML", blaming the file for something it has every right to be.
     */
    documents() {
      try {
        return jsyaml.loadAll(substitute(this.template.content, this.previewValues))
          .filter((document) => !!document);
      } catch {
        return [];
      }
    },

    /** Which paths are parameters right now, so the switches can show it. */
    on() {
      const raw = this.raw;
      const out = {};

      if (raw) {
        this.marks.forEach((mark) => {
          out[mark.path] = !!parameterAt(raw, mark.path);
        });
      }

      return out;
    },
  },

  watch: {
    /**
     * Opening a second card's page while one is already open.
     *
     * The panel keeps one component and swaps its props, so this instance is reused rather than
     * remade - `mounted` does not run again, the model stays the one built for the card before,
     * and the switches are resolved against a manifest that is no longer on screen. Rebuilt on
     * the file name, not the content: the content changes on every toggle, and rebuilding there
     * would throw the page away each time somebody used it.
     */
    'template.name'() {
      this.component = null;
      this.model = null;
      this.manifest = null;
      this.steveType = '';
      this.error = '';
      this.notice = '';
      this.marks = [];
      this.markEls = new Map();
      this.signature = '';

      this.build();
    },
  },

  async mounted() {
    // DOM nodes are not state; keeping them out of Vue's reactivity also keeps a proxied
    // element from ever reaching getBoundingClientRect.
    this.markEls = new Map();
    this.signature = '';

    await this.build();

    this.timer = setInterval(() => this.scan(), 500);
    // Scrolling needs no listener: the switches are positioned in the scroll box's own
    // coordinates, so they move with the form for free. A resize changes the box itself.
    this.onMove = () => this.reposition();
    window.addEventListener('resize', this.onMove);
  },

  beforeUnmount() {
    clearInterval(this.timer);
    window.removeEventListener('resize', this.onMove);
  },

  /**
   * An edit page is somebody else's component fetching somebody else's resources, and this one
   * is being asked to render a resource that exists nowhere. When it throws, the drawer must
   * still be a drawer - so the failure is caught here and shown, rather than taking the panel
   * down with it.
   */
  errorCaptured(e) {
    this.failed(e);

    return false;
  },

  methods: {
    async build() {
      const manifest = this.rendered;

      if (!manifest) {
        // Told apart, because they are different problems with different answers: a file that
        // holds several resources is fine and simply has no single page, and one that does not
        // parse has to be fixed before anything can render it.
        if (this.documents.length > 1) {
          this.notice = this.t('appsPlus.form.multiple', { count: this.documents.length });
        } else {
          this.error = this.t('appsPlus.form.unparsed');
        }

        return;
      }

      const type = steveTypeFor(manifest?.apiVersion, manifest?.kind);

      if (!type) {
        this.error = this.t('appsPlus.form.unknown');

        return;
      }

      // Plain data, looked at rather than rendered, so it does not need to be reactive.
      this.manifest = markRaw(manifest);
      this.steveType = type;

      // Asked before importing, because importing a page that is not there fails as a webpack
      // module error - `Cannot find module './management.cattle.io.cluster'` - which reads as
      // something broken rather than as what it is. Plenty of types have no edit page at all: a
      // management.cattle.io Cluster is one, because Rancher edits clusters through the
      // provisioning type instead.
      if (!this.$store.getters['type-map/hasCustomEdit'](type)) {
        this.notice = this.t('appsPlus.form.noPage', { kind: manifest?.kind || type });

        return;
      }

      try {
        // Asked for by type, the same way the dashboard's own resource pages ask: whatever is
        // registered for this type is what somebody edits it with, including an extension's.
        this.component = markRaw(this.$store.getters['type-map/importEdit'](type));
        // Built in the store the type actually belongs to. Most of what gets staged is a
        // cluster resource, but a provisioning Cluster is a management one, and a model made in
        // the wrong store dispatches its own lookups into a store with no schema for it.
        const inStore = this.$store.getters['management/schemaFor'](type) ? 'management' : 'cluster';

        // `create` classifies rather than writes - it builds the model this type's form expects
        // and touches no cluster.
        this.model = await this.$store.dispatch(`${ inStore }/create`, { ...manifest, type, id: idFor(manifest) });
        this.unwait(this.model);
      } catch (e) {
        this.failed(e);
      }
    },

    /**
     * Say what went wrong in the terms somebody can do something about.
     *
     * One failure is common enough to be worth telling apart, and it is not a fault in anything
     * staged: an edit page for a cluster resource asks the cluster store for the rest of what it
     * shows - a Deployment form lists Services - and Rancher's management pages have no cluster
     * open, so that store is empty and the page dies partway through on a type nobody staged.
     * What arrives is `Unknown schema for type: service`, which reads as a broken template.
     *
     * The half-drawn form goes with it. A page that stopped in the middle of itself is not
     * something to leave on screen underneath an explanation of why it is not there.
     */
    failed(e) {
      const needsCluster = !this.$store.getters['cluster/schemaFor'](this.steveType);

      if (needsCluster && !this.$store.getters['currentCluster']) {
        this.component = null;
        this.model = null;
        this.marks = [];
        this.signature = '';
        this.notice = this.t('appsPlus.form.noCluster', { kind: this.manifest?.kind || this.steveType });

        return;
      }

      this.error = e?.message || String(e);
    },

    /**
     * Find the switches, and keep them where their fields are.
     *
     * Polled rather than watched: the form is a tree of tabs that appear, re-layout and swap as
     * somebody clicks through it, and none of that is anything this component is told about.
     */
    scan() {
      const host = this.$refs.form;

      if (!host || !this.model || !this.raw || !this.manifest) {
        return;
      }

      this.settleSubtype();

      const found = this.isWiredKind ?
        wiredInputs(this.kind, host, this.manifest, (key) => this.t(key)) :
        [];

      // A path a switch cannot honestly offer: one the template does not have - a form shows
      // fields a manifest leaves out - or one nothing may ever parameterise.
      const offerable = found.filter((input) => !isNever(input.path) && readAt(this.raw, input.path) !== undefined);
      const signature = offerable.map((input) => input.id).join('|');

      if (signature !== this.signature) {
        this.signature = signature;
        this.markEls = new Map(offerable.map((input) => [input.id, input]));
        this.marks = offerable.map((input) => ({
          id: input.id, path: input.path, top: 0, left: 0, visible: false,
        }));
      }

      this.reposition();
    },

    /**
     * Stop the form waiting for a resource that does not exist.
     *
     * An edit page is written for a resource that is *there*, so some of them begin by waiting
     * for the rest of it to arrive: the provisioning Cluster form awaits `waitForMgmt()`, which
     * polls for the management cluster that pairs with this one. Nothing is going to answer -
     * this cluster is a template for one that has never been created - so the page sat on
     * "Loading…" for ever, with no error, because nothing had gone wrong.
     *
     * Answered immediately instead. These are all "wait until the cluster catches up" helpers,
     * and there is no cluster to catch up: the model is a fabrication from staged YAML.
     */
    unwait(model) {
      ['waitForMgmt', 'waitForProvisioner', 'waitForProvisioningCluster'].forEach((method) => {
        if (typeof model[method] === 'function') {
          model[method] = () => Promise.resolve();
        }
      });
    },

    /**
     * Tell the workload form which kind of workload it is showing.
     *
     * Rancher's workload form takes that from `$route.params.resource` - the page you are on -
     * because it is normally reached by navigating to a Deployment. This page is reached from a
     * drawer that outlives every route, so opened from anywhere that is not a workload list the
     * form does not know what it is holding, and CruResource does the only thing it can: asks
     * which kind you would like to create. There is nothing to create. The kind is in the YAML.
     *
     * Set rather than passed, because the form reads the route directly and takes no prop for
     * it; and set rather than routed through its own `selectType`, which calls `$router.replace`
     * when it does not already know the type - navigating the dashboard underneath somebody who
     * opened a drawer.
     */
    settleSubtype() {
      const page = this.$refs.page;

      if (!page) {
        return;
      }

      // A workload's kind, which its form takes from the route.
      if ('type' in page && !page.type && this.steveType) {
        page.type = this.steveType;
      }

      // A cluster's provider, which its form takes from the management cluster paired with a
      // real one - so for a template it takes nothing, and asks which kind to create instead.
      if ('subType' in page && !page.subType && this.clusterProvider) {
        page.subType = this.clusterProvider;
      }
    },

    /**
     * Pin each switch to its field.
     *
     * Positioned inside the scrolling box rather than against the viewport, so the switches
     * scroll with the form and are clipped by it instead of floating over the page - which is
     * what a fixed overlay does the moment the sheet is not the whole screen.
     */
    reposition() {
      const scroll = this.$refs.scroll;

      if (!scroll) {
        return;
      }

      const box = scroll.getBoundingClientRect();

      this.marks.forEach((mark) => {
        const input = this.markEls.get(mark.id);
        // Visibility follows the *field* - a switch must not show for a tab that is not on
        // screen - while the position follows its label, which is what it sits beside.
        const rect = input?.el?.isConnected ? input.el.getBoundingClientRect() : null;
        const anchor = input?.anchor?.isConnected ? textRect(input.anchor) : rect;
        const visible = !!rect && rect.width > 0 && rect.height > 0 && !!anchor;
        // After the words when the anchor is a label, because a label is exactly as wide as its
        // text. Inside the right edge when it is not - a key/value row has no label, so the
        // switch belongs to the key box, and put after it that box's *value* is what it covers.
        const inside = input?.anchor?.tagName !== 'LABEL';
        const offset = inside ? -(MARK_WIDTH + MARK_GAP) : MARK_GAP;
        const top = visible ? Math.round(anchor.top - box.top + scroll.scrollTop + (anchor.height - MARK_HEIGHT) / 2) : 0;
        const left = visible ? Math.round(anchor.right - box.left + scroll.scrollLeft + offset) : 0;

        if (mark.visible !== visible || mark.top !== top || mark.left !== left) {
          mark.visible = visible;
          mark.top = top;
          mark.left = left;
        }
      });
    },

    /**
     * Mark this field as one an installation can set, or unmark it.
     *
     * The staged YAML is the only copy: `${param}` goes in at this path with what is on screen
     * as the default, and turning it off puts the default back. Nothing is written to the
     * cluster, and the page does not re-render - the value shown is the default, and it has not
     * changed.
     */
    toggle(mark) {
      const template = this.builder.templates.find((t) => t.name === this.template.name);
      const manifest = this.raw;

      if (!template || !manifest) {
        return;
      }

      const { values, labels } = applyToggle(manifest, mark.path, this.builder.values, this.builder.labels);

      template.content = dumpTemplate(manifest);
      this.builder.values = values;
      this.builder.labels = labels;
    },
  },
};
</script>

<template>
  <div class="rform">
    <!-- The message is in the slot rather than in :label, because a Banner renders its label
         as HTML: an apiserver or webpack error is full of quotes, and they arrive as &#39;. -->
    <Banner
      v-if="error"
      color="error"
    >
      {{ t('appsPlus.form.error') }} {{ error }}
    </Banner>
    <Banner
      v-else-if="notice"
      color="info"
      :label="notice"
    />
    <Banner
      v-else-if="!isWiredKind"
      color="info"
      :label="t('appsPlus.form.unwired', { kind })"
    />
    <Banner
      v-else
      color="info"
      :label="t('appsPlus.form.hint')"
    />

    <div
      ref="scroll"
      class="rform__scroll"
    >
      <div
        ref="form"
        class="rform__page"
      >
        <component
          :is="component"
          v-if="component && model"
          ref="page"
          :value="model"
          :initial-value="model"
          :live-value="model"
          mode="view"
          real-mode="view"
          :done-event="true"
          :use-tabbed-hash="false"
        />
      </div>

      <span
        v-for="mark in marks"
        v-show="mark.visible"
        :key="mark.id"
        v-clean-tooltip="{ content: t('appsPlus.form.toggleTip') + ' — ' + mark.path, triggers: ['hover', 'focus'] }"
        class="rform__mark"
        :style="{ top: mark.top + 'px', left: mark.left + 'px' }"
      >
        <ToggleSwitch
          :value="!!on[mark.path]"
          :aria-label="t('appsPlus.form.toggleTip') + ' ' + mark.path"
          @update:value="toggle(mark)"
        />
      </span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
// Kept in step with MARK_SCALE in the script above.
$mark-scale: 0.7;

.rform {
  display:        flex;
  flex-direction: column;
  min-height:     0;
  // The slide-in panel gives its content a definite height and scrolls it; the form does its
  // own scrolling, so it takes the whole panel and leaves the panel's scrollbar unused. Two
  // nested scrollers would also break the switches, which are positioned inside this one.
  height:         100%;
  flex:           1;

  &__scroll {
    position:   relative;
    overflow:   auto;
    flex:       1;
    min-height: 0;
    padding:    0 4px;
  }

  // Rancher's own forms assume a page, not a panel: without this the CruResource footer and the
  // side tabs read as a form that has been cut in half.
  &__page {
    padding-bottom: 20px;
  }

  /**
   * Rancher's own switch, shrunk and set beside the field's label.
   *
   * Scaled rather than reimplemented: it is the control people already know, with its own
   * colours, its own focus ring and its own keyboard behaviour, and a hand-drawn copy would
   * drift from it. Full size it is 48x24, which is bigger than the label it belongs to and
   * covers the value when placed on the field; at 0.55 it reads as an adornment of the label,
   * which is what it is.
   */
  &__mark {
    position:         absolute;
    z-index:          10;
    display:          block;
    transform:        scale(#{$mark-scale});
    transform-origin: left center;
    line-height:      0;
    // Its own ground. The label it sits beside is inside the field's box, so the switch lands on
    // the field's fill - and the off state is a pale track that disappears into it.
    padding:          3px;
    border-radius:    999px;
    background:       var(--body-bg);

    :deep(.toggle-container) {
      margin: 0;
    }

    // The off state has to read as a switch that is off, not as a stray dot. Rancher's own
    // track is tuned for a white form background; this one is on a filled input.
    :deep(input:not(:checked) + .slider) {
      background-color: var(--disabled-bg, var(--muted));
      opacity:          0.55;
    }
  }
}
</style>
