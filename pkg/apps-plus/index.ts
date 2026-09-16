import { importTypes } from '@rancher/auto-import';
import { IPlugin, ActionLocation } from '@shell/core/types';
import { stageResource } from './builder/state';
import { openBuilder, toggleBuilder, restoreBuilder } from './builder/overlay';
import { initPageMarks } from './builder/page-marks';
import { ADD_TO_APP_ACTION } from './config/types';

// The entry point. The dashboard calls this once, with a plugin object to register things on.
export default function(plugin: IPlugin): void {
  // Picks up models/, list/, edit/, detail/ and l10n/ by filename. Every page this extension
  // has is one of those, which is why it registers no routes of its own: the shell's generic
  // `c-cluster-product-resource*` routes already render whatever these folders provide.
  importTypes(plugin);

  plugin.metadata = require('./package.json');

  plugin.addProduct(require('./product'));

  // The builder's handle in the dashboard's own header, which is the only control that is not
  // attached to a page - the drawer it opens outlives every page, so its handle has to as well.
  //
  // `icon-archive`, not the product's flask: the two sit a few pixels apart in the same chrome,
  // and giving them the same glyph made the header button read as a second way to reach the
  // Apps Plus pages rather than as the thing that opens the drawer. An archive is what this
  // does - it collects resources into one box.
  //
  // `icon-archive`, not `archive`: the header renders `class="icon ${ action.icon }"`, so the
  // icon font's own class name is what belongs here. Passing the bare name gives a button with
  // no glyph in it, which is a control nobody can find.
  plugin.addAction(ActionLocation.HEADER, {}, {
    labelKey:   'appsPlus.builder.title',
    tooltipKey: 'appsPlus.builder.title',
    icon:       'icon-archive',
    invoke:     () => toggleBuilder(),
  });

  /**
   * "Add to Application", on every resource there is.
   *
   * `multiple: true` because a table action is handed the selected rows, so selecting eight
   * Deployments and adding them at once costs the same as one - which is most of why collecting
   * an app this way is quicker than writing it.
   *
   * Staging does not wait for an app to be chosen. Nothing is written until Save, and Save
   * already refuses without an app - so the selection is kept, the cards appear, and the
   * drawer's banner says what is still missing. Dropping the selection instead would mean the
   * first thing most people try silently did nothing.
   *
   * "Every resource" is one type too many twice over: it matches Apps and Installations
   * themselves, and staging an App into an App is meaningless. The location config cannot
   * exclude a type, so the action carries a fixed name and this product's own models filter it
   * out of their rows.
   */
  plugin.addAction(ActionLocation.TABLE, {}, {
    action:   ADD_TO_APP_ACTION,
    labelKey: 'appsPlus.builder.add',
    // The icon font's own class, for the same reason as the header action above: the menu
    // renders the string as a CSS class, and a bare name draws nothing.
    icon:     'icon-flask',
    multiple: true,
    invoke:   (_opts: any, resources: any[]) => {
      openBuilder();

      (resources || []).forEach((resource) => stageResource(resource));
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // A drawer that was open when the page was left should be open when it comes back. This waits
  // for the dashboard to exist before building anything; see restoreBuilder.
  restoreBuilder();

  // The switches that appear on a staged resource's own edit page. Mounted once and always
  // watching; they draw nothing until the drawer is open with that resource staged.
  initPageMarks();
}
