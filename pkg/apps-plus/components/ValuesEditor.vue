<script>
import KeyValue from '@shell/components/form/KeyValue';
import { typedOverrides } from '../render';

/**
 * The values editor, used by both the App's Default Values and an installation's Values.
 *
 * It exists because those two were the same eight props copied twice, and the copies had
 * already started to drift - one had a key dropdown before the other did. Anything that should
 * be true of "editing values" is true in one place now: which keys are offered, what a key that
 * no template mentions looks like, and the fact that the two columns are the same height.
 */
export default {
  name: 'ValuesEditor',

  components: { KeyValue },

  props: {
    /** The values themselves, as a plain map. */
    value: {
      type:    Object,
      default: () => ({}),
    },

    mode: {
      type:     String,
      required: true,
    },

    /**
     * Every key the templates actually refer to, which is both the dropdown's options and the
     * measure of whether a key still means anything.
     */
    keys: {
      type:    Array,
      default: () => [],
    },

    placeholder: {
      type:    String,
      default: '',
    },
  },

  emits: ['update:value'],

  computed: {
    /**
     * The keys as options, not as strings.
     *
     * KeyValue's uniqueness filter compares `option.value` against the keys already in use, so
     * a list of plain strings makes it compare `undefined` to every one of them, match nothing,
     * and go on offering a key that another row has already taken. The shape is the fix.
     */
    keyOptions() {
      return this.keys.map((key) => ({ label: key, value: key }));
    },

    /**
     * The values as text, which is the only thing KeyValue can hold.
     *
     * A default keeps the type it had in the YAML - see applyToggle, which is what lets a
     * `replicas` of 2 go back into the template as 2 rather than as '2'. KeyValue base64-decodes
     * every value it is handed, so a number reached `string.replace is not a function`, and
     * because that throws inside a computed the table went on rendering the rows it had before:
     * parameterising `replicas` made the Default Values list silently stop updating, with the
     * error only in the console.
     */
    shown() {
      return Object.entries(this.value || {}).reduce((out, [key, value]) => {
        out[key] = value === undefined || value === null ? '' : String(value);

        return out;
      }, {});
    },

    /**
     * Values that no template refers to any more.
     *
     * A template is edited far more often than the values beside it, so a `${greeting}` that
     * gets renamed or deleted leaves a value that will never be substituted into anything, and
     * nothing about the row says so. It is not an error and nothing is removed: a value is
     * cheap to keep, the template may be coming back, and deleting somebody's data because a
     * variable is momentarily unreferenced would be worse than the confusion. It is marked, and
     * the person decides.
     *
     * Empty while there are no keys at all, which is the case before an app has been chosen on
     * the installation form - marking every row there would be noise on a form nobody has
     * finished filling in.
     */
    stale() {
      if (!this.keys.length) {
        return {};
      }

      const used = new Set(this.keys);

      return Object.keys(this.value || {}).reduce((acc, key) => {
        if (key && !used.has(key)) {
          acc[key] = this.t('appsPlus.values.unused', { key });
        }

        return acc;
      }, {});
    },
  },

  methods: {
    /**
     * What was edited, carrying the types of what it was edited from.
     *
     * KeyValue hands back a string for every row, so emitting its map as it comes turned every
     * typed default into text - and this table edits `spec.values`, which is where substitution
     * learns whether a parameter is a number, a boolean or a string. Retyping a `replicas`
     * default from 2 to 3 stored the string '3', and the renderer, told the app declared a
     * string, quoted it: `replicas: '3'`, rejected by the apiserver, with nothing wrong on
     * screen and no failure until an installation would not apply.
     *
     * The same function the deploy path uses for an installation's overrides, because it is the
     * same problem: text on one side, a declared type on the other. Sharing it is what keeps
     * the two from drifting.
     */
    merged(edited) {
      // Blank here declares a required parameter rather than asking for the default: this table
      // is the declaration. See typedOverrides, which is the same function the deploy path runs
      // over an installation's overrides, where blank means the other thing.
      return typedOverrides(this.value || {}, edited, true);
    },

  },
};
</script>

<template>
  <!--
    Adding a row is how a parameter is declared. The app's set of parameters IS the set of keys
    here (see appVariables in render.ts), so typing a new key is not a mistake to guard against
    any more - it is the only way to introduce a `${...}` for a template written by hand.
    `key-taggable` is what allows the typing; the dropdown still offers what already exists.

    `value-can-be-empty` because declaring a key with no default is the required-value case,
    not a mistake: without it KeyValue drops the key from what it emits until a default is
    typed, and the declaration silently never happens.
  -->
  <KeyValue
    class="values-editor"
    :value="shown"
    :mode="mode"
    :read-allowed="false"
    :as-map="true"
    :value-can-be-empty="true"
    :key-options="keyOptions"
    :key-taggable="true"
    :key-option-unique="true"
    :key-errors="stale"
    :key-placeholder="placeholder"
    @update:value="v => $emit('update:value', merged(v))"
  >
    <!--
      KeyValue's own Add disables itself once every option in key-options is a row - which under
      the declared model is always, since the options ARE the rows' keys. Adding a row here is
      how a NEW key is declared, so the button has to work precisely when the stock one gives up.
    -->
    <template #add="{ add }">
      <button
        type="button"
        class="btn role-tertiary add"
        data-testid="values-editor-add"
        @click="add()"
      >
        <i class="mr-5 icon icon-plus" /> {{ t('generic.add') }}
      </button>
    </template>
  </KeyValue>
</template>

<style lang="scss" scoped>
/**
 * One height for both columns.
 *
 * The value is a 40px control. The key becomes a Select the moment it is given options, and the
 * box that is actually drawn there is `.unlabeled-select` - 40px of dropdown wrapped in 3px of
 * its own padding and a 1px border, so 48. Setting the inner toggle to 40 changes nothing,
 * because it was already 40; the padding is what has to go.
 *
 * The toggle then fills what is left inside the border, and the selected text is centred by the
 * flex box rather than by the padding that used to hold it down.
 */
.values-editor :deep(.kv-item.key) {
  .unlabeled-select {
    height: 40px;
    min-height: 40px;
    padding-top: 0;
    padding-bottom: 0;
  }

  .v-select,
  .vs__dropdown-toggle {
    height: 100%;
    min-height: 0;
  }

  .vs__selected-options {
    padding-top: 0;
    align-items: center;
  }
}
</style>
