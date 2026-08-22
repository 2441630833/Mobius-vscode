/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { observableValue, derived, IObservable } from '../../base/common/observable.js';
import { isIOS, isMobile } from '../../base/common/platform.js';
import { isAndroid } from '../../base/browser/browser.js';
import { Gesture } from '../../base/browser/touch.js';

/** Viewport classification based on container width. */
export type ViewportClass = 'phone' | 'tablet' | 'desktop';

/** Default visibility for each workbench part. */
export interface IPartVisibilityDefaults {
	readonly sidebar: boolean;
	readonly auxiliaryBar: boolean;
	readonly panel: boolean;
	readonly sessions: boolean;
	readonly editor: boolean;
}

/** Default sizes (in pixels) for each workbench part. */
export interface IPartSizeDefaults {
	readonly sideBarSize: number;
	readonly auxiliaryBarSize: number;
	readonly panelSize: number;
	readonly sessionsWidth: number;
}

const PHONE_MAX_WIDTH = 640;
const TABLET_MAX_WIDTH = 1024;

/** Desktop sidebar width as a fraction of the workbench width. */
const DESKTOP_SIDEBAR_WIDTH_RATIO = 0.14;
/** Desktop auxiliary bar width as a fraction of the workbench width. */
const DESKTOP_AUXBAR_WIDTH_RATIO = 0.16;
const DESKTOP_MIN_SIDEBAR_WIDTH = 220;
const DESKTOP_MAX_SIDEBAR_WIDTH = 280;
const DESKTOP_MIN_AUXBAR_WIDTH = 240;
const DESKTOP_MAX_AUXBAR_WIDTH = 300;
const DESKTOP_MIN_SESSIONS_WIDTH = 480;
/** Hard cap on how much horizontal space saved sizes may take from each side column. */
const DESKTOP_MAX_SAVED_SIDE_RATIO = 0.18;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function computeDesktopPartSizes(width: number): IPartSizeDefaults {
	const sideBarSize = clamp(
		Math.round(width * DESKTOP_SIDEBAR_WIDTH_RATIO),
		DESKTOP_MIN_SIDEBAR_WIDTH,
		DESKTOP_MAX_SIDEBAR_WIDTH,
	);
	const auxiliaryBarSize = clamp(
		Math.round(width * DESKTOP_AUXBAR_WIDTH_RATIO),
		DESKTOP_MIN_AUXBAR_WIDTH,
		DESKTOP_MAX_AUXBAR_WIDTH,
	);
	const sessionsWidth = Math.max(DESKTOP_MIN_SESSIONS_WIDTH, width - sideBarSize - auxiliaryBarSize);

	return {
		sideBarSize,
		auxiliaryBarSize,
		panelSize: 300,
		sessionsWidth,
	};
}

/**
 * Whether the current platform is a phone/tablet OS. The phone layout is
 * only applied on actual mobile devices so that resizing a desktop window
 * below 640px does not switch the agents workbench into phone mode.
 */
const isMobilePlatform = isMobile;

/**
 * Classifies the viewport into one of three classes based on width.
 * Phone and tablet classifications are gated on a mobile OS; desktop
 * browsers and Electron always report `desktop` regardless of width.
 */
function classifyViewport(width: number): ViewportClass {
	if (!isMobilePlatform) {
		return 'desktop';
	}
	if (width < PHONE_MAX_WIDTH) {
		return 'phone';
	}
	if (width < TABLET_MAX_WIDTH) {
		return 'tablet';
	}
	return 'desktop';
}

/**
 * Observable-based viewport classification and layout policy for
 * the Sessions workbench. Consumed by `SessionsWorkbench` to drive
 * part visibility, sizing, and behavior based on viewport dimensions
 * and platform.
 */
export class SessionsLayoutPolicy extends Disposable {

	// --- Platform flags (static, read once) ---

	/** Whether the current platform is iOS. */
	readonly isIOS: boolean;

	/** Whether the current platform is Android. */
	readonly isAndroid: boolean;

