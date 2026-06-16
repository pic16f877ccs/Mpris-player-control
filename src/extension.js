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
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {OsdProgressWindow} from './osdProgress.js';

import {
    ALLOW_AMPLIFIED_VOLUME_KEY, AUDIO_VOLUME_ICONS, CONTROL_KEYS_LAYOUT,
    FREEDESKTOP_DBUS_IFACE_PATH, FREEDESKTOP_DBUS_OBJECT_PATH, FREEDESKTOP_DBUS_IFACE_XML,
    FREEDESKTOP_DBUS_PROPERTIES_IFACE_XML, MPRIS_IFACE_PATH, MPRIS_OBJECT_PATH,
    MPRIS_PLAYER_IFACE_XML, MPRIS_IFACE_XML, FREEDESKTOP_DBUS_INDEX, TRIPLE_CONTROL_KEYS,
    IndicatorFlexibility, DbusProxy, DbusProxyProperties, MprisProxy, MprisPlayerProxy,
} from './constants.js';

export default class MprisPlayerControlExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._indicator?._clickGesture?.set_enabled(false);

        this._initSettings();

        this._trackLength = 0;
        this._currentTrackTitle = null;
        this._activePlayerIndex = 0;
        this._mprisPlayerNames = [];
        this._listPlayerNames = {};
        this._mprisPlayer = null;

        this._dbusProxyHandler = null;
        this._playerPropertiesHandler = null;
        this._controlVolumeHandler = null;
        this._preferredVolumeHandler = null;
        this._controlControlBoxHandler = null;
        this._controlSeekClickHandler = null;
        this._soundSettingsHandler = null;
        this._progressIndicatorWidthHandler = null;
        this._showProgressIndicatorHandler = null;

        this._controlButtonsHandlers = {
            'Backward': null,
            'Paused': null,
            'Playing': null,
            'Stopped': null,
            'Forward': null,
        };

        const monitorIndex = global.display.get_current_monitor();
        this._osdWindow = new OsdProgressWindow(monitorIndex);
        this._volumeMixerControl = getMixerControl();

        this._initPlayerIndicator();
        this._addPlaybackButtons(this._playbackButtonLayout);
        this._initSignalConnects();
        this._initMprisPlayer();
    }

    _hasIndicatorBoxChild(boxChildName) {
        return this._indicatorBox.get_children()
            .find((child, index, children) => { return child.get_name() === boxChildName; });
    }

    _removeIndicatorBoxChildren(boxChild) {
        const boxChildName = boxChild.get_name();

        this._indicatorBox.get_children()
            .forEach(child => {
                if(child.get_name() === boxChildName) {
                    this._indicatorBox.remove_child(child);
                }
            });
    }

    _insertIfHasNotControlBoxChild(boxChild, index) {
        if(!this._hasIndicatorBoxChild(boxChild.get_name())) {
            this._indicatorBox.insert_child_at_index(boxChild, index);
        }
    }

    _updateIndicatorFlexibility() {
        const hasTitle = typeof this._currentTrackTitle === 'string' && this._currentTrackTitle.length > 0;

        if(IndicatorFlexibility.fixedMaximal === this._flexibility) {
            this._insertIfHasNotControlBoxChild(this._trackLabel, 1);

            this._trackLabel.clutter_text.set_width(this._titleWidth);
            if(hasTitle) {
                this._trackLabel.remove_style_pseudo_class('insensitive');
                this._trackLabel.set_text(this._currentTrackTitle);
            } else {
                this._trackLabel.add_style_pseudo_class('insensitive');
                this._trackLabel.set_text(_('Unknown title'));
            }
        } else if(IndicatorFlexibility.adaptive === this._flexibility) {
            if(hasTitle) {
                this._insertIfHasNotControlBoxChild(this._trackLabel, 1);

                this._trackLabel.clutter_text.set_width(this._titleWidth);
                this._trackLabel.remove_style_pseudo_class('insensitive');
                this._trackLabel.set_text(this._currentTrackTitle);
            } else {
                this._removeIndicatorBoxChildren(this._trackLabel);
            }
        } else if(IndicatorFlexibility.fixedMinimal === this._flexibility) {
             this._removeIndicatorBoxChildren(this._trackLabel);
        }
    }

    _connectVolumeControl() {
        this._playerIcon.reactive = true;

        if (this._controlVolumeHandler === null) {
            this._controlVolumeHandler = this._playerIcon.connect('scroll-event', (_actor, event) => {
                const direction = event.get_scroll_direction();
                if (direction === Clutter.ScrollDirection.UP) {
                    this._adjustStreamVolume(0.25);
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    this._adjustStreamVolume(-0.25);
                } else {
                    return Clutter.EVENT_PROPAGATE;
                }

                return Clutter.EVENT_STOP;
            });
        }

        if (this._preferredVolumeHandler === null) {
            this._preferredVolumeHandler = this._playerIcon.connect('button-press-event', (_actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_MIDDLE) {
                    return Clutter.EVENT_PROPAGATE;
                }

                this._applyPreferredVolume();
                return Clutter.EVENT_STOP;
            });
        }
    }

    _disconnectVolumeControl() {
        this._playerIcon.reactive = false;

        if (this._controlVolumeHandler !== null) {
            this._playerIcon.disconnect(this._controlVolumeHandler);
            this._controlVolumeHandler = null;
        }

        if (this._preferredVolumeHandler !== null) {
            this._playerIcon.disconnect(this._preferredVolumeHandler);
            this._preferredVolumeHandler = null;
        }
    }

    _adjustStreamVolume(increment) {
        const stream = this._getActiveStream();
        if (!stream) {
            return;
        }

        const activePlayerName = this._getActivePlayerIdentity();
        const maxVolume = this._getMaxVolume();

        const step = maxVolume / 30;
        let newVolume = stream.volume + step * increment;
        newVolume = Math.round(Math.clamp(newVolume, 0, maxVolume));

        stream.volume = newVolume;
        stream.push_volume();

        this._showVolumeOsd(stream, activePlayerName, maxVolume);
    }

    _applyPreferredVolume() {
        const stream = this._getActiveStream();
        if (!stream) {
            return;
        }

        const activePlayerName = this._getActivePlayerIdentity();
        const maxVolume = this._getMaxVolume();
        const preferredPercent = this._allowAmplified
            ? Math.clamp(this._preferredVolume, 0, 150)
            : Math.clamp(this._preferredVolume, 0, 100);

        const newVolume = Math.round((preferredPercent / 100) * this._volumeMixerControl.get_vol_max_norm());
        stream.volume = Math.clamp(newVolume, 0, maxVolume);
        stream.push_volume();

        this._showVolumeOsd(stream, activePlayerName, maxVolume);
    }

    _getActivePlayerIdentity() {
        return this._mprisProxy?.Identity ?? 'System Volume (Global)';
    }

    _getActiveStream() {
        if (this._mprisProxy === null) {
            return null;
        }

        const activePlayerName = this._getActivePlayerIdentity();
        const streamList = this._volumeMixerControl.get_streams().filter(stream =>
            stream.get_name() === activePlayerName
        );

        return streamList.length === 0
            ? this._volumeMixerControl.get_default_sink()
            : streamList[0];
    }

    _getMaxVolume() {
        return this._allowAmplified
            ? this._volumeMixerControl.get_vol_max_amplified()
            : this._volumeMixerControl.get_vol_max_norm();
    }

    _showVolumeOsd(stream, activePlayerName, maxVolume) {
        if (!stream) {
            return;
        }

        const gicon = new Gio.ThemedIcon(
            {
                name: AUDIO_VOLUME_ICONS[getVolumeIconIndex(
                        stream,
                        this._volumeMixerControl.get_vol_max_norm(),
                    )
                ]
            }
        );

        const maxLevel = maxVolume / this._volumeMixerControl.get_vol_max_norm();
        this._showAll(
            gicon, activePlayerName,
            stream.volume / this._volumeMixerControl.get_vol_max_norm(),
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
        if (!this._showProgressIndicator) {
            return;
        }

        const currentUS = await this._getTrackPosition();
        const totalUS = this._trackLength;

        const label = buildLabel(
            totalUS > 0 ? formatTimeUS(currentUS) : '--:--',
            totalUS > 0 ? formatTimeUS(totalUS) : '--:--',
            this._progressIndicatorWidth,
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
                    const label = (typeof player_name === 'string' && player_name.trim())
                        ? player_name.trim()
                        : (player_id?.split('.').pop()?.trim() || _('Unknown player'));
                    const item = new PopupMenu.PopupMenuItem(label);
                    item.connect("activate", () => {
                        this._activePlayerIndex = this._getActivePlayerIndex(player_id);
                        if (this._activePlayerIndex === null)
                            return;

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

            settingsMenuItem.connect('activate', () => {
                void this.openPreferences().catch(e => {
                    logError(e, 'failed to open extension preferences');
                });
            });

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _initPlayerIndicator() {
        this._indicatorBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
            style_class: 'panel-button',
        });
        const spacing = `spacing: ${this._settings.get_uint('spacing')}px;`;
        this._indicator.set_style(spacing);
        this._indicatorBox.set_style(spacing);

        this._controlBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
        });
        this._controlBox.reactive = true;
        this._controlBox.set_style(spacing);
        this._controlBox.set_name('ControlBox');

        this._forwardButton = new St.Icon({
            icon_name: 'media-skip-forward-symbolic',
            style_class: 'control-panel-icon system-status-icon',
        });
        this._forwardButton.reactive = false;
        this._forwardButton.add_style_pseudo_class('insensitive');
        this._forwardButton.set_name('Forward');

        this._backwardButton = new St.Icon({
            icon_name: 'media-skip-backward-symbolic',
            style_class: 'control-panel-icon system-status-icon',
        });
        this._backwardButton.reactive = false;
        this._backwardButton.add_style_pseudo_class('insensitive');
        this._backwardButton.set_name('Backward');

        this._playButton = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            style_class: 'control-panel-icon system-status-icon',
        });
        this._playButton.reactive = false;
        this._playButton.add_style_pseudo_class('insensitive');
        this._playButton.set_name('Paused');

        this._pauseButton = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'control-panel-icon system-status-icon',
        });
        this._pauseButton.reactive = false;
        this._pauseButton.add_style_pseudo_class('insensitive');
        this._pauseButton.set_name('Playing');

        this._stopButton = new St.Icon({
            icon_name: 'media-playback-stop-symbolic',
            style_class: 'control-panel-icon system-status-icon',
        });
        this._stopButton.reactive = false;
        this._stopButton.add_style_pseudo_class('insensitive');
        this._stopButton.set_name('Stopped');

        this._playerIcon = new St.Icon({
            fallback_icon_name: 'audio-x-generic-symbolic',
            style_class: 'player-icon system-status-icon',
        });
        this._playerIcon.reactive = false;
        this._playerIcon.add_style_pseudo_class('insensitive');

        this._controlButtons = {
            'Backward': this._backwardButton,
            'Stopped': this._stopButton,
            'Paused': this._pauseButton,
            'Playing': this._playButton,
            'Forward': this._forwardButton,
        };

        this._trackLabel = new St.Label({
            style_class: 'player-title',
        });
        this._trackLabel.set_name('TrackLabel');
        this._trackLabel.reactive = false;
        this._trackLabel.add_style_pseudo_class('insensitive');
        this._trackLabel.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        this._trackLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._indicatorBox.add_child(this._playerIcon);
        this._indicatorBox.add_child(this._controlBox);
        this._updateIndicatorFlexibility();

        this._indicator.add_child(this._indicatorBox);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _getActivePlayerIndex(activePlayerName) {
        const index = this._mprisPlayerNames?.indexOf(activePlayerName);
        return index >= 0 ? index : null;
    }

    async _initMprisPlayer() {
        try {
            await this._dbus();

            this._mprisPlayerNames = await this._getMprisPlayersNames();
            await Promise.all(this._mprisPlayerNames.map(name => this._addPlayerName(name)));

            const auto = this._settings.get_boolean("auto-select");

            this._activePlayerIndex = auto
                ? 0
                : this._getActivePlayerIndex(this._activePlayerName);

            if (this._activePlayerIndex === null)
                return;

            this._addPlayerProxy(this._activePlayerIndex);

        } catch (e) {
            logError(e, 'could not initialize MPRIS player');
        }
    }

    async _getTrackPosition() {
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

            const playerName = this._getPlayerName(mpris)?.trim();
            const fallbackName = name?.split('.').pop()?.trim();
            this._listPlayerNames[name] = playerName || fallbackName || _('Unknown player');

            this._settings.set_value(
                'list-player-names',
                GLib.Variant.new('a{ss}',
                this._listPlayerNames),
            );
        } catch (e) {
            logError(e, 'could not initialize MPRIS player');
        }
    }

    async _getMprisPlayersNames() {
        try {
            const dbusNamesList = await this._dbusProxy.ListNamesAsync();

            return dbusNamesList[FREEDESKTOP_DBUS_INDEX] 
                .filter(element => element.startsWith(MPRIS_IFACE_PATH));
        } catch (e) {
            logError(e, `could not get list Dbus objects ${MPRIS_IFACE_PATH}`);

            return [];
        }
    }

    _updateTrackInfo(metadata) {
        this._currentTrackTitle = typeof metadata['xesam:title'] === 'string'
            ? metadata['xesam:title']
            : _('Unknown title');

        this._updateTrackLength(metadata);
        this._updateIndicatorFlexibility();
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

            this._mprisPlayer = await new MprisPlayerProxy(
                Gio.DBus.session,
                this._mprisPlayerNames[mprisPlayerIndex],
                MPRIS_OBJECT_PATH
            );
            this._connectPlayerProperties();

            await this._dbusProperties(this._mprisPlayerNames[mprisPlayerIndex]);

            this._mprisProxy = await this._mpris(this._mprisPlayerNames[mprisPlayerIndex]);
            if(!this._mprisProxy) {
                return;
            }

            this._connectVolumeControl();
            this._connectSeekControlBox();
            this._updatePlayerIcon();

            const metadata = {};
            for (const property in this._mprisPlayer.Metadata) {
                 metadata[property] = this._mprisPlayer.Metadata[property].deepUnpack();
            }
 
            this._updateTrackInfo(metadata);
            this._statusButtonManager(this._mprisPlayer.PlaybackStatus);

        } catch (e) {
            logError(e, `could not add proxy player ${this._mprisPlayerNames}`);
        }
    }
    
    async _dbus() {
        try {
            this._dbusProxy =  await new DbusProxy(
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

            this._dbusProxyProperties =  await new DbusProxyProperties(
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
                    this._activePlayerIndex = this._getActivePlayerIndex(this._activePlayerName);

                    if (this._activePlayerIndex === null) {
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
                const index = this._getActivePlayerIndex(name);
                if (index === null) {
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
            return await new MprisProxy(
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
                    this._statusButtonManager(status);
                }
            }
        );
    }

    _statusButtonManager(status) {
        if (status === 'Paused') {
            this._playingPaused(TRIPLE_CONTROL_KEYS, this._playButton);
        } else if (status === 'Playing') {
            this._playingPaused(TRIPLE_CONTROL_KEYS, this._pauseButton);
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

        this._enablePlaybackButtons(this._getStatusChildName());
    }

    _stop(selectChild, layout) {
        const statusChild = this._getStatusChild(selectChild);
        this._disablePlaybackIcons(Object.keys(this._controlButtonsHandlers));
        this._currentTrackTitle = null;

        if (statusChild.includes(this._stopButton)) {
            if (statusChild.includes(this._pauseButton)) {
                this._controlBox.replace_child(this._pauseButton, this._playButton);
                this._enablePlaybackButtons(layout);

                return;
            } else if (statusChild.includes(this._playButton)) {
                this._enablePlaybackButtons(layout);

                return;
            }

        } else {
            this._controlBox.replace_child(statusChild[0], this._stopButton);
        }

        this._updateIndicatorFlexibility();
        this._activatePlaybackButtons(layout);
    }

    _enablePlaybackButtons(layout) {
        this._connectPlaybackButtons(layout);
        if (this._mprisPlayerSeek) {
            this._connectSeekControlBox(layout);
        }
        this._activatePlaybackButtons(layout);
    }

    _connectSeekControlBox() {
        if (this._controlControlBoxHandler === null) {
            this._controlControlBoxHandler = this._controlBox.connect('scroll-event', async (_actor, event) => {
                if (!this._mprisPlayerSeek) {
                    return Clutter.EVENT_PROPAGATE;
                }

                const direction = event.get_scroll_direction();

                this._lastScrollTime ??= 0;
                this._scrollMultiplier ??= 1;

                const now = Date.now();

                if (now - this._lastScrollTime < 200)
                    this._scrollMultiplier = Math.min(this._scrollMultiplier + 1, 5);
                else
                    this._scrollMultiplier = 1;

                this._lastScrollTime = now;

                try {
                    //const offsetUS = this._mprisPlayerSeekOffset * 1_000_000;
                    const offsetUS =
                        this._mprisPlayerSeekOffset *
                        this._scrollMultiplier *
                        1_000_000;

                    if (direction === Clutter.ScrollDirection.UP) {
                        await this._mprisPlayer.SeekAsync(offsetUS);
                        void this._showRewindIndicator();
                    } else if (direction === Clutter.ScrollDirection.DOWN) {
                        await this._mprisPlayer.SeekAsync(-offsetUS);
                        void this._showRewindIndicator();
                    } else {
                        return Clutter.EVENT_PROPAGATE;
                    }
                } catch (e) {
                    logError(e, 'Seek failed');
                }

                return Clutter.EVENT_STOP;
            });
        }

        if (this._controlSeekClickHandler === null) {
            this._controlSeekClickHandler = this._controlBox.connect('button-press-event', async (_actor, event) => {
                return await this._handleMiddleClickSeek(event);
            });
        }
    }

    async _handleMiddleClickSeek(event) {
        if (!this._mprisPlayerSeek || event.get_button() !== Clutter.BUTTON_MIDDLE) {
            return Clutter.EVENT_PROPAGATE;
        }

        try {
            const largeOffsetUS = this._mprisPlayerSeekOffset * 5 * 1_000_000;
            await this._mprisPlayer.SeekAsync(largeOffsetUS);
            void this._showRewindIndicator();
        } catch (e) {
            logError(e, 'Fast-forward seek failed');
        }

        return Clutter.EVENT_STOP;
    }

    _disconnectSeekControlBox() {
        if (this._controlControlBoxHandler !== null) {
            this._controlBox.disconnect(this._controlControlBoxHandler);
            this._controlControlBoxHandler = null;
        }

        if (this._controlSeekClickHandler !== null) {
            this._controlBox.disconnect(this._controlSeekClickHandler);
            this._controlSeekClickHandler = null;
        }
    }

    _connectPlaybackButtons(layout) {
        if (layout.includes('Forward')) {
            if (this._controlButtonsHandlers['Forward'] === null) { 
                this._controlButtonsHandlers['Forward'] = this._forwardButton.connect('button-press-event', async (actor, event) => {
                    const middleClickResult = await this._handleMiddleClickSeek(event);
                    if (middleClickResult === Clutter.EVENT_STOP) {
                        return Clutter.EVENT_STOP;
                    }

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
            if (this._controlButtonsHandlers['Backward'] === null) { 
                this._controlButtonsHandlers['Backward'] = this._backwardButton.connect('button-press-event', async (actor, event) => {
                    const middleClickResult = await this._handleMiddleClickSeek(event);
                    if (middleClickResult === Clutter.EVENT_STOP) {
                        return Clutter.EVENT_STOP;
                    }

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
            if (this._controlButtonsHandlers['Stopped'] === null) { 
                this._controlButtonsHandlers['Stopped'] = this._stopButton.connect('button-press-event', async (actor, event) => {
                    const middleClickResult = await this._handleMiddleClickSeek(event);
                    if (middleClickResult === Clutter.EVENT_STOP) {
                        return Clutter.EVENT_STOP;
                    }

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
            if (this._controlButtonsHandlers['Playing'] === null) { 
                this._controlButtonsHandlers['Playing'] = this._playButton.connect(
                    'button-press-event',
                    this._playPause.bind(this),
                );
            }
        }

        if (layout.includes('Paused')) {
            if (this._controlButtonsHandlers['Paused'] === null) { 
                this._controlButtonsHandlers['Paused'] = this._pauseButton.connect(
                    'button-press-event',
                    this._playPause.bind(this),
                );
            }
        }
    }

    _activatePlaybackButtons(layout) {
        layout.forEach((key) => {
            this._controlButtons[key].set_reactive(true);
            this._controlButtons[key].remove_style_pseudo_class('insensitive');
        });
    }

    _getStatusChild(selectChild) {
        return this._controlBox.get_children()
            .filter(child => { return selectChild.includes(child.get_name()); });
    }

    _getStatusChildName() {
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
        this._disconnectSeekControlBox();
        this._dbusProxyProperties = null;
        this._currentTrackTitle = null;
        this._updateIndicatorFlexibility();
        this._mprisPlayer = null;
    }

    _removePlayerAppIcon() {
        this._playerIcon.set_icon_name(null);
        this._playerIcon.add_style_pseudo_class('insensitive');
    }

    _addPlaybackButtons(keyLayout) {
        for (const status of CONTROL_KEYS_LAYOUT[keyLayout]) {
            this._controlBox.add_child(this._controlButtons[status]);
        }
    }

    _updatePlaybackButtons(keyLayout) {
        this._controlBox.get_children().forEach((child) => {
            const key = child.get_name();

            if (this._controlButtonsHandlers[key] !== null) { 
                child.disconnect(this._controlButtonsHandlers[key]);
                this._controlButtonsHandlers[key] = null;
            }
        });

        this._controlBox.remove_all_children();
        this._addPlaybackButtons(keyLayout);

        if (this._mprisPlayer) {
            this._statusButtonManager(this._mprisPlayer.PlaybackStatus);
        }
    }

    _disablePlaybackIcons(layout) {
        this._deactivatePlaybackButtons(layout.slice(0, 5));
        this._disconnectPlaybackButtons(layout);
    }

    _deactivatePlaybackButtons(layout) {
        layout.forEach((key) => {
            this._controlButtons[key].set_reactive(false);
            this._controlButtons[key].add_style_pseudo_class('insensitive');
        });
    }

    _disconnectPlayerProperties() {
       if (this._playerPropertiesHandler !== null) { 
            this._mprisPlayer.disconnect(this._playerPropertiesHandler);
            this._playerPropertiesHandler = null;
        }
    }

    _disconnectPlaybackButtons(layout) {
        layout.forEach((key) => {
            if (this._controlButtonsHandlers[key] !== null) { 
                this._controlButtons[key].disconnect(this._controlButtonsHandlers[key]);
                this._controlButtonsHandlers[key] = null;
            }
        });
    }

    async _playPause(actor, event) {
        const middleClickResult = await this._handleMiddleClickSeek(event);
        if (middleClickResult === Clutter.EVENT_STOP) {
            return Clutter.EVENT_STOP;
        }

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

    _initSettings() {
        this._settings = this.getSettings();

        this._playbackButtonLayout = this._settings.get_string('playback-icons-layout');
        this._titleWidth = this._settings.get_uint('set-title-width');
        this._flexibility = this._settings.get_uint('indicator-flexibility');
        this._activePlayerName = this._settings.get_string('active-player-name');
        this._mprisPlayerSeekOffset = this._settings.get_uint('seek-offset');
        this._mprisPlayerSeek = this._settings.get_boolean('enable-seek');
        this._preferredVolume = this._settings.get_uint('preferred-volume');
        this._progressIndicatorWidth = this._settings.get_uint('progress-indicator-width');
        this._showProgressIndicator = this._settings.get_boolean('show-progress-indicator');

        this._soundSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.sound',
        });
        this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_VOLUME_KEY);

        if (!Object.keys(CONTROL_KEYS_LAYOUT).includes(this._playbackButtonLayout)) {
            this._playbackButtonLayout = 'Standard';
            this._settings.set_string('playback-icons-layout', this._playbackButtonLayout);
        }

        if (!Object.values(IndicatorFlexibility).includes(this._flexibility)) {
            this._flexibility = IndicatorFlexibility.adaptive;
            this._settings.set_uint('indicator-flexibility', this._flexibility);
        }
    }

    _initSignalConnects() {
        this._settings.connectObject(
            'changed::playback-icons-layout', (settings, key) => {
                this._playbackButtonLayout = settings.get_string(key);
                this._updatePlaybackButtons(this._playbackButtonLayout);
            },
            'changed::set-title-width', (settings, key) => {
                this._titleWidth = settings.get_uint(key);
                this._updateIndicatorFlexibility();
                this._settings.set_uint('get-title-width', this._trackLabel.clutter_text.get_width());
            },
            'changed::indicator-flexibility', (settings, key) => {
                this._flexibility = settings.get_uint(key);
                this._updateIndicatorFlexibility();
            },
            'changed::spacing', (settings, key) => {
                const spacing = settings.get_uint(key);
                this._indicatorBox.set_style(`spacing: ${spacing}px;`);
                this._controlBox.set_style(`spacing: ${spacing}px;`);
            },
            'changed::seek-offset', (settings, key) => {
                this._mprisPlayerSeekOffset = settings.get_uint(key);
            },
            'changed::enable-seek', (settings, key) => {
                this._mprisPlayerSeek = settings.get_boolean(key);
            },
            'changed::preferred-volume', (settings, key) => {
                this._preferredVolume = settings.get_uint(key);
            },
            'changed::progress-indicator-width', (settings, key) => {
                this._progressIndicatorWidth = settings.get_uint(key);
            },
            'changed::show-progress-indicator', (settings, key) => {
                this._showProgressIndicator = settings.get_boolean(key);
            },
            this
        );
        
        this._soundSettings.connectObject(
            `changed::${ALLOW_AMPLIFIED_VOLUME_KEY}`, () => {
                this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_VOLUME_KEY);
            },
            this
        );

        this._indicator.connectObject('button-press-event', this._onButtonPressed.bind(this), this);
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._settings = null;

        this._soundSettings?.disconnectObject(this);
        this._soundSettings = null;

        if (this._dbusProxyHandler !== null) {
            this._dbusProxy.disconnectSignal(this._dbusProxyHandler);
            this._dbusProxyHandler = null;
        }

        this._disconnectVolumeControl();
        this._disconnectPlaybackButtons(Object.keys(this._controlButtonsHandlers));
        this._disconnectSeekControlBox();
        this._disconnectPlayerProperties();

        this._mprisPlayerNames = null;

        this._indicator?.disconnectObject(this);
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

function buildLabel(current, total, totalWidth = 32) {
    const clampedWidth = Math.clamp(8, totalWidth, 80);

    const prefix = `${current}\u2005◔`;
    const suffix = `◕\u2005${total}`;

    const fillLength = Math.max(
        1,
        clampedWidth - prefix.length - suffix.length
    );

    return `${prefix}${'━'.repeat(fillLength)}${suffix}`;
}

function getVolumeIconIndex(stream, maxVolume) {
    if (!stream) {
        return null;
    }

    const volume = stream.volume;
    if (stream.is_muted || volume <= 0) {
        return 0;
    }

    return Math.clamp(Math.ceil(3 * volume / maxVolume), 1, AUDIO_VOLUME_ICONS.length - 1);
}
