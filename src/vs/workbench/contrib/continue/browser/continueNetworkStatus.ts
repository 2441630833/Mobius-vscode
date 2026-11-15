/*---------------------------------------------------------------------------------------------
 *  Mobius — Network connectivity detection and status monitoring
 *  Controls online gating for external web services like search_web.
 *--------------------------------------------------------------------------------------------*/

let testOnlineOverride: boolean | undefined = undefined;
let cachedOnlineStatus: boolean | undefined = undefined;
let lastProbeTime = 0;
const PROBE_CACHE_TTL_MS = 15000; // 15 seconds

/**
 * Fast synchronous check for network connectivity.
 * Returns false immediately if the browser or OS reports offline or reachability failed.
 */
export function isNetworkOnline(): boolean {
	if (testOnlineOverride !== undefined) {
		return testOnlineOverride;
	}
	if (cachedOnlineStatus !== undefined) {
		return cachedOnlineStatus;
	}
	// Note: We avoid checking `navigator.onLine === false` here because in Chromium/Electron on Linux,
	// navigator.onLine is notoriously false when NetworkManager is not present or unmanaged,
	// even when the host has full Internet connectivity. Optimistically assume online.
	return true;
}

/**
 * Asynchronous reachability probe with caching.
 * Resolves false if offline or unreachable, true if online.
 */
export async function checkNetworkOnline(forceProbe = false): Promise<boolean> {
	if (testOnlineOverride !== undefined) {
		return testOnlineOverride;
	}

	const now = Date.now();
	if (!forceProbe && cachedOnlineStatus !== undefined && (now - lastProbeTime < PROBE_CACHE_TTL_MS)) {
		return cachedOnlineStatus;
	}

	// In browser/renderer environment, probe Bing / connectivity endpoint
	if (typeof fetch === 'function') {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 3500);
		try {
			// Using mode: 'no-cors' allows receiving opaque response from search endpoint
			await fetch('https://cn.bing.com/favicon.ico', {
				method: 'HEAD',
				mode: 'no-cors',
				cache: 'no-store',
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			cachedOnlineStatus = true;
			lastProbeTime = Date.now();
			return true;
		} catch {
			clearTimeout(timeoutId);
			// Try secondary fallback probe
			try {
				const fallbackController = new AbortController();
				const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 3500);
				await fetch('https://www.bing.com/favicon.ico', {
					method: 'HEAD',
					mode: 'no-cors',
					cache: 'no-store',
					signal: fallbackController.signal,
				});
				clearTimeout(fallbackTimeoutId);
				cachedOnlineStatus = true;
				lastProbeTime = Date.now();
				return true;
			} catch {
				// If both probes failed, check navigator.onLine if true, otherwise cache false
				if (typeof navigator !== 'undefined' && navigator.onLine === true) {
					cachedOnlineStatus = true;
					lastProbeTime = Date.now();
					return true;
				}
				cachedOnlineStatus = false;
				lastProbeTime = Date.now();
				return false;
			}
		}
	}

	// Fallback: optimistic online
	const online = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
	cachedOnlineStatus = online;
	lastProbeTime = Date.now();
	return online;
}

/**
 * Record a detected network-level failure (e.g. DNS resolution error or connection refused).
 */
export function recordNetworkFailure(): void {
	cachedOnlineStatus = false;
	lastProbeTime = Date.now();
}

/**
 * Override network status for testing purposes.
 */
export function setNetworkOnlineForTesting(status: boolean | undefined): void {
	testOnlineOverride = status;
	if (status !== undefined) {
		cachedOnlineStatus = status;
		lastProbeTime = Date.now();
	} else {
		cachedOnlineStatus = undefined;
		lastProbeTime = 0;
	}
}

// Hook browser online/offline events when running in renderer/window
if (typeof window !== 'undefined') {
	window.addEventListener('offline', () => {
		// On Linux/Electron, 'offline' event can fire erroneously at startup.
		// Verify with reachability probe before marking offline.
		void checkNetworkOnline(true);
	});
	window.addEventListener('online', () => {
		cachedOnlineStatus = true;
		void checkNetworkOnline(true);
	});
}
