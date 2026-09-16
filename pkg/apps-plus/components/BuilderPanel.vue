<script>
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import YamlEditor from '@shell/components/YamlEditor';
import FieldPicker from './FieldPicker';
import ResourceForm from './ResourceForm';
import {
  APP, APP_INSTANCE, APP_QUERY, BLANK_CLUSTER, CREATE_ROUTE, DETAIL_ROUTE, PRODUCT_NAME
} from '../config/types';
import {
  builder, groupedTemplates, removeTemplate, clearStaged, danglingReferences, loadAppTemplates,
  dropAppTemplates, MIN_WIDTH
} from '../builder/state';
import { closeBuilder, resizeBuilder } from '../builder/overlay';
import { referencedVariables, BUILT_IN_VALUES } from '../render';

/** The dropdown row that means "make one", rather than the name of an app. */
const NEW_APP = '__new__';

/** How long after the last change the app is written. See queueSave. */
const SAVE_DELAY = 700;

/**
 * Build an app out of resources you are already looking at.
 *
 * The drawer stays open across pages, so the flow is: pick an app (or make one), walk around
 * Rancher, use "Add to Application" wherever you see something that belongs, fix up what got
 * collected, and Save once.
 *
 * Nothing here writes to the cluster until Save. That is the point - a half-built App object left
 * behind by somebody who wandered off is worse than no App at all, and staging is what makes
 * editing the YAML before it exists possible.
 */
