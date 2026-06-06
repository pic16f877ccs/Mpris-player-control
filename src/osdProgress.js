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

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HIDE_TIMEOUT = 1500;
const FADE_TIME = 100;
export const LEVEL_ANIMATION_TIME = 100;
const MAX_US = Number.MAX_SAFE_INTEGER;

export const ProgressBarLevel = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.double(
            'value',
            null,
            null,
            GObject.ParamFlags.READWRITE,
            0,
            MAX_US,
            0
        ),
        'maximum-value': GObject.ParamSpec.double(
            'maximum-value',
            null,
            null,
            GObject.ParamFlags.READWRITE,
            1,
            MAX_US,
            1
        ),
    },
}, class ProgressBarLevel extends St.DrawingArea {
    _init(params = {}) {
        this._maxValue = 1;
        this._value = 0;
        this._barLevelWidth = 0;
        this._barLevelHeight = 0;
        this._barLevelColor = null;
        this._barLevelActiveColor = null;

        super._init({
            style_class: 'level',
            accessible_role: Atk.Role.LEVEL_BAR,
            ...params,
        });

        this.connect('notify::allocation', () => {
            this._barLevelWidth = this.allocation.get_width();
        });

        this._customAccessible = St.GenericAccessible.new_for_actor(this);
        this.set_accessible(this._customAccessible);

        this._customAccessible.connect('get-current-value', () => this._value);
        this._customAccessible.connect('get-minimum-value', () => 0);
        this._customAccessible.connect('get-maximum-value', () => this._maxValue);
        this._customAccessible.connect('set-current-value', (_actor, value) => {
            this.value = value;
        });

        this.connect('notify::value', () => {
            this._customAccessible.notify('accessible-value');
        });
    }

    get value() {
        return this._value;
    }

    set value(value) {
        value = Math.max(Math.min(value, this._maxValue), 0);

        if (this._value === value)
            return;

        this._value = value;
        this.notify('value');
        this.queue_repaint();
    }

    get maximumValue() {
        return this._maxValue;
    }

    set maximumValue(value) {
        value = Math.max(value, 1);

        if (this._maxValue === value)
            return;

        this._maxValue = value;
        this.notify('maximum-value');
        this.queue_repaint();
    }

    vfunc_style_changed() {
        const themeNode = this.get_theme_node();
        this._barLevelHeight = themeNode.get_length('-barlevel-height');
        this._barLevelColor = themeNode.get_color('-barlevel-background-color');
        this._barLevelActiveColor =
            themeNode.get_color('-barlevel-active-background-color');

        super.vfunc_style_changed();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const themeNode = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;

        const radius = Math.min(width, this._barLevelHeight) / 2;
        const TAU = Math.PI * 2;

        let progress = 0;
        if (this._maxValue > 0)
            progress = this._value / this._maxValue;

        if (rtl)
            progress = 1 - progress;

        const endX = radius + (width - 2 * radius) * progress;

        let startArcX = radius;
        let endArcX = width - radius;
        if (rtl)
            [startArcX, endArcX] = [endArcX, startArcX];

        if (!rtl)
            cr.arc(endArcX, height / 2, radius, TAU * (3 / 4), TAU * (1 / 4));
        else
            cr.arcNegative(endArcX, height / 2, radius, TAU * (3 / 4), TAU * (1 / 4));

        cr.lineTo(endX, (height + this._barLevelHeight) / 2);
        cr.lineTo(endX, (height - this._barLevelHeight) / 2);
        cr.lineTo(endArcX, (height - this._barLevelHeight) / 2);
        cr.setSourceColor(this._barLevelColor);
        cr.fill();

        if (this._value > 0) {
            if (!rtl)
                cr.arc(startArcX, height / 2, radius, TAU * (1 / 4), TAU * (3 / 4));
            else
                cr.arcNegative(startArcX, height / 2, radius, TAU * (1 / 4), TAU * (3 / 4));

            cr.lineTo(endX, (height - this._barLevelHeight) / 2);
            cr.lineTo(endX, (height + this._barLevelHeight) / 2);
            cr.lineTo(startArcX, (height + this._barLevelHeight) / 2);
            cr.setSourceColor(this._barLevelActiveColor);
            cr.fill();

            if (!rtl) {
                cr.arc(endX, height / 2, radius, TAU * (3 / 4), TAU * (1 / 4));
                cr.lineTo(Math.floor(endX), (height + this._barLevelHeight) / 2);
                cr.lineTo(Math.floor(endX), (height - this._barLevelHeight) / 2);
            } else {
                cr.arcNegative(endX, height / 2, radius, TAU * (3 / 4), TAU * (1 / 4));
                cr.lineTo(Math.ceil(endX), (height + this._barLevelHeight) / 2);
                cr.lineTo(Math.ceil(endX), (height - this._barLevelHeight) / 2);
            }

            cr.lineTo(endX, (height - this._barLevelHeight) / 2);
            cr.setSourceColor(this._barLevelActiveColor);
            cr.fill();
        }

        cr.$dispose();
    }

    vfunc_get_preferred_height(_forWidth) {
        const themeNode = this.get_theme_node();
        const height = this._barLevelHeight;
        return themeNode.adjust_preferred_height(height, height);
    }

    vfunc_get_preferred_width(_forHeight) {
        const themeNode = this.get_theme_node();
        const width = 100;
        return themeNode.adjust_preferred_width(width, width);
    }
});

export const OsdProgressWindow = GObject.registerClass(
class OsdProgressWindow extends Clutter.Actor {
    _init(monitorIndex) {
        super._init({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });

        this._monitorIndex = monitorIndex;
        const constraint = new Layout.MonitorConstraint({index: monitorIndex});
        this.add_constraint(constraint);

        this._hbox = new St.BoxLayout({
            style_class: 'osd-window',
        });
        this.add_child(this._hbox);

        this._vbox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hbox.add_child(this._vbox);

        this._label = new St.Label();
        this._vbox.add_child(this._label);

        this._level = new ProgressBarLevel({
            style_class: 'level',
            value: 0,
        });
        this._vbox.add_child(this._level);

        this._hideTimeoutId = 0;
        this._reset();

        Main.uiGroup.add_child(this);
    }

    _updateBoxVisibility() {
        this._vbox.visible = [...this._vbox].some(child => child.visible);
    }

    setLabel(label) {
        this._label.visible = label != null;
        if (this._label.visible)
            this._label.text = label;
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
        this.setLabel(null);
        this.setMaxLevel(1);
        this.setLevel(null);
    }
});
