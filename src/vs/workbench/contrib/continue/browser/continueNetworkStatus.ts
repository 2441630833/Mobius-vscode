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
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		return false;
	}
	if (cachedOnlineStatus !== undefined) {
		return cachedOnlineStatus;
	}
	return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
}

/**
 * Asynchronous reachability probe with caching.
 * Resolves false if offline or unreachable, true if online.
 */
export async function checkNetworkOnline(forceProbe = false): Promise<boolean> {
	if (testOnlineOverride !== undefined) {
		return testOnlineOverride;
	}
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		cachedOnlineStatus = false;
		return false;
	}

	const now = Date.now();
	if (!forceProbe && cachedOnlineStatus !== undefined && (now - lastProbeTime < PROBE_CACHE_TTL_MS)) {
		return cachedOnlineStatus;
	}

	// In browser/renderer environment, probe Bing / connectivity endpoint
	if (typeof fetch === 'function') {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 1200);
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
				const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 1200);
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
				cachedOnlineStatus = false;
				lastProbeTime = Date.now();
				return false;
			}
		}
	}

	// Fallback to navigator.onLine
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
		cachedOnlineStatus = false;
		lastProbeTime = Date.now();
	});
	window.addEventListener('online', () => {
		cachedOnlineStatus = true;
		void checkNetworkOnline(true);
	});
}
