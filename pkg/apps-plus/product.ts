import { IPlugin } from '@shell/core/types';
import { PRODUCT_NAME, APP, APP_INSTANCE } from './config/types';

/**
 * Two types and one nav entry, added to Rancher's Fleet product.
 *
 * This extension registers no product of its own. Apps and Installations are a way of having
 * Fleet deploy something, so they belong in the side menu beside the other two - and Fleet's
 * product is marked `extendable`, which is Rancher saying so.
 *
 * The entry is the App type's list, replaced by list/appsplus.io.app.vue - Apps as the group
 * headers and their instances as the rows, the shape Cluster Explorer uses for Projects and
 * Namespaces. Instances are a configured type but not a nav entry: they are only ever reached
 * through that list, and a second entry showing the same rows ungrouped would be two
 * descriptions of one thing.
 */
// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  const { basicType, configureType, weightType } = $plugin.DSL(store, PRODUCT_NAME);

  // showState is off for Apps because an App is a definition and has no state to show; the
  // state column in this list belongs to the instances, which do.
  configureType(APP, {
    isCreatable:              true,
    isEditable:               true,
    isRemovable:              true,
    showState:                false,
    showAge:                  false,
    canYaml:                  true,
    listCreateButtonLabelKey: 'appsPlus.action.createApp',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  configureType(APP_INSTANCE, {
    isCreatable: true,
    isEditable:  true,
    isRemovable: true,
    showState:   true,
    showAge:     true,
    canYaml:     true,
  });

  basicType([APP]);

  // Last in Fleet's menu, under everything the product ships with. Negative rather than 0,
  // because 0 is what an unweighted entry gets - Workspaces among them - and a tie is settled
  // by name, which would put this above it by accident rather than on purpose.
  weightType(APP, -1, true);
}