export default {
  name: 'BuilderPanel',

  components: {
    LabeledSelect, LabeledInput, Banner, RcButton, YamlEditor, FieldPicker, ResourceForm
  },

  data() {
    return {
      builder,
      apps:      [],
      // Distinguishes "no apps exist" from "the list never arrived" - see loadApps.
      appsLoaded: false,
      expanded:  null,
      // Which half of an expanded card is showing: the fields, or the raw YAML.
      // 'fields' | 'yaml'
      view:      'fields',
      creating:  false,
      newName:   '',
      saving:    false,
      error:     '',
      // What was last written, so that reloading the app cannot start a loop of empty writes.
      lastWritten: '',
      // When the last write landed, which is all the footer needs to say "saved".
      savedAt:     0,
      saveTimer:   null,
      drag:      null,
      // A restored selection that no longer exists, kept so the banner can say which one.
      gone:      '',
      // Whether Clear has been pressed once and is waiting to be meant.
      confirmClear: false,
      confirmTimer: null,
      // The card being flashed to answer a re-add, and the timer that stops it.
      flashing:   '',
      flashTimer: null,
    };
  },

  async mounted() {
    await this.loadApps();

    // The selection comes back from localStorage, and the app it names may have been deleted
    // since. Restoring it anyway left the drawer reading "Building X" with Save enabled, and
    // pressing Save answered with a raw apiserver error - for doing nothing wrong. Checked
    // here rather than in restore(), because only the loaded list knows what exists.
    if (this.builder.app && this.appsLoaded && !this.selectedApp) {
      this.gone = this.builder.app;
      this.builder.app = '';
    }

    this.showAppTemplates();

    // A drawer that comes back with files collected before it was closed has changed nothing
    // since it mounted, so nothing would fire the watcher. Offer them to the app once.
    this.queueSave();
  },

  beforeUnmount() {
    clearTimeout(this.confirmTimer);
    clearTimeout(this.flashTimer);
    clearTimeout(this.saveTimer);
    document.removeEventListener('keydown', this.onKey);
    this.closeForm();
  },

  watch: {
    /** Anything the drawer holds changing is a change to write. */
    autoKey() {
      this.queueSave();
    },

    /**
     * The panel is Rancher's, so it can close without us: its glass, its Escape, or a route
     * change. Whichever way it goes, the card that opened it has to stop reading as open.
     */
    panelOpen(open) {
      if (!open && this.builder.form) {
        this.builder.form = '';
      }
    },

    /**
     * The other direction: removing a card, or clearing the drawer, drops `form` in the shared
     * state (see builder/state), and the panel showing that card has to go with it.
     */
    'builder.form'(name) {
      if (!name && this.panelOpen) {
        this.$store.commit('slideInPanel/close', undefined, { root: true });
      }

      // The panel listens for Escape on itself, which only hears it while focus is inside - and
      // the focus trap that would put it there is deliberately off, so that the drawer beside it
      // stays usable. Escape has to be listened for where the focus actually is instead.
      document.removeEventListener('keydown', this.onKey);

      if (name) {
        document.addEventListener('keydown', this.onKey);
      }
    },

    // Picking or creating an app is what resolves the "no longer exists" banner, and it is
    // also what decides which files the drawer is showing.
    'builder.app'(app) {
      if (app) {
        this.gone = '';
      }

      this.showAppTemplates();
    },

    /**
     * The check in mounted() covers a selection restored from storage; this covers the app
     * being deleted while the drawer is open. Watched rather than checked once, because the
     * name does not change when somebody deletes the app - the loaded list behind it does.
     */
    selectedApp(app) {
      if (!app && this.builder.app && this.appsLoaded) {
        this.gone = this.builder.app;
        this.builder.app = '';
      }
    },

    /**
     * A re-add stages nothing, so without this it is a click that visibly does nothing. The
     * state records which card already answers for the resource; this scrolls to it and
     * pulses it.
     */
    'builder.flash'(flash) {
      if (!flash?.name) {
        return;
      }

      this.flashing = flash.name;
      this.$nextTick(() => {
        this.$el.querySelector(`[data-template="${ CSS.escape(flash.name) }"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flashing = '';
        this.builder.flash = null;
      }, 1600);
    },
  },

  computed: {
    groups() {
      return groupedTemplates();
    },

    /**
     * References each card makes that nothing staged satisfies, by template name.
     *
     * Computed over all of them at once so the YAML is parsed when something changes rather
     * than on every render of every card.
     */
    danglingByName() {
      const out = {};

      this.builder.templates.forEach((template) => {
        out[template.name] = danglingReferences(template);
      });

      return out;
    },

    /** Whether Rancher's slide-in panel is showing anything, ours or somebody else's. */
    panelOpen() {
      return this.$store.getters['slideInPanel/isOpen'];
    },

    /**
     * The apps, and one row that is not an app.
     *
     * Making a new one is the same decision as picking an existing one - "which app am I
     * collecting into" - so it belongs in the same control rather than beside it as a button
     * competing for the same answer. The sentinel never reaches the state; see pickApp.
     */
    appOptions() {
      return [
        ...this.apps.map((app) => ({ label: app.metadata.name, value: app.metadata.name })),
        { label: this.t('appsPlus.builder.newApp'), value: NEW_APP },
      ];
    },

    /** The app being built, once it exists in the cluster. Null while a new one is being named. */
    selectedApp() {
      return this.apps.find((app) => app.metadata?.name === this.builder.app) || null;
    },

    /**
     * Everything a save would write, as one string.
     *
     * Watched rather than watching the pieces, so that one change is one save however many
     * fields it touched - a toggle rewrites the YAML, adds a value and adds a label.
     */
    autoKey() {
      return JSON.stringify({
        app:       this.builder.app,
        templates: this.builder.templates.map((template) => [template.name, template.content, !!template.saved]),
        values:    this.builder.values,
        labels:    this.builder.labels,
      });
    },

    /** The cards that are not yet in the app - what a save would add. */
    collected() {
      return this.builder.templates.filter((template) => !template.saved);
    },

    style() {
      return { width: `${ this.builder.width }px` };
    },
  },

  methods: {
    async loadApps() {
      try {
        this.apps = await this.$store.dispatch('management/findAll', { type: APP });
        this.appsLoaded = true;
      } catch {
        // A load that failed says nothing about what exists, so neither the stale-selection
        // check in mounted() nor the selectedApp watcher may treat it as "no apps".
        this.apps = [];
        this.appsLoaded = false;
      }
    },

    close() {
      closeBuilder();
    },

    /**
     * Picking a row: an app, or the one that is not an app.
     *
     * Bound to the event rather than v-model so the sentinel is never written into the state -
     * a `builder.app` of `__new__` is a name every other reader would try to look up.
     */
    pickApp(value) {
      if (value === NEW_APP) {
        this.creating = true;

        return;
      }

      this.builder.app = value || '';
    },

    /** Put the selected app's own files in the drawer, beside whatever is being collected. */
    showAppTemplates() {
      const app = this.selectedApp;

      if (!app) {
        dropAppTemplates();

        return;
      }

      loadAppTemplates(app.spec?.templates || [], app.spec?.values || {});

      // What the app already holds - not what the drawer would write. Recorded so that opening
      // the drawer on an app does not write it back to itself, while a file collected before
      // the app was picked still reads as a difference and gets saved.
      this.lastWritten = JSON.stringify({
        templates: app.spec?.templates || [],
        values:    app.spec?.values || {},
      });
    },

    toggle(name) {
      this.expanded = this.expanded === name ? null : name;
    },

    dismissNotice(skipped) {
      this.builder.notices = this.builder.notices.filter((notice) => notice.skipped !== skipped);
    },

    remove(name) {
      removeTemplate(name);

      if (this.expanded === name) {
        this.expanded = null;
      }
    },

    /**
     * Open the resource's edit page in Rancher's own slide-in panel.
     *
     * The same drawer "Show Configuration" uses - `slideInPanel/open` with a component and its
     * props - rather than an overlay of this extension's own. It is the panel people already
     * know: it slides from the right, darkens the page behind it, closes on its glass, on
     * Escape and on a route change, and it is where a Rancher user looks for this kind of thing.
     *
     * The focus trap is off on purpose. Every other user of this panel is a dead end you read
     * and dismiss; this one is half of a job whose other half is the builder drawer beside it,
     * and trapping focus would make the cards unreachable while the page they belong to is open.
     */
    openForm(name) {
      const template = this.builder.templates.find((t) => t.name === name);

      if (!template) {
        return;
      }

      this.builder.form = name;
      this.$store.commit('slideInPanel/open', {
        component:      ResourceForm,
        componentProps: {
          template,
          title:             name,
          width:             'wide',
          height:            'full',
          disableFocusTrap:  true,
          // Real navigation closes it; the page's own tabs do not. Rancher's Tabbed writes the
          // selected tab into the URL hash, and the panel's default is to close on any hash or
          // query change - so opening a form whose first tab announced itself closed the panel
          // that was showing it, a few hundred milliseconds after it appeared.
          closeOnRouteChange: ['name', 'params'],
          returnFocusSelector: `[data-template="${ CSS.escape(name) }"] .card__form`,
        },
      }, { root: true });
    },

    closeForm() {
      this.builder.form = '';
      this.$store.commit('slideInPanel/close', undefined, { root: true });
    },

    /** Escape closes our own page, and only ours - another panel's is not ours to dismiss. */
    onKey(event) {
      if (event.key === 'Escape' && this.builder.form) {
        this.closeForm();
      }
    },


    // Wrapped rather than bound straight from the import: the template only reaches what is on
    // the instance, and `@click="clearStaged"` silently did nothing.
    //
    // Two presses, because what it throws away can be twenty minutes of walking around
    // Rancher and there is no undo. The first press only changes the button into a question;
    // ignoring it for a few seconds withdraws the question.
    clearAll() {
      if (!this.confirmClear) {
        this.confirmClear = true;
        this.confirmTimer = setTimeout(() => {
          this.confirmClear = false;
        }, 5000);

        return;
      }

      clearTimeout(this.confirmTimer);
      this.confirmClear = false;
      clearStaged();
      this.expanded = null;
    },

    /**
     * Where Save leaves you.
     *
     * Collecting an app and installing it are one job done in two places, and the drawer used to
     * end at "Added 2 files" with no way through to either. These are that way through.
     */
    openApp() {
      this.$router.push({
        name:   DETAIL_ROUTE,
        params: {
          product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP, id: this.builder.app
        },
      });
    },

    installApp() {
      this.$router.push({
        name:   CREATE_ROUTE,
        params: {
          product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP_INSTANCE
        },
        query: { [APP_QUERY]: this.builder.app },
      });
    },

    updateContent(name, content) {
      const template = this.builder.templates.find((t) => t.name === name);

      if (template) {
        template.content = content;
      }
    },

    /**
     * Make an empty app to collect into.
     *
     * Created for real rather than staged, because the app is what everything else here is
     * selected against - a name that exists nowhere would leave the drawer pointing at nothing
     * and the Save button unable to say where it was saving to.
     */
    async createApp() {
      const name = (this.newName || '').trim();

      if (!name) {
        return;
      }

      this.saving = true;
      this.error = '';

      try {
        const app = await this.$store.dispatch('management/create', {
          type:     APP,
          metadata: { name },
          spec:     { templates: [], values: {} },
        });

        await app.save();
        await this.loadApps();

        this.builder.app = name;
        this.creating = false;
        this.newName = '';
      } catch (e) {
        this.error = e?.message || `Could not create ${ name }.`;
      } finally {
        this.saving = false;
      }
    },

    /**
     * What the app should hold, given what the drawer is showing.
     *
     * Three groups. Files the app has and the drawer still shows are kept, carrying whatever
     * was edited in them; a file the drawer no longer shows is left out, which is what removing
     * its card has to mean once the drawer is showing the app rather than only a collection.
     * Files that are new are appended, and a name that collides gets a number.
     *
     * The values are the drawer's rather than a merge under the app's: they were loaded from
     * the app and have been on screen ever since, so what the drawer holds is what somebody has
     * decided - including a value they turned off, which a merge would quietly put back.
     */
    specFor(app) {
      const existing = app.spec?.templates || [];
      const edited = new Map(this.builder.templates.filter((template) => template.saved)
        .map((template) => [template.name, template.content]));

      const kept = existing
        .filter((template) => edited.has(template.name))
        .map((template) => ({ ...template, content: edited.get(template.name) }));

      const taken = new Set(kept.map((template) => template.name));
      const renamed = new Map();

      const added = this.collected.map((template) => {
        let name = template.name;

        for (let i = 2; taken.has(name); i++) {
          name = template.name.replace(/\.yaml$/, `-${ i }.yaml`);
        }

        taken.add(name);

        if (name !== template.name) {
          renamed.set(template.name, name);
        }

        return { name, content: template.content };
      });

      // Only the values these templates actually refer to.
      //
      // A value exists in the drawer because a field was toggled on some resource; if the file
      // that introduced it has since been removed, or its `${...}` edited away in the YAML tab,
      // the value is left declaring a parameter the app does not have. Every install form then
      // asks for it, which is how an app whose templates say nothing but `${text}` came to have
      // an `adminPassword` on its form.
      //
      // Built-ins are never written: they are supplied at render time and declaring one would
      // make the app ask for something it already has.
      const used = new Set([...kept, ...added]
        .flatMap((template) => referencedVariables(template.content || ''))
        .filter((name) => !BUILT_IN_VALUES.includes(name)));

      const values = Object.fromEntries(
        Object.entries(this.builder.values).filter(([name]) => used.has(name))
      );

      return {
        renamed,
        spec: {
          templates: [...kept, ...added],
          values,
        },
      };
    },

    /**
     * Write, a moment after the last change rather than on every one.
     *
     * A toggle is one change; typing in the YAML editor is one per keystroke. The delay is what
     * turns the second into a save, and it is short enough that closing the drawer straight
     * after a toggle still lands - the write is dispatched, not deferred to a moment that may
     * never come.
     */
    queueSave() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persist(), SAVE_DELAY);
    },

    /**
     * Put what the drawer is showing into the app.
     *
     * Fetched fresh each time rather than saved through the copy the list has, because the
     * drawer outlives every page and the app may have been edited on one of them. Compared
     * against what was last written before saving, so that reloading the app's own files - or
     * marking them saved below - cannot start a loop of writes that change nothing.
     */
    async persist() {
      if (!this.selectedApp || this.saving) {
        return;
      }

      this.saving = true;
      this.error = '';

      try {
        const app = await this.$store.dispatch('management/find', {
          type: APP, id: this.builder.app, opt: { force: true },
        });

        const { spec, renamed } = this.specFor(app);
        const signature = JSON.stringify(spec);

        if (signature !== this.lastWritten) {
          app.spec = { ...app.spec, ...spec };

          await app.save();

          this.lastWritten = signature;
          await this.loadApps();
        }

        // Everything on screen is in the app now, so the next change edits rather than appends.
        this.builder.templates.forEach((template) => {
          const name = renamed.get(template.name);

          if (name) {
            if (this.builder.form === template.name) {
              this.builder.form = name;
            }

            template.name = name;
          }

          template.saved = true;
        });

        this.savedAt = Date.now();
      } catch (e) {
        this.error = e?.message || 'Could not save.';
      } finally {
        this.saving = false;
      }
    },

    // ---------------------------------------------------------------- resize

    onGrab(event) {
      this.drag = { startX: event.clientX, width: this.builder.width };
      window.addEventListener('mousemove', this.onDrag);
      window.addEventListener('mouseup', this.endGrab);
      event.preventDefault();
    },

    onDrag(event) {
      if (!this.drag) {
        return;
      }

      const width = this.drag.width + (event.clientX - this.drag.startX);

      resizeBuilder(Math.max(MIN_WIDTH, Math.min(width, window.innerWidth - 320)));
    },

    endGrab() {
      this.drag = null;
      window.removeEventListener('mousemove', this.onDrag);
      window.removeEventListener('mouseup', this.endGrab);
    },
  },
};
</script>

<template>
  <div
    v-if="builder.open"
    class="builder"
    :style="style"
  >
    <header class="builder__head">
      <span class="builder__title">{{ t('appsPlus.builder.title') }}</span>
      <RcButton
        variant="tertiary"
        :aria-label="t('generic.close')"
        @click="close"
      >
        {{ t('generic.close') }}
      </RcButton>
    </header>

    <div class="builder__app">
      <template v-if="creating">
        <LabeledInput
          v-model:value="newName"
          :label="t('appsPlus.builder.newApp')"
          :placeholder="t('appsPlus.builder.newAppPlaceholder')"
          @keyup.enter="createApp"
        />
        <div class="builder__row">
          <RcButton
            variant="tertiary"
            @click="creating = false"
          >
            {{ t('generic.cancel') }}
          </RcButton>
          <RcButton
            variant="secondary"
            :disabled="!newName.trim() || saving"
            @click="createApp"
          >
            {{ t('appsPlus.builder.create') }}
          </RcButton>
        </div>
      </template>

      <template v-else>
        <!--
          append-to-body off: mounted on <body> the menu hangs at a viewport position and
          stays put while the drawer scrolls under it. Inside the drawer it stacks in the
          drawer's own context and moves with the field it belongs to.
        -->
        <LabeledSelect
          :value="builder.app"
          :options="appOptions"
          :searchable="true"
          :append-to-body="false"
          :label="t('appsPlus.builder.app')"
          :placeholder="t('appsPlus.builder.appPlaceholder')"
          @update:value="pickApp"
        />
      </template>
    </div>

    <Banner
      v-if="gone"
      color="warning"
      :label="t('appsPlus.builder.appGone', { app: gone })"
    />
    <Banner
      v-else-if="!builder.app"
      color="info"
      :label="t('appsPlus.builder.pickFirst')"
    />
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <!-- A bulk add that dropped something must say so: "2 selected" quietly becoming one
         card reads as the add working, and the missing resource is only noticed on install. -->
    <Banner
      v-for="notice in builder.notices"
      :key="notice.skipped"
      color="warning"
      :closable="true"
      :label="t('appsPlus.builder.skipped', notice)"
      @close="dismissNotice(notice.skipped)"
    />
    <div class="builder__list">
      <p
        v-if="!builder.templates.length"
        class="builder__empty"
      >
        {{ t('appsPlus.builder.empty') }}
      </p>

      <div
        v-for="group in groups"
        :key="group.kind"
        class="group"
      >
        <div class="group__kind">
          {{ group.kind }}
          <span class="group__count">{{ group.templates.length }}</span>
        </div>

        <div
          v-for="template in group.templates"
          :key="template.name"
          class="card"
          :class="{ 'card--open': expanded === template.name, 'card--flash': flashing === template.name }"
          :data-template="template.name"
        >
          <div class="card__row">
            <button
              class="card__head"
              type="button"
              @click="toggle(template.name)"
            >
              <i
                class="icon"
                :class="expanded === template.name ? 'icon-chevron-down' : 'icon-chevron-right'"
              />
              <span class="card__text">
                <span class="card__name">{{ template.name }}</span>
                <span
                  v-if="template.source || template.saved"
                  class="card__source"
                >{{ template.saved ? t('appsPlus.builder.inApp') : template.source }}</span>
              </span>
            </button>

            <!-- The resource's own edit page, over the whole window: the drawer is too narrow
                 to be a form, and this is the page somebody already knows. -->
            <RcButton
              variant="tertiary"
              class="card__form"
              :aria-label="t('appsPlus.form.open') + ' ' + template.name"
              @click="openForm(template.name)"
            >
              {{ t('appsPlus.form.open') }}
            </RcButton>

            <RcButton
              variant="tertiary"
              class="card__remove"
              @click="remove(template.name)"
            >
              {{ t('generic.remove') }}
            </RcButton>
          </div>

          <!-- Always visible, not only when expanded: a reference nothing here satisfies is
               the kind of thing that installs cleanly and fails a day later. -->
          <p
            v-for="ref in danglingByName[template.name]"
            :key="`${ template.name }-${ ref.kind }-${ ref.name }`"
            class="card__dangling"
          >
            <i class="icon icon-warning" />
            {{ t('appsPlus.builder.dangling', { kind: ref.kind, name: ref.name }) }}
          </p>

          <template v-if="expanded === template.name">
            <!--
              Fields first, YAML behind a switch. The YAML is the source of truth and always
              reachable, but it is not what somebody opening a card wants to read - they want
              the three lines of it that an installation will change.
            -->
            <div class="card__tabs">
              <button
                v-for="tab in ['fields', 'yaml']"
                :key="tab"
                type="button"
                :class="{ 'card__tab--on': view === tab }"
                class="card__tab"
                @click="view = tab"
              >
                {{ t(tab === 'fields' ? 'appsPlus.fields.tab' : 'appsPlus.fields.yamlTab') }}
              </button>
            </div>

            <FieldPicker
              v-if="view === 'fields'"
              :content="template.content"
              :values="builder.values"
              :labels="builder.labels"
              class="card__fields"
              @update:content="v => updateContent(template.name, v)"
              @update:values="v => builder.values = v"
              @update:labels="v => builder.labels = v"
            />

            <YamlEditor
              v-else
              :key="template.name"
              :value="template.content"
              :hide-preview-buttons="true"
              class="card__yaml"
              @update:value="v => updateContent(template.name, v)"
            />
          </template>
        </div>
      </div>
    </div>

    <footer class="builder__foot">
      <RcButton
        variant="tertiary"
        :disabled="!collected.length"
        :class="{ 'builder__clear-confirm': confirmClear }"
        @click="clearAll"
      >
        {{ confirmClear ? t('appsPlus.builder.clearConfirm', { count: collected.length }) : t('appsPlus.builder.clear') }}
      </RcButton>
      <span class="builder__status">
        {{ saving ? t('appsPlus.builder.saving') : (savedAt ? t('appsPlus.builder.autosaved') : '') }}
      </span>

      <span
        v-if="selectedApp"
        class="builder__next"
      >
        <RcButton
          variant="tertiary"
          @click="openApp"
        >
          {{ t('appsPlus.builder.openApp') }}
        </RcButton>
        <RcButton
          variant="tertiary"
          @click="installApp"
        >
          {{ t('appsPlus.action.createInstance') }}
        </RcButton>
      </span>
    </footer>

    <!-- The edge, four pixels wide, with no paint of its own so the border stays the only line. -->
    <div
      class="builder__grip"
      @mousedown="onGrab"
    />

  </div>
</template>

<style lang="scss" scoped>
.builder {
  position:       fixed;
  top:            0;
  left:           0;
  bottom:         0;
  /**
   * Above everything, which for this drawer is the point.
   *
   * It is not an overlay on a page, it is a second surface beside one: it outlives every page,
   * and the edit pages it opens are Rancher's own full-height slide-in panel, which paints its
   * glass at 101 and itself at 102. Below those the drawer would be dimmed and unreachable
   * while the page it opened is up, and using the two together is the whole flow.
   *
   * The cost is real and worth naming: this now outranks the shell's modals (54) and dropdown
   * overlays (56), so a dialog opened from the page underneath is painted behind the drawer's
   * strip rather than over it. Dropdowns *inside* the drawer are unaffected - they stack in its
   * own context - and the page itself still cannot overlap, because the drawer's width is
   * padding taken out of .dashboard-root rather than paint over it.
   */
  z-index:        103;
  display:        flex;
  flex-direction: column;
  background:     var(--body-bg);
  border-right:   1px solid var(--border);
  box-shadow:     0 0 18px var(--shadow, rgba(0, 0, 0, 0.25));

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    padding:         12px 14px;
    border-bottom:   1px solid var(--border);
  }

  &__title { font-weight: 600; }

  &__app {
    padding:       12px 14px;
    border-bottom: 1px solid var(--border);
  }

  &__row {
    display:         flex;
    justify-content: flex-end;
    gap:             8px;
    margin-top:      8px;
  }

  &__list {
    flex:       1;
    overflow-y: auto;
    padding:    12px 14px;
  }

  &__saved {
    display:        flex;
    flex-direction: column;
    gap:            6px;
  }

  &__next {
    display: flex;
    gap:     8px;
  }

  // Between Clear and the two ways onward, taking the slack so both ends stay put.
  &__status {
    flex:      1;
    color:     var(--muted);
    font-size: 11px;
  }

  &__empty {
    color:      var(--muted);
    font-size:  12px;
    text-align: center;
    margin-top: 24px;
  }

  &__foot {
    display:         flex;
    align-items:     center;
    gap:             8px;
    padding:         12px 14px;
    border-top:      1px solid var(--border);
  }

  // The question form of the Clear button. Colored like the loss it is about to cause, so the
  // second press is made knowingly. Doubled specificity because RcButton's own variant color
  // outranks a single class.
  &__foot &__clear-confirm.rc-button {
    color: var(--error);
  }

  &__grip {
    position: absolute;
    top:      0;
    bottom:   0;
    right:    -2px;
    width:    5px;
    cursor:   ew-resize;
    z-index:  2;
  }
}

.group {
  margin-bottom: 16px;

  &__kind {
    display:        flex;
    align-items:    center;
    gap:            6px;
    font-size:      11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color:          var(--muted);
    margin-bottom:  6px;
  }

  &__count {
    background:    var(--nav-bg);
    border-radius: 8px;
    padding:       0 6px;
  }
}

.card {
  border:        1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 6px;
  position:      relative;

  &--open { background: var(--nav-bg); }

  // The answer to a re-add: the card the resource already has, pulsed instead of duplicated.
  &--flash {
    animation: card-flash 0.8s ease-in-out 2;
  }

  // The name and where it came from stack, so a long source truncates instead of pushing the
  // Remove button out of the card.
  &__row {
    display:     flex;
    align-items: center;
    gap:         4px;
    padding:     4px 6px 4px 8px;
  }

  &__head {
    display:     flex;
    align-items: center;
    gap:         8px;
    flex:        1;
    min-width:   0;
    padding:     4px 0;
    background:  none;
    border:      none;
    color:       inherit;
    cursor:      pointer;
    text-align:  left;
  }

  &__text {
    display:        flex;
    flex-direction: column;
    min-width:      0;
  }

  &__name {
    font-family: monospace;
    font-size:   12px;
  }

  &__source {
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__remove { flex-shrink: 0; }

  &__form { flex-shrink: 0; }

  &__dangling {
    margin:    0;
    padding:   2px 8px 4px 30px;
    font-size: 11px;
    color:     var(--warning);
  }

  /**
   * Capped, and scrolling inside itself.
   *
   * YamlEditor grows to its content, and a Deployment is a hundred lines - so one expanded card
   * pushed the group below it, the Save button and every other card off the bottom of a drawer
   * that is the height of the window. A card should stay a card.
   */
  &__yaml {
    height:      320px;
    max-height:  40vh;
    overflow:    auto;
    border-top:  1px solid var(--border);
  }

  &__fields {
    max-height: 44vh;
    overflow:   auto;
    border-top: 1px solid var(--border);
  }

  &__tabs {
    display:    flex;
    gap:        2px;
    padding:    0 6px;
    border-top: 1px solid var(--border);
  }

  &__tab {
    background:    none;
    border:        none;
    border-bottom: 2px solid transparent;
    color:         var(--muted);
    cursor:        pointer;
    font-size:     11px;
    padding:       6px 8px;

    &--on {
      color:         var(--body-text);
      border-color:  var(--primary);
    }
  }
}

@keyframes card-flash {
  50% {
    background:   var(--info-banner-bg, var(--info));
    border-color: var(--primary);
  }
}
</style>
