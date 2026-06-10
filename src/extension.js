import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from "gi://Pango";
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {getMixerControl as _mixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {OsdProgressWindow} from './osdProgress.js';

import {CONTROL_KEYS_LAYOUT, FREEDESKTOP_DBUS_IFACE_PATH, FREEDESKTOP_DBUS_OBJECT_PATH,
    FREEDESKTOP_DBUS_IFACE_XML,
    FREEDESKTOP_DBUS_PROPERTIES_IFACE_XML, MPRIS_IFACE_PATH, MPRIS_OBJECT_PATH,
    MPRIS_PLAYER_IFACE_XML, MPRIS_IFACE_XML, FREEDESKTOP_DBUS_INDEX, TRIPLE_CONTROL_KEYS,
} from './constants.js';

const ALLOW_AMPLIFIED_VOLUME_KEY = 'allow-volume-above-100-percent';

export default class MprisPlayerControlExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._settings = this.getSettings();
        this._playbackIconLayout = this._settings.get_string('playback-icons-layout');
        this._titleWidth = this._settings.get_uint('set-title-width');

        if (!Object.keys(CONTROL_KEYS_LAYOUT).includes(this._playbackIconLayout)) {
            this._playbackIconLayout = 'standard';
            this._settings.set_string('playback-icons-layout', this._playbackIconLayout);
        }

        const monitorIndex = global.display.get_current_monitor();
        this._osdWindow = new OsdProgressWindow(monitorIndex);

        this._mprisPlayerSeekOffset = this._settings.get_uint('seek-offset');
        this._mprisPlayerSeek = this._settings.get_boolean('enable-seek');
        this._DbusProxy = Gio.DBusProxy.makeProxyWrapper(FREEDESKTOP_DBUS_IFACE_XML);
        this._DbusProxyProperties = Gio.DBusProxy.makeProxyWrapper(FREEDESKTOP_DBUS_PROPERTIES_IFACE_XML);
        this._MprisProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_IFACE_XML);
        this._MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE_XML);
        this._dbusProxyHandler = null;
        this._mprisPlayerNames = [];
        this._activePlayerName = this._settings.get_string('active-player-name');
        this._activePlayerIndex = 0;
        this._listPlayerNames = {};
        this._mprisPlayer = null;
        this._playerPropertiesHandler = null;
        this._controlVolumeHandler = null;
        this._trackLength = 0;

        this._controlIconsHandlers = {
            'Backward': null,
            'Paused': null,
            'Playing': null,
            'Stopped': null,
            'Forward': null,
            'Scroll': null
        };

        this._audioVolumeIcons = [
            'audio-volume-muted-symbolic',
            'audio-volume-low-symbolic',
            'audio-volume-medium-symbolic',
            'audio-volume-high-symbolic',
            'audio-volume-overamplified-symbolic',
        ];

        this._volumeMixerControl = _mixerControl();
        this._volumeMixerControlHandler = this._volumeMixerControl.connect(
                'stream-added',
                (mixerControl, object) => {
            }
        );

        this._initPlayerControlBox();
        this._initMprisPlayer();

        this._playbackIconHandler = this._settings.connect(
            'changed::playback-icons-layout',
                (settings, key) => {
                this._playbackIconLayout = settings.get_string('playback-icons-layout');
                this._updatePlaybackIcons(this._playbackIconLayout);
            },
        );

        this._labelWidthHandler = this._settings.connect('changed::set-title-width', (settings, key) => {
            this._titleWidth = settings.get_uint(key);
            if (this._mprisPlayer) {
                this._trackLabel.clutter_text.set_width(this._titleWidth);
                this._settings.set_uint('get-title-width', this._trackLabel.clutter_text.get_width());
            }
        });

        this._indicatorItemSpacingHandler = this._settings.connect('changed::spacing', (settings, key) => {
            const spacing = settings.get_uint(key);
            this._indicatorBox.set_style(`spacing: ${spacing}px;`);
            this._controlBox.set_style(`spacing: ${spacing}px;`);
        });

        this._playerOffsetHandler = this._settings.connect('changed::seek-offset', (settings, key) => {
            this._mprisPlayerSeekOffset = settings.get_uint(key);
        });

        this._playerSeekScrollHandler = this._settings.connect('changed::enable-seek', (settings, key) => {
            this._mprisPlayerSeek = settings.get_boolean(key);
            if (this._mprisPlayer) {
                if (this._mprisPlayer.PlaybackStatus === 'Playing') {
                    if (this._mprisPlayerSeek) {
                        const child = this._getStatusChild(['Forward'])[0];
                        if (child) {
                            this._connectSeekForwardIcon([child.get_name()]);
                        }
                    } else {
                        this._disconnectPlaybackIcons(['Scroll']);
                    }
                }
            }
        });

        this._indicator?._clickGesture?.set_enabled(false);
        this._indicator.connect('button-press-event', this._onButtonPressed.bind(this));

        this._soundSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.sound',
        });
        this._soundSettingsHandler = null;

        this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_VOLUME_KEY);

        this._soundSettingsHandler = this._soundSettings.connect(`changed::${ALLOW_AMPLIFIED_VOLUME_KEY}`,
            () => {
                this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_VOLUME_KEY);
            }
        );
    }

    _connectVolumeControl() {
        this._trackLabel.reactive = true;

        if (this._controlVolumeHandler === null) {
            this._controlVolumeHandler = this._trackLabel.connect('scroll-event', (actor, event) => {
                const direction = event.get_scroll_direction();
                if (direction === Clutter.ScrollDirection.UP) {
                    this._getStream(0.25);
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    this._getStream(-0.25);
                } else {
                    return Clutter.EVENT_PROPAGATE;
                }

                return Clutter.EVENT_STOP;
            });
        }
    }

    _disconnectVolumeControl() {
        this._trackLabel.reactive = false;

        if (this._controlVolumeHandler !== null) {
            this._trackLabel.disconnect(this._controlVolumeHandler);
            this._controlVolumeHandler = null;
        }
    }

    _getIcon(stream, maxVolume) {
        if (!stream) {
            return null;
        }

        const volume = stream.volume;
        if (stream.is_muted || volume <= 0) {
            return 0;
        }

        return Math.clamp(Math.ceil(3 * volume / maxVolume), 1, this._audioVolumeIcons.length - 1);
    }

    _getStream(increment) {
        if (this._mprisProxy === null) {
            return;
        }

        const activePlayerName = this._mprisProxy?.Identity ?? 'System Volume (Global)';
        const streamList = this._volumeMixerControl.get_streams().filter(stream => 
            stream.get_name() === activePlayerName
        );
        const stream = streamList.length === 0 ? this._volumeMixerControl.get_default_sink() : streamList[0];

        let maxVolume = this._volumeMixerControl.get_vol_max_norm();

        if (this._allowAmplified) {
            maxVolume = this._volumeMixerControl.get_vol_max_amplified();
        }

        const step = maxVolume / 30;
        let newVolume = stream.volume + step * increment;
        newVolume = Math.round(Math.clamp(0, newVolume, maxVolume));

        stream.volume = newVolume;
        stream.push_volume();

        const gicon = new Gio.ThemedIcon(
            {
                name: this._audioVolumeIcons[this._getIcon(
                        stream,
                        this._volumeMixerControl.get_vol_max_norm(),
                    )
                ]
            }
        );

        const maxLevel = maxVolume / this._volumeMixerControl.get_vol_max_norm();
        this._showAll(
            gicon, activePlayerName,
            newVolume / this._volumeMixerControl.get_vol_max_norm(),
            maxLevel,
        );
    }

    _showAll(icon, label, level, maxLevel) {
        for (let i = 0; i < Main.osdWindowManager._osdWindows.length; i++)
            Main.osdWindowManager._showOsdWindow(i, icon, label, level, maxLevel);
    }

    _showTrackProgressOsd(label, positionUS, totalUS) {
        const progress = totalUS > 0
            ? Math.clamp(positionUS / totalUS, 0, 1)
            : 0;

        this._osdWindow.setLabel(label);
        this._osdWindow.setMaxLevel(1);
        this._osdWindow.setLevel(progress);
        this._osdWindow.show();
    }

    async _showRewindIndicator() {
        const currentUS = await this._position();
        const totalUS = this._trackLength;

        const label = buildLabel(
            //formatTimeUS(currentUS),
            totalUS > 0 ? formatTimeUS(currentUS) : '--:--',
            totalUS > 0 ? formatTimeUS(totalUS) : '--:--'
        );
        
        this._showTrackProgressOsd(label, currentUS, totalUS);
    }

    _selectPlayer(index) {
        if (this._mprisPlayer) {
            this._removePlayerProxy(this._mprisPlayer.get_name());
        }

        this._addPlayerProxy(index);

        if (this._settings.get_boolean("auto-select")) {
            this._activePlayerIndex = 0;
        }
    }

    _onButtonPressed(actor, event) {
        const button = event.get_button();
        if (this._indicator.menu) {
            this._indicator.menu.close();
            this._indicator.menu.removeAll();
        }

        if (button == Clutter.BUTTON_SECONDARY) {
            const activePlayerName = this._mprisPlayer?.get_name();

            if (Object.keys(this._listPlayerNames).length === 0) {
                const emptyItem = new PopupMenu.PopupMenuItem("No active players");
                emptyItem.setSensitive(false);
                emptyItem.add_style_class_name("dim-label");
                this._indicator.menu.addMenuItem(emptyItem);
            } else {
                for (const [player_id, player_name] of Object.entries(this._listPlayerNames)) {
                    const item = new PopupMenu.PopupMenuItem(player_name);
                    item.connect("activate", () => {
                        this._activePlayerIndex = this._mprisPlayerNames.indexOf(player_id);
                        this._selectPlayer(this._activePlayerIndex);

                        this._activePlayerName = player_id;
                        this._settings.set_string('active-player-name', player_id);
                    });

                    if (activePlayerName === player_id)
                        item.setOrnament(PopupMenu.Ornament.CHECK);

                    this._indicator.menu.addMenuItem(item);
                }
            }

            this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const menuItem = new PopupMenu.PopupSwitchMenuItem(_('Auto player select'), false, { });

            menuItem.setToggleState(this._settings.get_boolean("auto-select"));
            this._indicator.menu.addMenuItem(menuItem);

            menuItem.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-select', state);

                if (this._mprisPlayer) {
                    return;
                }
                this._addPlayerProxy(this._activePlayerIndex);
            });

            this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'), { });

            settingsMenuItem.setOrnament(PopupMenu.Ornament.HIDDEN);
            settingsMenuItem.insert_child_at_index(
                new St.Icon({ icon_name: "emblem-system-symbolic", style_class: "popup-menu-icon" }),
                0,
            );
            this._indicator.menu.addMenuItem(settingsMenuItem);

            this._indicator.menu.open();

            settingsMenuItem.connect('activate', (item, event) => {
                this.openPreferences();
            });

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _initPlayerControlBox() {
        this._indicatorBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
        });
        const spacing = `spacing: ${this._settings.get_uint('spacing')}px;`;
        this._indicator.set_style(spacing);
        this._indicatorBox.set_style(spacing);

        this._controlBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
        });
        this._controlBox.set_style(spacing);

        this._forwardIcon = new St.Icon({
            icon_name: 'media-skip-forward-symbolic',
            style_class: 'control-panel-icon',
        });
        this._forwardIcon.reactive = false;
        this._forwardIcon.add_style_pseudo_class('insensitive');
        this._forwardIcon.set_name('Forward');

        this._backwardIcon = new St.Icon({
            icon_name: 'media-skip-backward-symbolic',
            style_class: 'control-panel-icon',
        });
        this._backwardIcon.reactive = false;
        this._backwardIcon.add_style_pseudo_class('insensitive');
        this._backwardIcon.set_name('Backward');

        this._playIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            style_class: 'control-panel-icon',
        });
        this._playIcon.reactive = false;
        this._playIcon.add_style_pseudo_class('insensitive');
        this._playIcon.set_name('Paused');

        this._pauseIcon = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'control-panel-icon',
        });
        this._pauseIcon.reactive = false;
        this._pauseIcon.add_style_pseudo_class('insensitive');
        this._pauseIcon.set_name('Playing');

        this._stopIcon = new St.Icon({
            icon_name: 'media-playback-stop-symbolic',
            style_class: 'control-panel-icon',
        });
        this._stopIcon.reactive = false;
        this._stopIcon.add_style_pseudo_class('insensitive');
        this._stopIcon.set_name('Stopped');

        this._playerIcon = new St.Icon({
            fallback_icon_name: 'audio-x-generic-symbolic',
            style_class: 'player-icon',
        });
        this._playerIcon.add_style_pseudo_class('insensitive');

        this._controlIcons = {
            'Backward': this._backwardIcon,
            'Stopped': this._stopIcon,
            'Paused': this._pauseIcon,
            'Playing': this._playIcon,
            'Forward': this._forwardIcon,
            'Scroll': this._forwardIcon
        };

        this._addPlaybackIcons(this._playbackIconLayout);

        this._trackLabel = new St.Label({
            style_class: "message-title",
        });
        this._trackLabel.clutter_text.set_width(1);
        this._trackLabel.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        this._trackLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._indicatorBox.add_child(this._playerIcon);
        this._indicatorBox.add_child(this._trackLabel);
        this._indicatorBox.add_child(this._controlBox);

        this._indicator.add_child(this._indicatorBox);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    async _initMprisPlayer() {
        try {
            await this._dbus();

            this._mprisPlayerNames = await this._extractMprisPlayersNames();
            this._mprisPlayerNames.forEach((name) => { this._addPlayerName(name) });

            if (!this._settings.get_boolean("auto-select")) {
                this._activePlayerIndex = this._mprisPlayerNames.indexOf(this._activePlayerName);

                if (this._activePlayerIndex === -1) {
                    return;
                }
            } else {
                this._activePlayerIndex = 0;
            }

            this._addPlayerProxy(this._activePlayerIndex);
        } catch (e) {
            logError(e, 'could not initialize MPRIS player');
        }
    }

    // Returns position in microseconds.
    // Returns 0 if unavailable.
    async _position() {
        try {
            if (!this._dbusProxyProperties)
                return 0;

            const [value] = await this._dbusProxyProperties.GetAsync(
                'org.mpris.MediaPlayer2.Player',
                'Position'
            );

            const position = value?.deepUnpack?.();
            return Number.isFinite(position) && position >= 0
                ? position
                : 0;
        } catch (e) {
            logError(e, 'could not get player position');
            return 0;
        }
    }

    async _addPlayerName(name) {
        try {
            const mpris = await this._mpris(name);
            if(!mpris) {
                return;
            }

            this._listPlayerNames[name] = this._getPlayerName(mpris);

            this._settings.set_value(
                'list-player-names',
                GLib.Variant.new('a{ss}',
                this._listPlayerNames),
            );
        } catch (e) {
            logError(e, 'could not initialize MPRIS player');
        }
    }

    async _extractMprisPlayersNames() {
        try {
            const dbusNamesList = await this._dbusProxy.ListNamesAsync();

            return dbusNamesList[FREEDESKTOP_DBUS_INDEX] 
                .filter(element => element.startsWith(MPRIS_IFACE_PATH));
        } catch (e) {
            logError(e, `could not get list Dbus objects ${MPRIS_IFACE_PATH}`);

            return [];
        }
    }

    //_updateTrackInfo(metadata) {
    //    this._trackTitle = typeof metadata['xesam:title'] === 'string'
    //        ? metadata['xesam:title']
    //        : _('Unknown title');

    //    const length = metadata['mpris:length'];
    //    this._trackLength = Number.isFinite(length) && length >= 0
    //        ? length
    //        : 0;

    //    this._trackLabel.clutter_text.set_width(this._titleWidth);
    //    this._trackLabel.set_text(this._trackTitle);
    //}

    _updateTrackInfo(metadata) {
        const trackTitle = typeof metadata['xesam:title'] === 'string'
            ? metadata['xesam:title']
            : _('Unknown title');

        this._updateTrackLength(metadata);
        this._trackLabel.clutter_text.set_width(this._titleWidth);
        this._trackLabel.set_text(trackTitle);
    }

    _updateTrackLength(metadata) {
        const length = metadata['mpris:length'];
        this._trackLength = Number.isFinite(length) && length >= 0
            ? length
            : 0;
    }

    async _addPlayerProxy(mprisPlayerIndex) {
        if (mprisPlayerIndex < 0 || this._mprisPlayerNames.length == 0) {
            return;
        }

        try {
            if (this._mprisPlayer) {
                this._disconnectPlayerProperties();
            }

            this._mprisPlayer = await new this._MprisPlayerProxy(
                Gio.DBus.session,
                this._mprisPlayerNames[mprisPlayerIndex],
                MPRIS_OBJECT_PATH
            );

            await this._dbusProperties(this._mprisPlayerNames[mprisPlayerIndex]);

            this._mprisProxy = await this._mpris(this._mprisPlayerNames[mprisPlayerIndex]);
            if(!this._mprisProxy) {
                return;
            }

            this._connectPlayerProperties();
            this._connectVolumeControl();

              this._updatePlayerIcon();

            const metadata = {};
            for (const property in this._mprisPlayer.Metadata) {
                 metadata[property] = this._mprisPlayer.Metadata[property].deepUnpack();
            }
 
            this._updateTrackInfo(metadata);
            this._statusIconManager(this._mprisPlayer.PlaybackStatus);

        } catch (e) {
            logError(e, `could not add proxy player ${this._mprisPlayerNames}`);
        }
    }
    
    async _dbus() {
        try {
            this._dbusProxy =  await new this._DbusProxy(
                Gio.DBus.session,
                FREEDESKTOP_DBUS_IFACE_PATH,
                FREEDESKTOP_DBUS_OBJECT_PATH,
            );

            this._dbusProxyHandler = this._dbusProxy.connectSignal(
                'NameOwnerChanged',
                this._onNameOwnerChanged.bind(this)
            );

        } catch (e) {
            logError(e, `could not initialize proxy for interface ${FREEDESKTOP_DBUS_IFACE_XML}`);

            return null;
        }
    }

    async _dbusProperties(playerName) {
        try {
            if (!playerName) {
                this._dbusProxyProperties = null;
                return;
            }

            this._dbusProxyProperties =  await new this._DbusProxyProperties(
                Gio.DBus.session,
                playerName,
                MPRIS_OBJECT_PATH
            );

        } catch (e) {
            logError(
                e,
                `could not initialize proxy for interface ${FREEDESKTOP_DBUS_PROPERTIES_IFACE_XML}`
            );

            return null;
        }
    }

    _getPlayerName(mprisProxy) {
        if (mprisProxy.DesktopEntry) {
            const desktop_id = `${mprisProxy.DesktopEntry}.desktop`;
            return Shell.AppSystem.get_default().lookup_app(desktop_id)?.get_name()?? mprisProxy.Identity;
        }

        return  mprisProxy.Identity;
    }

    _onNameOwnerChanged(_proxy, _nameOwner, [name, oldOwner, newOwner]) {
        if (name.startsWith(MPRIS_IFACE_PATH)) {
            if (newOwner) {
                this._mprisPlayerNames.push(name);
                this._addPlayerName(name);

                if (!this._settings.get_boolean("auto-select")) {
                    this._activePlayerIndex = this._mprisPlayerNames.indexOf(this._activePlayerName);

                    if (this._activePlayerIndex === -1) {
                        return;
                    }
                    this._addPlayerProxy(this._activePlayerIndex);
                    return;

                } else {
                    this._activePlayerIndex = 0;
                }

                if (this._mprisPlayerNames.length == 1) {
                    this._addPlayerProxy(this._activePlayerIndex);
                }

                return;
            }

            if (oldOwner) {
                const index = this._mprisPlayerNames.indexOf(name);
                if (index === -1) {
                    return;
                }

                this._mprisPlayerNames.splice(index, 1);
                console.log(`*****< Remove invalidate Player name: ${name} >*****`);
                delete this._listPlayerNames[name];

                if (this._mprisPlayer?.get_name_owner() === oldOwner) {
                    this._removePlayerProxy(null);
                    
                    if (this._settings.get_boolean("auto-select")) {
                        console.log(`*****< Add other new Player name: ${this._mprisPlayerNames} >*****`);
                        this._addPlayerProxy(this._activePlayerIndex);
                    }
                }
            }
        }
    }

    async _mpris(mprisPlayerName) {
        try {
            return await new this._MprisProxy(
                Gio.DBus.session,
                mprisPlayerName,
                MPRIS_OBJECT_PATH,
            );

        } catch (e) {
            logError(e, `could not initialize proxy for interface ${MPRIS_IFACE_XML}`);

            return null;
        }
    }

    _updatePlayerIcon() {
        const desktopEntry = this._mprisProxy?.DesktopEntry;
        const app = desktopEntry
            ? Shell.AppSystem.get_default().lookup_app(`${desktopEntry}.desktop`)
            : null;

        this._playerIcon.set_gicon(app?.get_icon() ?? null);
        this._playerIcon.remove_style_pseudo_class('insensitive');
    }

    _connectPlayerProperties() {
        this._disconnectPlayerProperties();

        this._playerPropertiesHandler = this._mprisPlayer.connect(
            'g-properties-changed',
            (_proxy, changed, _invalidated) => {
                const unpacked = changed.recursiveUnpack();
                const metadata = unpacked.Metadata ?? null;
                const status = unpacked.PlaybackStatus ?? null;

                if(metadata) {
                    this._updateTrackInfo(metadata);
                }

                if (status) {
                    this._statusIconManager(status);
                }
            }
        );
    }

    _statusIconManager(status) {
        if (status === 'Paused') {
            this._playingPaused(TRIPLE_CONTROL_KEYS, this._playIcon);
        } else if (status === 'Playing') {
            this._playingPaused(TRIPLE_CONTROL_KEYS, this._pauseIcon);
        } else if (status === 'Stopped') {
            this._stop(TRIPLE_CONTROL_KEYS, ['Stopped', 'Playing']);
        } else {
            this._stop(TRIPLE_CONTROL_KEYS, []);
        }
    }

    _playingPaused(selectChild, icon) {
        const statusChild = this._getStatusChild(selectChild)[0];

        if (statusChild !== icon) {
            this._disablePlaybackIcons([statusChild.get_name()]);
            this._controlBox.replace_child(statusChild, icon);
        }

        this._enablePlaybackIcons(this._getChildrenNames());
    }

    _stop(selectChild, layout) {
        const statusChild = this._getStatusChild(selectChild);
        this._disablePlaybackIcons(Object.keys(this._controlIconsHandlers));

        this._trackLabel.clutter_text.set_width(1);
        this._trackLabel.set_text(null);

        if (statusChild.includes(this._stopIcon)) {
            if (statusChild.includes(this._pauseIcon)) {
                this._controlBox.replace_child(this._pauseIcon, this._playIcon);
                this._enablePlaybackIcons(layout);

                return;
            } else if (statusChild.includes(this._playIcon)) {
                this._enablePlaybackIcons(layout);

                return;
            }

        } else {
            this._controlBox.replace_child(statusChild[0], this._stopIcon);
        }

        this._activatePlaybackIcons(layout);
    }

    _enablePlaybackIcons(layout) {
        this._connectPlaybackIcons(layout);
        if (this._mprisPlayerSeek) {
            this._connectSeekForwardIcon(layout);
        }
        this._activatePlaybackIcons(layout);
    }

    _connectSeekForwardIcon(layout) {
        if (layout.includes('Forward')) {
            if (this._controlIconsHandlers['Scroll'] === null) {
                this._controlIconsHandlers['Scroll'] = this._forwardIcon.connect( 'scroll-event', async (actor, event) => {
                    const direction = event.get_scroll_direction();

                    try {
                        const mprisPlayerSeekOffset = this._mprisPlayerSeekOffset * 1_000_000;
                        if (direction === Clutter.ScrollDirection.UP) {
                            await this._mprisPlayer.SeekAsync(mprisPlayerSeekOffset);
                            this._showRewindIndicator();
                        } else if (direction === Clutter.ScrollDirection.DOWN) {
                            await this._mprisPlayer.SeekAsync(-mprisPlayerSeekOffset);
                            this._showRewindIndicator();
                        } else {
                            return Clutter.EVENT_PROPAGATE;
                        }
                    } catch (e) {
                        logError(e, "Seek failed");
                    }

                    return Clutter.EVENT_STOP;

                });
            }
        }
    }

    _connectPlaybackIcons(layout) {
        if (layout.includes('Forward')) {
            if (this._controlIconsHandlers['Forward'] === null) { 
                this._controlIconsHandlers['Forward'] = this._forwardIcon.connect('button-press-event', async (actor, event) => {
                    if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                        try {
                            await this._mprisPlayer.NextAsync();
                        } catch (e) {
                            this._disablePlaybackIcons(['Forward']);

                            logError(e, "MPRIS NextAsync failed");
                        }

                        return Clutter.EVENT_STOP;
                    }

                    return Clutter.EVENT_PROPAGATE;
                });
            }
        }

        if (layout.includes('Backward')) {
            if (this._controlIconsHandlers['Backward'] === null) { 
                this._controlIconsHandlers['Backward'] = this._backwardIcon.connect('button-press-event', async (actor, event) => {
                    if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                        try {
                            await this._mprisPlayer.PreviousAsync();
                        } catch (e) {
                            this._disablePlaybackIcons(['Backward']);

                            logError(e, "MPRIS PreviousAsync failed");
                        }

                        return Clutter.EVENT_STOP;
                    }

                    return Clutter.EVENT_PROPAGATE;
                });
            }
        }

        if (layout.includes('Stopped')) {
            if (this._controlIconsHandlers['Stopped'] === null) { 
                this._controlIconsHandlers['Stopped'] = this._stopIcon.connect('button-press-event', async (actor, event) => {
                    if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                        try {
                            await this._mprisPlayer.StopAsync();
                        } catch (e) {
                            this._disablePlaybackIcons(['Stopped']);

                            logError(e, "MPRIS StopAsync failed");
                        }

                        return Clutter.EVENT_STOP;
                    }

                    return Clutter.EVENT_PROPAGATE;
                });
            }
        }

        if (layout.includes('Playing')) {
            if (this._controlIconsHandlers['Playing'] === null) { 
                this._controlIconsHandlers['Playing'] = this._playIcon.connect(
                    'button-press-event',
                    this._playPause.bind(this),
                );
            }
        }

        if (layout.includes('Paused')) {
            if (this._controlIconsHandlers['Paused'] === null) { 
                this._controlIconsHandlers['Paused'] = this._pauseIcon.connect(
                    'button-press-event',
                    this._playPause.bind(this),
                );
            }
        }
    }

    _activatePlaybackIcons(layout) {
        layout.forEach((key) => {
            this._controlIcons[key].set_reactive(true);
            this._controlIcons[key].remove_style_pseudo_class('insensitive');
        });
    }

    _getStatusChild(selectChild) {
        return this._controlBox.get_children()
            .filter(child => { return selectChild.includes(child.get_name()); });
    }

    _getChildrenNames() {
        return this._controlBox.get_children().map(child => { 
            const name = child.get_name();
            if (name === 'Paused') {
                return 'Playing';
            } else if (name === 'Playing') {
                return 'Paused';
            } else {
                return name;
            }
        });
    }

    _removePlayerProxy(mprisPlayerName) {
        if (!mprisPlayerName) {
            this._stop(TRIPLE_CONTROL_KEYS, []);
        }
            
        this._removePlayerAppIcon();
        this._disconnectPlayerProperties();
        this._disconnectVolumeControl();
        this._dbusProxyProperties = null;
        this._trackLabel.clutter_text.set_width(1);
        this._trackLabel.set_text(null);
        this._mprisPlayer = null;
    }

    _removePlayerAppIcon() {
        this._playerIcon.set_icon_name(null);
        this._playerIcon.add_style_pseudo_class('insensitive');
    }

    _addPlaybackIcons(keyLayout) {
        for (const status of CONTROL_KEYS_LAYOUT[keyLayout]) {
            this._controlBox.add_child(this._controlIcons[status]);
        }
    }

    _updatePlaybackIcons(keyLayout) {
        this._controlBox.get_children().forEach((child) => {
            const key = child.get_name();

            if (this._controlIconsHandlers[key] !== null) { 
                child.disconnect(this._controlIconsHandlers[key]);
                this._controlIconsHandlers[key] = null;
            }

            if (key === "Forward") {
                if (this._controlIconsHandlers["Scroll"] !== null) { 
                    child.disconnect(this._controlIconsHandlers["Scroll"]);
                    this._controlIconsHandlers["Scroll"] = null;
                }
            }
        });

        this._controlBox.remove_all_children();
        this._addPlaybackIcons(keyLayout);

        if (this._mprisPlayer) {
            this._statusIconManager(this._mprisPlayer.PlaybackStatus);
        }
    }

    _disablePlaybackIcons(layout) {
        this._deactivatePlaybackIcons(layout.slice(0, 5));
        this._disconnectPlaybackIcons(layout);
    }

    _deactivatePlaybackIcons(layout) {
        layout.forEach((key) => {
            this._controlIcons[key].set_reactive(false);
            this._controlIcons[key].add_style_pseudo_class('insensitive');
        });
    }

    _disconnectPlayerProperties() {
       if (this._playerPropertiesHandler !== null) { 
            this._mprisPlayer.disconnect(this._playerPropertiesHandler);
            this._playerPropertiesHandler = null;
        }
    }

    _disconnectPlaybackIcons(layout) {
        layout.forEach((key) => {
            if (this._controlIconsHandlers[key] !== null) { 
                this._controlIcons[key].disconnect(this._controlIconsHandlers[key]);
                this._controlIconsHandlers[key] = null;
            }
        });
    }

    async _playPause(actor, event) {
        if (event.get_button() === Clutter.BUTTON_PRIMARY) {
            try {
                await this._mprisPlayer.PlayPauseAsync();
            } catch (e) {
                this._disablePlaybackIcons(['Playing', 'Paused']);

                logError(e, "MPRIS PlayPauseAsync failed");
            }

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    disable() {
        if (this._dbusProxyHandler !== null) {
            this._dbusProxy.disconnectSignal(this._dbusProxyHandler);
            this._dbusProxyHandler = null;
        }

        this._disconnectPlaybackIcons(Object.keys(this._controlIconsHandlers));
        this._disconnectPlayerProperties();

        this._mprisPlayerNames = null;

        if (this._playbackIconHandler !== null) {
            this._settings.disconnect(this._playbackIconHandler);
            this._playbackIconHandler = null;
        }
        if (this._labelWidthHandler !== null) {
            this._settings.disconnect(this._labelWidthHandler);
            this._labelWidthHandler = null;
        }
        if (this._indicatorItemSpacingHandler !== null) {
            this._settings.disconnect(this._indicatorItemSpacingHandler);
            this._indicatorItemSpacingHandler = null;
        }
        if (this._playerOffsetHandler !== null) {
            this._settings.disconnect(this._playerOffsetHandler);
            this._playerOffsetHandler = null;
        }
        if (this._playerSeekScrollHandler !== null) {
            this._settings.disconnect(this._playerSeekScrollHandler);
            this._playerSeekScrollHandler = null;
        }
        this._settings = null;

        if (this._soundSettingsHandler !== null) {
            this._soundSettings.disconnect(this._soundSettingsHandler);
            this._soundSettingsHandler = null;
        }
        this._soundSettings = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}

function formatTimeUS(us) {
    const sec = us > 0 ? Math.floor(us / 1_000_000) : 0;

    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor(sec / 60) % 60;
    const seconds = sec % 60;

    return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildLabel(current, total) {
    const TOTAL_WIDTH = 32;

    const prefix = `${current}\u2005◔`;
    const suffix = `◕\u2005${total}`;

    const fillLength = Math.max(
        1,
        TOTAL_WIDTH - prefix.length - suffix.length
    );

    return `${prefix}${'━'.repeat(fillLength)}${suffix}`;
}
