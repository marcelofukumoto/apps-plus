<script>
import jsyaml from 'js-yaml';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import {
  leafFields, isNever, applyToggle, writeAt
} from '../fields';
import { dumpTemplate } from '../import-resource';

/**
 * What an installation of this app will be able to change, and nothing else.
 *
 * This used to be where fields were *found*: a guessed shortlist of the ones usually worth
 * parameterising, plus a search box over the rest. Choosing happens on the resource's own edit
 * page now, where the field has a name, a section and a value in front of it instead of a
 * JSONPath - so what is left here is the answer rather than the search, and a list of every
 * field a Deployment has was only ever in the way of reading it.
 *
 * So: one row per parameter, with the name an installation will see and the default it starts
 * from, both editable. The switch turns it back off.
 *
 * The YAML remains the only copy. Every change rewrites it and re-reads it, so a field somebody
 * parameterised by hand shows here too, and nothing can drift out of step with what will
 * actually be deployed.
 */
export default {
  name: 'FieldPicker',

  components: { LabeledInput, Banner, ToggleSwitch },

  props: {
    /** The template body. */
    content: {
      type:     String,
      required: true,
    },

    /** The app's values, so a default can be written beside the parameter that needs it. */
    values: {
      type:    Object,
      default: () => ({}),
    },

    /**
     * The words each parameter wears on the install form, keyed like `values`.
     *
     * Written here because this is the moment the words exist: the field's friendly label is on
     * screen when the toggle is flicked, and without recording it the install form is left
     * showing `image` where the definer was shown "Container Image".
     */
    labels: {
      type:    Object,
      default: () => ({}),
    },
  },

  emits: ['update:content', 'update:values', 'update:labels'],


  computed: {
    manifest() {
      try {
        return jsyaml.load(this.content) || null;
      } catch {
        return null;
      }
    },

    /**
     * The fields that are already parameters, in the order the manifest holds them.
     *
     * Read out of the YAML rather than out of the values, so this cannot disagree with what is
     * deployed: a `${...}` somebody typed into the file by hand is a parameter and appears here,
     * and a value with nothing referring to it does not (the values editor marks those instead).
     */
    chosen() {
      return this.manifest ? leafFields(this.manifest).filter((field) => field.parameter && !isNever(field.path)) : [];
    },
  },

  methods: {
    /**
     * Turn a field into a parameter, or turn it back into a value.
     *
     * On: the current value becomes the default and the field becomes `${name}`. Off: the
     * default is written back into the YAML and the value is dropped, because a default for a
     * parameter nothing refers to is exactly what the stale marker in the values editor
     * complains about.
     */
    toggle(field) {
      const manifest = this.manifest;

      if (!manifest) {
        return;
      }

      const { values, labels } = applyToggle(manifest, field.path, this.values, this.labels);

      this.$emit('update:content', dumpTemplate(manifest));
      this.$emit('update:values', values);
      this.$emit('update:labels', labels);
    },

    /**
     * Rename a parameter.
     *
     * Both halves move together: the placeholder in the YAML and the key in the values. Doing
     * one without the other is a template referring to a value that does not exist, which
     * renders as the literal `${old}` on a cluster.
     */
    rename(field, name) {
      const next = (name || '').trim();

      if (!next || next === field.parameter || !this.manifest) {
        return;
      }

      const manifest = this.manifest;
      const values = { ...this.values };
      const labels = { ...this.labels };

      values[next] = values[field.parameter];
      delete values[field.parameter];

      if (labels[field.parameter] !== undefined) {
        labels[next] = labels[field.parameter];
        delete labels[field.parameter];
      }

      writeAt(manifest, field.path, `\${${ next }}`);

      this.$emit('update:content', dumpTemplate(manifest));
      this.$emit('update:values', values);
      this.$emit('update:labels', labels);
    },

    setDefault(field, value) {
      this.$emit('update:values', { ...this.values, [field.parameter]: value });
    },

    defaultFor(field) {
      return field.parameter ? (this.values[field.parameter] ?? '') : '';
    },
  },
};
</script>