	/** Whether the current device supports touch input. */
	readonly isTouchDevice: boolean;

	// --- Observables ---

	private readonly _viewportClass = observableValue<ViewportClass>(this, 'desktop');

	/** Current viewport class derived from the most recent `update()` call. */
	readonly viewportClass: IObservable<ViewportClass> = this._viewportClass;

	/** `true` when the viewport class is `phone`. */
	readonly isPhoneLayout: IObservable<boolean> = derived(this, reader => {
		return this._viewportClass.read(reader) === 'phone';
	});

	constructor() {
		super();

		this.isIOS = isIOS;
		this.isAndroid = isAndroid;
		this.isTouchDevice = Gesture.isTouchDevice();
	}

	/**
	 * Update the viewport classification. Call this from the workbench
	 * `layout()` method whenever the container dimensions change.
	 *
	 * @param width  Container width in pixels.
	 * @param height Container height in pixels (reserved for future use).
	 */
	update(width: number, _height: number): void {
		const next = classifyViewport(width);
		if (this._viewportClass.get() !== next) {
			this._viewportClass.set(next, undefined);
		}
	}

	/**
	 * Returns the default part visibility for the given viewport class.
	 * If no class is supplied the current observed class is used.
	 */
	getPartVisibilityDefaults(viewportClass?: ViewportClass): IPartVisibilityDefaults {
		const vc = viewportClass ?? this._viewportClass.get();
		switch (vc) {
			case 'phone':
				return { sidebar: false, auxiliaryBar: false, panel: false, sessions: true, editor: false };
			case 'tablet':
			case 'desktop':
				// Tablet and desktop share the standard multi-part workbench defaults.
				// A dedicated tablet layout has not been designed yet.
				return { sidebar: true, auxiliaryBar: true, panel: false, sessions: true, editor: false };
		}
	}

	/**
	 * Returns the default part sizes for the given viewport dimensions.
	 * If no viewport class is supplied the current observed class is used.
	 *
	 * @param width  Container width in pixels.
	 * @param height Container height in pixels (reserved for future use).
	 * @param viewportClass Optional explicit viewport class override.
	 */
	getPartSizes(width: number, _height: number, viewportClass?: ViewportClass): IPartSizeDefaults {
		const vc = viewportClass ?? this._viewportClass.get();
		switch (vc) {
			case 'phone':
				return {
					sideBarSize: 0,
					auxiliaryBarSize: 0,
					panelSize: 0,
					sessionsWidth: width,
				};
			case 'tablet':
			case 'desktop':
				// Tablet currently falls back to desktop sizing.
				return computeDesktopPartSizes(width);
		}
	}

	/**
	 * Prefer a saved part width when present, but clamp it so side columns
	 * cannot crowd out the primary sessions/chat column on wide layouts.
	 */
	resolveSavedHorizontalPartWidth(
		saved: number | undefined,
		policyDefault: number,
		totalWidth: number,
		limits: { readonly min: number; readonly maxRatio: number },
	): number {
		const maxWidth = Math.round(totalWidth * limits.maxRatio);
		const value = saved ?? policyDefault;
		return clamp(value, limits.min, maxWidth);
	}

	getDesktopSideColumnLimits(): { readonly sidebar: { readonly min: number; readonly maxRatio: number }; readonly auxiliaryBar: { readonly min: number; readonly maxRatio: number } } {
		return {
			sidebar: { min: DESKTOP_MIN_SIDEBAR_WIDTH, maxRatio: DESKTOP_MAX_SAVED_SIDE_RATIO },
			auxiliaryBar: { min: DESKTOP_MIN_AUXBAR_WIDTH, maxRatio: DESKTOP_MAX_SAVED_SIDE_RATIO },
		};
	}

	getDesktopMinSessionsWidth(totalWidth: number): number {
		return Math.max(DESKTOP_MIN_SESSIONS_WIDTH, Math.round(totalWidth * 0.55));
	}
}
