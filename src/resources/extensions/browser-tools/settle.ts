/**
 * browser-tools — DOM settle logic
 *
 * Adaptive settling after browser actions. Polls for DOM quiet (mutation
 * counter stable, no pending critical requests, optional focus stability)
 * before returning control.
 */

import type { Frame, Page } from "playwright";
import type { AdaptiveSettleDetails, AdaptiveSettleOptions } from "./state.js";
import { getPendingCriticalRequests } from "./utils.js";

// ---------------------------------------------------------------------------
// Mutation counter (installed in-page via evaluate)
// ---------------------------------------------------------------------------

export async function ensureMutationCounter(p: Page): Promise<void> {
	await p.evaluate(() => {
		const key = "__piMutationCounter" as const;
		const installedKey = "__piMutationCounterInstalled" as const;
		const w = window as unknown as Record<string, unknown>;
		if (typeof w[key] !== "number") w[key] = 0;
		if (w[installedKey]) return;
		const observer = new MutationObserver(() => {
			const current = typeof w[key] === "number" ? (w[key] as number) : 0;
			w[key] = current + 1;
		});
		observer.observe(document.documentElement || document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		w[installedKey] = true;
	});
}

export async function readMutationCounter(p: Page): Promise<number> {
	try {
		return await p.evaluate(() => {
			const w = window as unknown as Record<string, unknown>;
			const value = w.__piMutationCounter;
			return typeof value === "number" ? value : 0;
		});
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Focus descriptor (for focus-stability checks)
// ---------------------------------------------------------------------------

export async function readFocusedDescriptor(target: Page | Frame): Promise<string> {
	try {
		return await target.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body || el === document.documentElement) return "";
			const id = el.id ? `#${el.id}` : "";
			const role = el.getAttribute("role") || "";
			const name = (el.getAttribute("aria-label") || el.getAttribute("name") || "").trim();
			return `${el.tagName.toLowerCase()}${id}|${role}|${name}`;
		});
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Adaptive settle
// ---------------------------------------------------------------------------

export async function settleAfterActionAdaptive(
	p: Page,
	opts: AdaptiveSettleOptions = {},
): Promise<AdaptiveSettleDetails> {
	const timeoutMs = Math.max(150, opts.timeoutMs ?? 500);
	const pollMs = Math.min(100, Math.max(20, opts.pollMs ?? 40));
	const quietWindowMs = Math.max(60, opts.quietWindowMs ?? 100);
	const checkFocus = opts.checkFocusStability ?? false;

	const startedAt = Date.now();
	let polls = 0;
	let sawUrlChange = false;
	let lastActivityAt = startedAt;
	let previousUrl = p.url();

	await ensureMutationCounter(p).catch(() => {});
	let previousMutationCount = await readMutationCounter(p);
	let previousFocus = checkFocus ? await readFocusedDescriptor(p) : "";

	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		polls += 1;
		const now = Date.now();

		const currentUrl = p.url();
		if (currentUrl !== previousUrl) {
			sawUrlChange = true;
			previousUrl = currentUrl;
			lastActivityAt = now;
		}

		const currentMutationCount = await readMutationCounter(p);
		if (currentMutationCount > previousMutationCount) {
			previousMutationCount = currentMutationCount;
			lastActivityAt = now;
		}

		if (checkFocus) {
			const currentFocus = await readFocusedDescriptor(p);
			if (currentFocus !== previousFocus) {
				previousFocus = currentFocus;
				lastActivityAt = now;
			}
		}

		const pendingCritical = getPendingCriticalRequests(p);
		if (pendingCritical > 0) {
			lastActivityAt = now;
			continue;
		}

		if (now - lastActivityAt >= quietWindowMs) {
			return {
				settleMode: "adaptive",
				settleMs: now - startedAt,
				settleReason: sawUrlChange ? "url_changed_then_quiet" : "dom_quiet",
				settlePolls: polls,
			};
		}
	}

	return {
		settleMode: "adaptive",
		settleMs: Date.now() - startedAt,
		settleReason: "timeout_fallback",
		settlePolls: polls,
	};
}