<template>
  <div class="picker">
    <Banner
      v-if="!manifest"
      color="warning"
      :label="t('appsPlus.fields.unparsed')"
    />

    <template v-else>
      <p class="picker__hint">
        {{ chosen.length ? t('appsPlus.fields.hint') : t('appsPlus.fields.none') }}
      </p>

      <div
        v-for="field in chosen"
        :key="field.path"
        class="field"
      >
        <ToggleSwitch
          class="field__switch"
          :value="true"
          :aria-label="t('appsPlus.form.toggleTip') + ' ' + field.path"
          @update:value="toggle(field)"
        />

        <div class="field__body">
          <div
            v-if="field.friendly"
            class="field__title"
          >
            {{ field.friendly }}
          </div>
          <div class="field__path">
            {{ field.label }}
          </div>

          <!-- Captions on both boxes: a pair reading only `replicas` and `1` says nothing
               about which is the name and which the value it starts at. -->
          <div class="field__params">
            <label class="field__param">
              <span class="field__caption">{{ t('appsPlus.fields.name') }}</span>
              <input
                class="field__name"
                :value="field.parameter"
                @change="e => rename(field, e.target.value)"
              >
            </label>
            <label class="field__param">
              <span class="field__caption">{{ t('appsPlus.fields.default') }}</span>
              <input
                class="field__default"
                :value="defaultFor(field)"
                @change="e => setDefault(field, e.target.value)"
              >
            </label>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.picker {
  padding: 10px 12px;

  &__hint {
    color:         var(--muted);
    font-size:     11px;
    margin-bottom: 8px;
  }

  &__search { margin-top: 12px; }
}

.field {
  display:       flex;
  align-items:   center;
  gap:           8px;
  padding:       5px 6px;
  border-radius: 4px;

  &--on { background: var(--nav-bg); }

  // The same control, at the same size, as the switches on the edit page - it is the same
  // decision seen from the other side, and two looks for one thing reads as two things.
  &__switch {
    flex:             0 0 auto;
    // The class lands on ToggleSwitch's own flex container, so a narrower width here squeezes
    // the switch inside it into a dot. It keeps its natural size and is scaled instead, and the
    // footprint scale() leaves behind is taken back with the margin.
    width:            48px;
    transform:        scale(0.7);
    transform-origin: left center;
    margin:           0 -14px 0 0;
  }

  &--on &__switch {
    color:        var(--primary);
    border-color: var(--primary);
  }

  &__body {
    flex:      1;
    min-width: 0;
  }

  &__title {
    font-size:   12px;
    font-weight: 600;
  }

  // Under the words rather than instead of them: the label is for finding the field, the path
  // is for being certain it is the one you meant.
  &__path {
    font-family: monospace;
    font-size:   10px;
    color:       var(--muted);
  }

  &__value {
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // Wrapping, because this picker lives in narrow places - the builder drawer, and the app
  // form with that drawer open beside it. Two boxes forced to share 200px shrink until the
  // name reads `maxmen`; stacked, each keeps enough room to read what is typed in it.
  //
  // 120, because a ~200px picker keeps ~128px for a field's body once the switch, gaps and
  // padding are paid: 130 here overflowed by five pixels and grew a scrollbar.
  &__params {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
  }

  &__param {
    display:        flex;
    flex-direction: column;
    flex:           1 1 120px;
    min-width:      120px;
    gap:            1px;
  }

  &__caption {
    font-size: 10px;
    color:     var(--muted);
  }

  &__name,
  &__default {
    min-width:     0;
    font-size:     11px;
    padding:       2px 6px;
    border:        1px solid var(--border);
    border-radius: 3px;
    background:    var(--body-bg);
    color:         var(--body-text);
  }

  &__name { font-family: monospace; }
}
</style>
