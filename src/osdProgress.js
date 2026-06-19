/*
 * Adapted from GNOME Shell js/ui/osdWindow.js and related bar level code.
 * Modifications:
 * - removed icon handling
 * - changed progress semantics to use microseconds
 *
 * Copyright (C) 2026 Karl Wulfert
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HIDE_TIMEOUT = 1500;
const FADE_TIME = 100;
export const LEVEL_ANIMATION_TIME = 100;
export const ProgressBarLevel = BarLevel.BarLevel;

export const OsdProgressWindow = GObject.registerClass(
class OsdProgressWindow extends Clutter.Actor {
    _init(monitorIndex, osdWindowWidth) {
        super._init({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });

        this._osdWindowWidth = osdWindowWidth;
        this._monitorIndex = monitorIndex;
        const constraint = new Layout.MonitorConstraint({index: monitorIndex});
        this.add_constraint(constraint);

        this._hbox = new St.BoxLayout({
            style_class: 'osd-window',
        });
        this.add_child(this._hbox);

        this._vbox = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hbox.add_child(this._vbox);

        this._leftLabel = new St.Label();
        this._rightLabel = new St.Label();
        this._rightLabelWidth = 0;

        this._level = new ProgressBarLevel({
            style_class: 'level',
            value: 0,
        });
        this._level.set_style('margin-bottom: 0px;');
        this._level.set_width(this._osdWindowWidth);

        this._vbox.add_child(this._leftLabel);
        this._vbox.add_child(this._level);
        this._vbox.add_child(this._rightLabel);

        this._hideTimeoutId = 0;
        this._reset();

        Main.uiGroup.add_child(this);
    }

    _updateBoxVisibility() {
        this._vbox.visible = [...this._vbox].some(child => child.visible);

        this._vbox.queue_relayout();
        this._hbox.queue_relayout();
    }

    setLeftLabel(label) {
        this._leftLabel.visible = label != null;
        if (this._leftLabel.visible)
            this._leftLabel.text = label;
        this._updateBoxVisibility();
    }

    setRightLabel(label) {
        this._rightLabel.visible = label != null;
        if (this._rightLabel.visible) {
            this._rightLabel.text = label;

            if (this._rightLabelWidth !== this._rightLabel.get_width()) {
                this._rightLabelWidth = this._rightLabel.get_width();
                this._leftLabel.set_width(this._rightLabelWidth);
            }
        }

        this._updateBoxVisibility();
    }

    setLevel(value) {
        this._level.visible = value != null;
        if (this._level.visible) {
            if (this.visible) {
                this._level.ease_property('value', value, {
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    duration: LEVEL_ANIMATION_TIME,
                });
            } else {
                this._level.value = value;
            }
        }
        this._updateBoxVisibility();
    }

    setMaxLevel(maxLevel = 1) {
        this._level.maximumValue = maxLevel ?? 1;
    }

    show() {
        if (!this.visible) {
            global.compositor.disable_unredirect();
            super.show();
            this.opacity = 0;
            this.get_parent().set_child_above_sibling(this, null);

            this.ease({
                opacity: 255,
                duration: FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (this._hideTimeoutId)
            GLib.source_remove(this._hideTimeoutId);

        this._hideTimeoutId = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT,
            HIDE_TIMEOUT,
            this._hide.bind(this)
        );
        GLib.Source.set_name_by_id(this._hideTimeoutId, '[gnome-shell] this._hide');
    }

    cancel() {
        if (!this._hideTimeoutId)
            return;

        GLib.source_remove(this._hideTimeoutId);
        this._hide();
    }

    _hide() {
        this._hideTimeoutId = 0;
        this.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._reset();
                global.compositor.enable_unredirect();
            },
        });
    }

    _reset() {
        super.hide();
        this.setLeftLabel(null);
        this.setRightLabel(null);
        this.setMaxLevel(1);
        this.setLevel(null);
    }
});
