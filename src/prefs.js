import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {CONTROL_KEYS_LAYOUT} from './constants.js';

export default class MprisPlayerControlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title: null,
            icon_name: null,
        });
        window.add(page);
        window._settings = this.getSettings();
        window._settings.set_uint('get-title-width', 0);

        const appearanceGroup = new Adw.PreferencesGroup({ title: _('Appearance')});
        appearanceGroup.set_separate_rows?.(true);
        page.add(appearanceGroup);

        const spacingSpinRow = Adw.SpinRow.new_with_range(0, 10, 1);
        spacingSpinRow.set_value(window._settings.get_uint('spacing'));
        spacingSpinRow.set_wrap(true);
        spacingSpinRow.set_title(_('Spacing between elements'));
        spacingSpinRow.set_subtitle(_('Set horizontal spacing for icon, title text, and control buttons.'));

        window._settings.bind('spacing', spacingSpinRow, 'value',
            Gio.SettingsBindFlags.DEFAULT,
        );

        const titleWidthSpinRow = Adw.SpinRow.new_with_range(0, 200, 5);
        titleWidthSpinRow.set_value(window._settings.get_uint('set-title-width'));
        titleWidthSpinRow.set_wrap(true);
        titleWidthSpinRow.set_title(_('Track title width'));
        titleWidthSpinRow.set_subtitle(_('Set max track title width before it truncates with an ellipsis.'));

        titleWidthSpinRow.connect('notify::value', () => {
            const temp_title_width = window._settings.get_uint('set-title-width');
            window._settings.set_uint('get-title-width', temp_title_width);
            window._settings.set_uint('set-title-width', titleWidthSpinRow.value);

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                const current_title_width = window._settings.get_uint('set-title-width');
                const confirmed_title_width = window._settings.get_uint('get-title-width');

                if (current_title_width !== confirmed_title_width) {
                    window._settings.set_uint('set-title-width', temp_title_width);
                    titleWidthSpinRow.set_value(temp_title_width);
                }
            });
        });

        appearanceGroup.add(spacingSpinRow);
        appearanceGroup.add(titleWidthSpinRow);
        
        const controlsGroup = new Adw.PreferencesGroup({ title: _('Controls')});
        controlsGroup.set_separate_rows?.(true);
        page.add(controlsGroup);

        const controlKeysLayout = Object.keys(CONTROL_KEYS_LAYOUT);
        const controlKeysLayoutList = Gtk.StringList.new(controlKeysLayout);

        const keysLayoutComboRow = new Adw.ComboRow({
            title: _('Layout style for playback icons'),
            subtitle: _('Choose how playback control icons are arranged in the indicator.'),
            model: controlKeysLayoutList,
        });

        const current_icons_layout = window._settings.get_string('playback-icons-layout');
        keysLayoutComboRow.selected = controlKeysLayout.indexOf(current_icons_layout);

        const seekScrollSwitchRow = new Adw.SwitchRow({
            title: _('Enable seek scroll'),
            subtitle: _('Scroll on the forward icon to seek through the current track.'),
        });
        window._settings.bind('enable-seek', seekScrollSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        keysLayoutComboRow.connect('notify::selected-item', () => {
            const selected_index = keysLayoutComboRow.get_selected();
            window._settings.set_string('playback-icons-layout', controlKeysLayout[selected_index]);

            if (window._settings.get_string('playback-icons-layout') === 'minimal') {
                window._settings.set_boolean('enable-seek', false);
                seekScrollSwitchRow.set_sensitive(false);
            } else {
                seekScrollSwitchRow.set_sensitive(true);
            }
        });

        if (window._settings.get_string('playback-icons-layout') === 'minimal') {
            window._settings.set_boolean('enable-seek', false);
            seekScrollSwitchRow.set_sensitive(false);
        }

        const seekOffsetSpinRow = Adw.SpinRow.new_with_range(1, 20, 1);
        seekOffsetSpinRow.set_value(window._settings.get_uint('seek-offset'));
        seekOffsetSpinRow.set_wrap(true);
        seekOffsetSpinRow.set_title(_('Sets seek offset'));
        seekOffsetSpinRow.set_subtitle(_('Set seek offset in seconds.'));

        window._settings.bind('seek-offset', seekOffsetSpinRow, 'value',
            Gio.SettingsBindFlags.DEFAULT,
        );

        controlsGroup.add(seekOffsetSpinRow);
        controlsGroup.add(keysLayoutComboRow);
        controlsGroup.add(seekScrollSwitchRow);
    }
}

//window._settings.bind('set-title-width', titleWidthSpinRow, 'value',
//    Gio.SettingsBindFlags.DEFAULT,
//);
//window._settings.connect('changed::set-title-width', (settings, key) => {
//    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
//        const current_title_width = window._settings.get_uint('set-title-width');
//        const confirmed_title_width = window._settings.get_uint('get-title-width');
//        if (current_title_width !== confirmed_title_width) {
//            window._settings.set_uint('set-title-width', this._temp_title_width);
//            titleWidthSpinRow.set_value(this._temp_title_width);
//        }
//    });
//});

